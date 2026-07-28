'use strict';

// Headless end-to-end integration test for Category Clash. Spins up an
// in-process server, connects a host + 3 player sockets, and drives a full
// 2-round game with SCRIPTED answers to force known outcomes (unique scoring,
// duplicate suppression, letter rejection, host-marked invalids), asserting
// the broadcast payloads at each step. Also exercises reconnection.
//
//   node scripts/itest-catclash.js   (or: npm run itest:catclash)

// Keep grouping deterministic (no Groq) regardless of the caller's env.
delete process.env.GROQ_API_KEY;

const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountCatClash = require('../server/catclash');

const app = express();
const server = http.createServer(app);
mountCatClash(app, server, { getPublicBaseUrl: () => 'http://localhost' });

const ROUNDS = 2;
const TIME_LIMIT = 30;
const CATS = 12;

let failed = false;
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed = true; console.log('  ✗ ' + msg); }
}

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/catclash';
    const s = Client(url, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
  });
}
function emitAck(sock, ev, payload) {
  return new Promise((resolve) => sock.emit(ev, payload, resolve));
}

/**
 * Buffer the named events from the moment we connect, so a broadcast that
 * lands while the test is busy asserting isn't missed (state:review in
 * particular is emitted the microtask after state:reviewing).
 */
function listen(sock, events) {
  const queued = {};
  const waiting = {};
  for (const ev of events) {
    queued[ev] = [];
    waiting[ev] = [];
    sock.on(ev, (p) => {
      const w = waiting[ev].shift();
      if (w) w(p); else queued[ev].push(p);
    });
  }
  return function next(ev, timeoutMs) {
    if (queued[ev].length) return Promise.resolve(queued[ev].shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for ' + ev)), timeoutMs || 15000);
      waiting[ev].push((p) => { clearTimeout(timer); resolve(p); });
    });
  };
}

/**
 * Answers for one round, per player letter. Each player uses a deliberately
 * distant base word so the fuzzy pass only merges what we want it to.
 *  cat 0  → A & B write the same word (duplicate, nobody scores), C unique
 *  cat 1  → A writes a word with the WRONG starting letter (auto-invalid)
 *  cat 2  → A uses the "The <letter>…" exception (must be accepted)
 *  cat 3  → B leaves it blank
 *  cat 4  → A & B differ only by a typo (fuzzy merge → duplicate)
 *  cat 5+ → everyone unique
 */
const BASE = { A: 'aardvark', B: 'mountain', C: 'zeppelin' };
function scriptFor(letter, who) {
  const L = letter.toLowerCase();
  const mine = (i) => L + BASE[who] + i;
  const a = new Array(CATS).fill('');
  a[0] = (who === 'C') ? mine(0) : L + 'sameword';
  a[1] = (who === 'A') ? 'qqzzz' : mine(1);
  a[2] = (who === 'A') ? ('The ' + mine(2)) : mine(2);
  a[3] = (who === 'B') ? '' : mine(3);
  a[4] = (who === 'A') ? L + 'banana' : (who === 'B' ? L + 'bananna' : mine(4));
  for (let i = 5; i < CATS; i++) a[i] = mine(i);
  return a;
}

