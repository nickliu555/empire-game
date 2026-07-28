'use strict';

// Headless end-to-end integration test for Rank Five. Spins up an in-process
// server, connects a host + 3 player sockets, and drives a full co-op game,
// asserting role assignment (each player ranker once + submitter once, never
// both in a round), the live scoring (matches → group, misses → game), and the
// final win/lose tally.
//
//   node scripts/itest-rankfive.js   (or: npm run itest:rankfive)

const assert = require('assert');
const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountRankFive = require('../server/rankfive');

const app = express();
const server = http.createServer(app);
mountRankFive(app, server, { getPublicBaseUrl: () => 'http://localhost' });

let failed = false;
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed = true; console.log('  ✗ ' + msg); }
}

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/rankfive';
    const s = Client(url, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
  });
}

// A buffered event waiter so no broadcast is missed between awaits.
function makeQueue(socket, event) {
  const q = [];
  const waiters = [];
  socket.on(event, (p) => { if (waiters.length) waiters.shift()(p); else q.push(p); });
  return () => (q.length ? Promise.resolve(q.shift()) : new Promise((r) => waiters.push(r)));
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload || {}, resolve));
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  console.log('Rank Five itest on port', server.address().port);

  const host = await connect();
  await emitAck(host, 'host:auth', {});

  const NAMES = ['Alice', 'Bob', 'Cara'];
  const N = NAMES.length;
  const byId = {};       // playerId -> socket
  const nameById = {};
  const rankItemsQ = {}; // playerId -> queue for you:rankItems

  for (let i = 0; i < N; i++) {
    const s = await connect();
    const pid = 'pid-' + i;
    const res = await emitAck(s, 'player:join', { playerId: pid, name: NAMES[i] });
    check(res && res.ok, 'player ' + NAMES[i] + ' joined');
    byId[pid] = s;
    nameById[pid] = NAMES[i];
    rankItemsQ[pid] = makeQueue(s, 'you:rankItems');
  }

  // Reset now clears the whole lobby, so players must rejoin before a restart.
  async function rejoinAll() {
    for (const pid of Object.keys(byId)) {
      await emitAck(byId[pid], 'player:join', { playerId: pid, name: nameById[pid] });
    }
  }

  // Queues on the host for the phase broadcasts we drive against.
  const hostRank = makeQueue(host, 'state:rank');
  const hostDiscuss = makeQueue(host, 'state:discuss');
  const hostRevealTrans = makeQueue(host, 'state:revealTransition');
  const hostReveal = makeQueue(host, 'state:reveal');
  const hostFinal = makeQueue(host, 'state:final');

  // Classic mode: turn Custom Words OFF so start goes straight into the game.
  const cwOff = await emitAck(host, 'host:setCustomWords', { on: false });
  check(cwOff && cwOff.ok && cwOff.customWords === false, 'custom words toggled off');

  const startRes = await emitAck(host, 'host:start', {});
  check(startRes && startRes.ok, 'host started the game');

  const rankerSeen = {};
  const submitterSeen = {};
  let runningGroup = 0;
  let runningGame = 0;

  for (let r = 1; r <= N; r++) {
    const rank = await hostRank();
    check(rank.round === r, 'round ' + r + ' rank broadcast (round=' + rank.round + ')');
    const rankerId = rank.rankerId;
    rankerSeen[rankerId] = (rankerSeen[rankerId] || 0) + 1;

    // The ranker privately receives the 5 items; lock in a known secret order.
    const itemsMsg = await rankItemsQ[rankerId]();
    const R = itemsMsg.items.map((it) => it.id);
    check(R.length === 5, 'ranker got 5 items');
    const uniqueTexts = new Set(itemsMsg.items.map((it) => it.text));
    check(uniqueTexts.size === 5, 'the 5 items are distinct');
    await emitAck(byId[rankerId], 'player:rank', { order: R });

    const discuss = await hostDiscuss();
    check(discuss.submitterId !== rankerId, 'submitter is NOT the ranker (round ' + r + ')');
    submitterSeen[discuss.submitterId] = (submitterSeen[discuss.submitterId] || 0) + 1;

    // Submitter's guess: identity on odd rounds (5/5), swap the top two on even.
    const sub = R.slice();
    if (r % 2 === 0) { const t = sub[0]; sub[0] = sub[1]; sub[1] = t; }
    const expected = sub.reduce((a, v, i) => a + (v === R[i] ? 1 : 0), 0);

    // A live consensus nudge should mirror to the host before the final submit.
    await emitAck(byId[discuss.submitterId], 'player:consensus', { order: sub });
    await emitAck(byId[discuss.submitterId], 'player:submit', { order: sub });

    // Submit shows a shared transition first; results unlock a beat later.
    const trans = await hostRevealTrans();
    check(trans && trans.round === r, 'round ' + r + ' reveal transition first (round=' + (trans && trans.round) + ')');
    const reveal = await hostReveal();
    check(reveal.groupPts === expected, 'round ' + r + ' group +' + reveal.groupPts + ' (expected ' + expected + ')');
    check(reveal.gamePts === 5 - expected, 'round ' + r + ' game +' + reveal.gamePts);
    runningGroup += expected;
    runningGame += 5 - expected;
    check(reveal.groupScore === runningGroup, 'running group total = ' + runningGroup);
    check(reveal.gameScore === runningGame, 'running game total = ' + runningGame);

    await emitAck(host, 'host:next', {});
  }

  const final = await hostFinal();
  check(final.groupScore === runningGroup && final.gameScore === runningGame, 'final tally matches running totals');
  check(final.playersWin === (runningGroup >= runningGame), 'playersWin reflects group >= game');
  check(final.recap.length === N, 'recap has one row per round');

  const eachRankerOnce = Object.keys(rankerSeen).length === N && Object.values(rankerSeen).every((c) => c === 1);
  const eachSubmitterOnce = Object.keys(submitterSeen).length === N && Object.values(submitterSeen).every((c) => c === 1);
  check(eachRankerOnce, 'every player was ranker exactly once');
  check(eachSubmitterOnce, 'every player was submitter exactly once');

  // ---- Reset clears the lobby ----
  const reconRes = await emitAck(host, 'host:reset', {});
  check(reconRes && reconRes.ok, 'host reset back to lobby');
  const afterReset = await emitAck(host, 'host:auth', {});
  check(afterReset.players && afterReset.players.length === 0, 'reset clears all players from the lobby');
  await rejoinAll();

  // ---- Custom Words mode (host-gated start + edit/resubmit) ----
  const cwOn = await emitAck(host, 'host:setCustomWords', { on: true });
  check(cwOn && cwOn.customWords === true, 'custom words toggled on');
  const hostIntro2 = makeQueue(host, 'state:intro');
  const cwStart = await emitAck(host, 'host:start', {});
  check(cwStart && cwStart.ok && cwStart.phase === 'COLLECT', 'custom start → COLLECT phase');

  // Host cannot start before everyone has submitted.
  const earlyStart = await emitAck(host, 'host:start', {});
  check(earlyStart && !earlyStart.ok && earlyStart.reason === 'not-ready',
    'host:start rejected before all players submit');

  // Everyone submits — the game must NOT auto-advance (host-gated start).
  const submittedWords = {};
  const pids = Object.keys(byId);
  for (let i = 0; i < pids.length; i++) {
    const pid = pids[i];
    const w = [0, 1, 2, 3, 4].map((k) => nameById[pid] + '-w' + k);
    submittedWords[pid] = w;
    const r = await emitAck(byId[pid], 'player:words', { words: w });
    check(r && r.ok && r.phase === 'COLLECT', 'words accepted (stays COLLECT) for ' + nameById[pid]);
  }
  const afterAll = await emitAck(host, 'host:auth', {});
  check(afterAll.phase === 'COLLECT', 'stays COLLECT until the host starts');

  // A player re-opens to edit → they unsubmit → host can no longer start.
  const edit0 = await emitAck(byId[pids[0]], 'player:editWords', {});
  check(edit0 && edit0.ok && JSON.stringify(edit0.words) === JSON.stringify(submittedWords[pids[0]]),
    'editWords returns the prior words for prefill');
  const startWhileEditing = await emitAck(host, 'host:start', {});
  check(startWhileEditing && !startWhileEditing.ok && startWhileEditing.reason === 'not-ready',
    'host:start rejected while a player is mid-edit');

  // Resubmit with a CHANGED word — the pool must reflect the edit.
  const changed = ['CHANGED-word'].concat(submittedWords[pids[0]].slice(1));
  submittedWords[pids[0]] = changed;
  const re0 = await emitAck(byId[pids[0]], 'player:words', { words: changed });
  check(re0 && re0.ok && re0.phase === 'COLLECT', 'resubmit accepted after edit (still COLLECT)');

  // Now everyone is ready again → the host starts the game.
  const goStart = await emitAck(host, 'host:start', {});
  check(goStart && goStart.ok && goStart.phase === 'INTRO', 'host starts once all ready → INTRO');

  const intro2 = await hostIntro2();
  check(intro2 && intro2.totalRounds === N, 'custom game built N rounds');

  // Verify the round pool is EXACTLY the submitted words, each used once.
  const hostRank2 = makeQueue(host, 'state:rank');
  const hostDiscuss2 = makeQueue(host, 'state:discuss');
  const allSubmitted = pids.flatMap((p) => submittedWords[p]).sort();
  const seenTexts = [];
  for (let r = 1; r <= N; r++) {
    const rank = await hostRank2();
    const items = await rankItemsQ[rank.rankerId]();
    items.items.forEach((it) => seenTexts.push(it.text));
    const order = items.items.map((it) => it.id);
    await emitAck(byId[rank.rankerId], 'player:rank', { order });
    const discuss = await hostDiscuss2();
    await emitAck(byId[discuss.submitterId], 'player:submit', { order });
    if (r < N) await emitAck(host, 'host:next', {});
  }
  check(JSON.stringify(seenTexts.sort()) === JSON.stringify(allSubmitted),
    'pool = submitted words, each used exactly once');

  // ---- Kicking is blocked once the game has started (COLLECT) ----
  await emitAck(host, 'host:reset', {});
  await rejoinAll();
  await emitAck(host, 'host:setCustomWords', { on: true });
  await emitAck(host, 'host:start', {});
  const blockedKick = await emitAck(host, 'host:kick', { playerId: Object.keys(byId)[0] });
  check(blockedKick && !blockedKick.ok, 'kicking during COLLECT is rejected');
  const stillThere = await emitAck(host, 'host:auth', {});
  check(stillThere.phase === 'COLLECT' && stillThere.players.length === N,
    'phase + roster unchanged after a blocked kick');

  // ---- Duplicate word handling (Tier-A normalization) ----
  await emitAck(host, 'host:reset', {});
  await rejoinAll();
  await emitAck(host, 'host:setCustomWords', { on: true });
  await emitAck(host, 'host:start', {});
  const dp = Object.keys(byId);
  const ownDup = await emitAck(byId[dp[0]], 'player:words', { words: ['Pizza', 'pizza', 'x', 'y', 'z'] });
  check(ownDup && ownDup.reason === 'duplicate-own' && JSON.stringify(ownDup.dupIndexes) === '[1]',
    'own duplicate rejected with the repeat index');
  const artDup = await emitAck(byId[dp[0]], 'player:words', { words: ['The Office', 'office', 'x', 'y', 'z'] });
  check(artDup && artDup.reason === 'duplicate-own', 'article-stripped duplicate rejected (The Office == Office)');
  const okA = await emitAck(byId[dp[0]], 'player:words', { words: ['Red', 'Green', 'Blue', 'One', 'Two'] });
  check(okA && okA.ok, 'distinct words accepted');
  const crossDup = await emitAck(byId[dp[1]], 'player:words', { words: ['red', 'p', 'GREEN', 'r', 's'] });
  check(crossDup && crossDup.reason === 'duplicate-taken' && JSON.stringify(crossDup.dupIndexes) === '[0,2]',
    'cross-player duplicate rejected case-insensitively, with indexes');
  const okB = await emitAck(byId[dp[1]], 'player:words', { words: ['purple', 'p', 'q', 'r', 's'] });
  check(okB && okB.ok, 'resubmit with unique words accepted');
  // Remaining players submit unique words so the game can begin.
  for (let i = 2; i < dp.length; i++) {
    await emitAck(byId[dp[i]], 'player:words', { words: [0, 1, 2, 3, 4].map((k) => nameById[dp[i]] + '-d' + k) });
  }
  const allDistinct = await emitAck(host, 'host:auth', {});
  check(allDistinct.phase === 'COLLECT', 'all words unique → ready, waiting on host');
  const distinctStart = await emitAck(host, 'host:start', {});
  check(distinctStart && distinctStart.ok && distinctStart.phase === 'INTRO', 'host starts once all words are unique');

  // ---- Editing releases a word back to the pool for other players ----
  await emitAck(host, 'host:reset', {});
  await rejoinAll();
  await emitAck(host, 'host:setCustomWords', { on: true });
  await emitAck(host, 'host:start', {});
  const ep = Object.keys(byId);
  const e0 = await emitAck(byId[ep[0]], 'player:words', { words: ['Crimson', 'Amber', 'Teal', 'Slate', 'Ivory'] });
  check(e0 && e0.ok, 'p0 claims words including Crimson');
  const blocked = await emitAck(byId[ep[1]], 'player:words', { words: ['crimson', 'aa', 'bb', 'cc', 'dd'] });
  check(blocked && blocked.reason === 'duplicate-taken', 'p1 is blocked from taking Crimson while p0 holds it');
  await emitAck(byId[ep[0]], 'player:editWords', {});
  const e0b = await emitAck(byId[ep[0]], 'player:words', { words: ['Maroon', 'Amber', 'Teal', 'Slate', 'Ivory'] });
  check(e0b && e0b.ok, 'p0 resubmits without Crimson');
  const nowOk = await emitAck(byId[ep[1]], 'player:words', { words: ['crimson', 'aa', 'bb', 'cc', 'dd'] });
  check(nowOk && nowOk.ok, 'p1 can now take the released word Crimson');

  // ---- Reconnect during COLLECT prefills the last words ----
  await emitAck(host, 'host:reset', {});
  await rejoinAll();
  await emitAck(host, 'host:setCustomWords', { on: true });
  await emitAck(host, 'host:start', {});
  const rp = Object.keys(byId);
  const words0 = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
  await emitAck(byId[rp[0]], 'player:words', { words: words0 });
  const rc1 = await emitAck(byId[rp[0]], 'player:reconnect', { playerId: rp[0] });
  check(rc1 && rc1.collect && rc1.collect.submitted === true
    && JSON.stringify(rc1.collect.words) === JSON.stringify(words0),
    'reconnect after submit → submitted + words returned');
  await emitAck(byId[rp[0]], 'player:editWords', {});
  const rc2 = await emitAck(byId[rp[0]], 'player:reconnect', { playerId: rp[0] });
  check(rc2 && rc2.collect && rc2.collect.submitted === false
    && JSON.stringify(rc2.collect.words) === JSON.stringify(words0),
    'reconnect mid-edit → unsubmitted but words prefilled');

  console.log(failed ? '\n✗ FAILED' : '\n✓ ALL PASSED');
  host.close();
  Object.values(byId).forEach((s) => s.close());
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