(async () => {
  await new Promise((r) => server.listen(0, r));

  // ---- Host ----
  const host = await connect();
  const nextHost = listen(host, [
    'state:lobby', 'state:intro', 'state:round', 'state:reviewing',
    'state:review', 'state:reveal', 'state:final',
  ]);
  const auth = await emitAck(host, 'host:auth', {});
  check(auth && auth.ok, 'host authenticated');
  check(auth.categoriesPerRound === CATS, 'server reports 12 categories per round');
  check(auth.aiEnabled === false, 'AI disabled for a deterministic run');

  // ---- Players ----
  const letters = ['A', 'B', 'C'];
  const players = {};
  for (const L of letters) {
    const s = await connect();
    const pid = 'pid_' + L;
    players[L] = { socket: s, pid, name: L };
    const ack = await emitAck(s, 'player:join', { playerId: pid, name: L });
    if (!ack || !ack.ok) throw new Error('join ' + L + ' failed: ' + JSON.stringify(ack));
    players[L].nextResult = listen(s, ['player:result']);
  }
  check(true, '3 players joined');

  const dupe = await connect();
  const dupeAck = await emitAck(dupe, 'player:join', { playerId: 'pid_DUPE', name: 'a' });
  check(dupeAck && !dupeAck.ok && dupeAck.reason === 'name-taken', 'duplicate names are refused');
  dupe.close();

  // ---- Start ----
  const startAck = await emitAck(host, 'host:start', { rounds: ROUNDS, timeLimitSec: TIME_LIMIT });
  check(startAck && startAck.ok, 'game started');
  const intro1 = await nextHost('state:intro');
  check(intro1.totalRounds === ROUNDS, 'intro reports ' + ROUNDS + ' rounds');
  check(typeof intro1.letter === 'string' && intro1.letter.length === 1, 'a letter was drawn: ' + intro1.letter);

  const lateJoin = await connect();
  const lateAck = await emitAck(lateJoin, 'player:join', { playerId: 'pid_LATE', name: 'Late' });
  check(lateAck && !lateAck.ok && lateAck.reason === 'lobby-closed', 'late joiners are refused');
  lateJoin.close();

  const seenLetters = [];

  for (let round = 1; round <= ROUNDS; round++) {
    const roundState = await nextHost('state:round', 20000);
    check(roundState.round === round, 'round ' + round + ' writing phase opened');
    check(roundState.categories.length === CATS, 'round ' + round + ' has 12 categories');
    seenLetters.push(roundState.letter);

    // Every player fills in their scripted answers field by field.
    const scripts = {};
    for (const L of letters) {
      scripts[L] = scriptFor(roundState.letter, L);
      for (let i = 0; i < CATS; i++) {
        if (!scripts[L][i]) continue;
        await emitAck(players[L].socket, 'player:answer', { catIdx: i, text: scripts[L][i] });
      }
    }

    // Mid-round reconnect: a player must get their own answers back.
    if (round === 1) {
      const re = await emitAck(players.A.socket, 'player:reconnect', { playerId: players.A.pid });
      check(re.ok && re.phase === 'ROUND', 'mid-round reconnect returns ROUND');
      check(Array.isArray(re.myAnswers) && re.myAnswers[0] === scripts.A[0],
        'mid-round reconnect restores saved answers');
    }

    // Everyone marks done → the round should end early.
    for (const L of letters) await emitAck(players[L].socket, 'player:done', { done: true });
    const reviewing = await nextHost('state:reviewing');
    check(reviewing.round === round, 'all-done ended round ' + round + ' early');

    // Walk all 12 categories on the host.
    let hostInvalidatedOnce = false;
    let allScored = true;
    for (let c = 0; c < CATS; c++) {
      const rev = await nextHost('state:review');
      check(rev.catIdx === c, 'review payload for category ' + (c + 1));

      if (c === 0 && round === 1) {
        const total = rev.buckets.reduce((n, b) => n + b.members.length, 0) + rev.invalid.length;
        check(total === 3, 'every non-blank answer appears exactly once in the review payload');
        check(rev.buckets.some((b) => b.members.length === 2), 'identical answers auto-grouped into one bucket');
      }
      if (c === 1 && round === 1) {
        const bad = rev.invalid.find((m) => m.playerId === players.A.pid);
        check(!!bad && bad.reason === 'letter', 'wrong-letter answer auto-flagged as invalid');
      }
      if (c === 2 && round === 1) {
        check(rev.buckets.some((b) => b.members.some((m) => m.playerId === players.A.pid)),
          '"The <letter>…" is accepted by the letter check');
      }
      if (c === 3 && round === 1) {
        check(rev.blanks.some((b) => b.playerId === players.B.pid), 'blank answers are reported separately');
        check(!rev.buckets.some((b) => b.members.some((m) => m.playerId === players.B.pid)),
          'blank answers stay out of the buckets');
      }
      if (c === 4 && round === 1) {
        check(rev.buckets.some((b) => b.members.length === 2),
          'near-identical typo answers fuzzy-merged into one bucket');
      }

      // Host confirms the buckets verbatim, except on category 6 of round 1
      // where they manually reject player C's answer.
      let buckets = rev.buckets.map((b) => ({
        id: b.id, label: b.label, members: b.members.map((m) => ({ playerId: m.playerId })),
      }));
      const invalid = rev.invalid.map((m) => m.playerId);
      if (c === 5 && round === 1) {
        buckets = buckets
          .map((b) => ({ id: b.id, label: b.label, members: b.members.filter((m) => m.playerId !== players.C.pid) }))
          .filter((b) => b.members.length > 0);
        if (!invalid.includes(players.C.pid)) invalid.push(players.C.pid);
        hostInvalidatedOnce = true;
      }
      const scoreAck = await emitAck(host, 'host:scoreCategory', { catIdx: c, buckets, invalid });
      if (!scoreAck || !scoreAck.ok) allScored = false;
    }
    check(allScored, 'all 12 categories scored in round ' + round);
    check(hostInvalidatedOnce || round > 1, 'host manually rejected an answer in round 1');

    const reveal = await nextHost('state:reveal');
    check(reveal.round === round, 'round ' + round + ' reveal arrived');
    check(reveal.board.length === 3, 'reveal scoreboard lists every player');
    check(reveal.isLastRound === (round === ROUNDS), 'reveal flags the last round correctly');

    if (round === 1) {
      const by = {};
      for (const row of reveal.board) by[row.name] = row;
      // cat 0: A&B duplicate, C unique               → C +1
      // cat 1: A invalid (letter), B & C unique      → B,C +1
      // cat 2: all three unique                      → A,B,C +1
      // cat 3: B blank, A & C unique                 → A,C +1
      // cat 4: A&B fuzzy-merged duplicate, C unique  → C +1
      // cat 5: C host-rejected, A & B unique         → A,B +1
      // cat 6-11: all unique                         → A,B,C +6
      check(by.A.roundPoints === 9, 'A scored the expected 9 points in round 1 (got ' + by.A.roundPoints + ')');
      check(by.B.roundPoints === 9, 'B scored the expected 9 points in round 1 (got ' + by.B.roundPoints + ')');
      check(by.C.roundPoints === 11, 'C scored the expected 11 points in round 1 (got ' + by.C.roundPoints + ')');

      const resA = await players.A.nextResult('player:result');
      const resB = await players.B.nextResult('player:result');
      const resC = await players.C.nextResult('player:result');
      check(resC && resC.breakdown.length === CATS, 'player gets a per-category breakdown');
      check(resC.breakdown[3].status === 'scored', 'unique answer marked scored on the phone');
      check(resC.breakdown[5].status === 'invalid', 'host-rejected answer marked invalid on the phone');
      check(resA.breakdown[0].status === 'duplicate', 'duplicate answer marked duplicate on the phone');
      check(resA.breakdown[1].status === 'invalid', 'wrong-letter answer marked invalid on the phone');
      check(resB.breakdown[3].status === 'blank', 'blank answer marked blank on the phone');
      check(resC.roundPoints === 11 && resC.totalScore === 11, 'player result mirrors the host scoreboard');

      // Host reconnect mid-reveal must land back on the reveal screen.
      const re = await emitAck(host, 'host:auth', {});
      check(re.ok && re.phase === 'REVEAL', 'host reconnect during REVEAL returns the right phase');
      await nextHost('state:reveal'); // drain the replayed snapshot
    }

    if (round < ROUNDS) {
      await emitAck(host, 'host:next', {});
      const intro = await nextHost('state:intro');
      check(intro.round === round + 1, 'advanced to round ' + (round + 1));
    }
  }

  // ---- Final ----
  await emitAck(host, 'host:next', {});
  const fin = await nextHost('state:final');
  check(fin.fullLeaderboard.length === 3, 'final leaderboard lists every player');
  check(fin.winnerName === 'C', 'C wins with the most unique answers');
  check(fin.podiumGroups.length > 0 && fin.podiumGroups[0].rank === 1, 'podium groups start at rank 1');

  check(new Set(seenLetters).size === seenLetters.length,
    'no letter repeated across rounds (' + seenLetters.join(', ') + ')');

  // ---- Reset ----
  await emitAck(host, 'host:reset', {});
  const lobby = await nextHost('state:lobby');
  check(lobby.phase === 'LOBBY', 'reset returns the game to the lobby');

  // ---- Teardown ----
  host.close();
  for (const L of letters) players[L].socket.close();
  await new Promise((r) => server.close(r));

  console.log(failed ? '\nFAILED' : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
