'use strict';

// Headless end-to-end integration test for Camo. Spins up an in-process
// server, connects a host + player sockets, and drives full rounds with
// SCRIPTED votes/guesses to force each scoring branch, asserting the
// broadcast payloads at every step.
//
// Also asserts the SECRECY INVARIANT: the secret word reaches every player
// except the Chameleon, and never appears in a broadcast before the reveal.
//
//   node scripts/itest-camo.js   (or: npm run itest:camo)

const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const mountCamo = require('../server/camo');

const app = express();
const server = http.createServer(app);
mountCamo(app, server, { getPublicBaseUrl: () => 'http://localhost' });

let failed = false;
function check(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed = true; console.log('  ✗ ' + msg); }
}

function connect() {
  return new Promise((resolve) => {
    const url = 'http://localhost:' + server.address().port + '/camo';
    const s = Client(url, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
  });
}
function emitAck(sock, ev, payload) {
  return new Promise((resolve) => sock.emit(ev, payload, resolve));
}

// Buffer named events so a broadcast landing mid-assertion isn't missed.
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
  return {
    next(ev, timeoutMs) {
      if (queued[ev].length) return Promise.resolve(queued[ev].shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + ev)), timeoutMs || 10000);
        waiting[ev].push((p) => { clearTimeout(timer); resolve(p); });
      });
    },
    flush(ev) { queued[ev] = []; },
    flushAll() { for (const ev of events) queued[ev] = []; },
    count(ev) { return queued[ev].length; },
  };
}

const HOST_EVENTS = ['state:lobby', 'state:intro', 'state:role', 'state:clues',
  'state:vote', 'state:guess', 'state:reveal', 'state:final', 'host:roleAckCount', 'host:voteCount'];
const PLAYER_EVENTS = ['you:role', 'player:result', 'state:reveal', 'state:clues', 'state:vote'];

let host, hostBus;
const players = [];   // { id, name, sock, bus }

async function addPlayer(name) {
  const sock = await connect();
  const bus = listen(sock, PLAYER_EVENTS);
  const id = 'pid_' + name;
  const ack = await emitAck(sock, 'player:join', { playerId: id, name });
  const p = { id, name, sock, bus, ack };
  players.push(p);
  return p;
}

// Collect this round's you:role for every player and verify secrecy.
async function collectRoles(grid) {
  const roles = [];
  for (const p of players) {
    const r = await p.bus.next('you:role');
    roles.push({ p, r });
  }
  const chameleons = roles.filter((x) => x.r.isChameleon);
  const informed = roles.filter((x) => !x.r.isChameleon);
  check(chameleons.length === 1, 'exactly one Chameleon this round');
  check(chameleons.every((x) => x.r.secretWord == null), 'Chameleon receives NO secret word');
  const words = new Set(informed.map((x) => x.r.secretWord));
  check(words.size === 1 && !words.has(null) && !words.has(undefined),
    'every other player receives the same secret word');
  const secretWord = informed[0].r.secretWord;
  check(grid.words.indexOf(secretWord) !== -1, 'the secret word is one of the 16 grid words');
  return {
    chameleon: chameleons[0].p,
    secretWord,
    secretIndex: grid.words.indexOf(secretWord),
  };
}

// Deep scan a payload for anything that would identify the secret.
// The 16-word grid and the player roster are PUBLIC by design, so the real
// invariant is: no field names which word is secret or who the Chameleon is.
const SECRET_KEYS = ['secretWord', 'secretIndex', 'chameleonId', 'chameleonName', 'isChameleon'];
function findSecretKeys(node, path, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => findSecretKeys(v, path + '[' + i + ']', out));
    return out;
  }
  for (const k of Object.keys(node)) {
    if (SECRET_KEYS.indexOf(k) !== -1) out.push(path + '.' + k);
    findSecretKeys(node[k], path + '.' + k, out);
  }
  return out;
}
function checkNoLeak(payload, secretWord, label) {
  const keys = findSecretKeys(payload, label, []);
  check(keys.length === 0, label + ' carries no secret-bearing field' + (keys.length ? ' — found ' + keys.join(', ') : ''));
  const clone = JSON.parse(JSON.stringify(payload));
  if (clone.grid) delete clone.grid.words;   // the grid is meant to be public
  check(JSON.stringify(clone).indexOf('"' + secretWord + '"') === -1,
    label + ' never singles out the secret word');
}

async function ackAllRoles() {
  for (const p of players) await emitAck(p.sock, 'player:roleAck', {});
}

// Walk the speaking order, tapping Done for whoever is up.
async function runClues(firstClues) {
  const order = firstClues.order.map((o) => o.id);
  check(order.length === players.length, 'speaking order covers every player');
  check(new Set(order).size === order.length, 'speaking order has no duplicates');

  // A player who is not up must be refused.
  const notUp = players.find((p) => p.id !== firstClues.currentId);
  const bad = await emitAck(notUp.sock, 'player:clueDone', {});
  check(bad.ok === false && bad.reason === 'not-your-turn', 'a non-speaker cannot end the turn');

  for (let i = 0; i < order.length; i++) {
    const speaker = players.find((p) => p.id === order[i]);
    const res = await emitAck(speaker.sock, 'player:clueDone', {});
    check(res.ok === true, 'turn ' + (i + 1) + ' (' + speaker.name + ') taps Done');
  }
  check(order.length > 0, 'the last clue opens the vote with no extra host tap');
  hostBus.flush('state:clues');
  const vote = await hostBus.next('state:vote');
  check(vote.order && vote.order.length === players.length,
    'the vote screen carries the speaking order for the discussion');
  return vote;
}

/**
 * Drive one full round.
 * @param {'escape'|'caught-wrong'|'caught-right'} outcome
 */
async function playRound(outcome, label) {
  console.log('\n— Round: ' + label + ' —');
  for (const p of players) p.bus.flush('player:result');   // drop the previous round's
  const role = await hostBus.next('state:role');
  check(role.grid.words.length === 16, 'grid has 16 words');
  check(!!role.grid.topic, 'grid has a topic: ' + role.grid.topic);

  const info = await collectRoles(role.grid);
  checkNoLeak(role, info.secretWord, 'state:role');

  await ackAllRoles();
  const clues = await hostBus.next('state:clues');
  checkNoLeak(clues, info.secretWord, 'state:clues');

  const vote = await runClues(clues);
  checkNoLeak(vote, info.secretWord, 'state:vote');

  const self = await emitAck(players[0].sock, 'player:vote', { targetId: players[0].id });
  check(self.ok === false && self.reason === 'no-self-vote', 'a player cannot vote for themselves');

  // Everyone but the Chameleon points at the chosen target.
  const others = players.filter((p) => p.id !== info.chameleon.id);
  const target = outcome === 'escape' ? others[0] : info.chameleon;
  const catchers = [];
  const spotters = [];
  for (const p of others) {
    if (p.id === target.id && outcome === 'escape') {
      // The scapegoat can't vote for themselves — send them elsewhere.
      await emitAck(p.sock, 'player:vote', { targetId: info.chameleon.id });
      spotters.push(p);
      continue;
    }
    await emitAck(p.sock, 'player:vote', { targetId: target.id });
    if (outcome !== 'escape') catchers.push(p);
  }
  await emitAck(info.chameleon.sock, 'player:vote', { targetId: others[0].id });

  if (outcome === 'escape') {
    const reveal = await hostBus.next('state:reveal');
    check(reveal.outcome === 'escaped-vote', 'outcome is escaped-vote');
    check(reveal.caught === false, 'the Chameleon was not caught');
    check(reveal.chameleonId === info.chameleon.id, 'reveal names the real Chameleon');
    check(reveal.secretWord === info.secretWord, 'reveal exposes the secret word');
    return { info, reveal, catchers, spotters };
  }

  const guess = await hostBus.next('state:guess');
  check(guess.chameleonId === info.chameleon.id, 'the caught player is the Chameleon');
  const notCham = players.find((p) => p.id !== info.chameleon.id);
  const badGuess = await emitAck(notCham.sock, 'player:guess', { wordIndex: 0 });
  check(badGuess.ok === false && badGuess.reason === 'not-chameleon', 'only the Chameleon may guess');

  const idx = outcome === 'caught-right'
    ? info.secretIndex
    : (info.secretIndex + 1) % 16;
  await emitAck(info.chameleon.sock, 'player:guess', { wordIndex: idx });

  const reveal = await hostBus.next('state:reveal');
  check(reveal.caught === true, 'the Chameleon was caught');
  check(reveal.outcome === (outcome === 'caught-right' ? 'escaped-guess' : 'caught'),
    'outcome is ' + (outcome === 'caught-right' ? 'escaped-guess' : 'caught'));
  check(reveal.guessCorrect === (outcome === 'caught-right'), 'guess correctness recorded');
  return { info, reveal, catchers, spotters };
}

function scoreOf(reveal, playerId) {
  const row = reveal.leaderboard.find((e) => e.id === playerId);
  return row ? row.score : null;
}

// Points gained this round, independent of the running total.
function gainOf(reveal, playerId) {
  const row = (reveal.scorers || []).find((s) => s.playerId === playerId);
  return row ? row.points : 0;
}

// Role → clues → vote, leaving the round parked on the open vote.
async function toVote() {
  const role = await hostBus.next('state:role');
  const info = await collectRoles(role.grid);
  await ackAllRoles();
  await runClues(await hostBus.next('state:clues'));
  return info;
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  console.log('Camo integration test\n');

  host = await connect();
  hostBus = listen(host, HOST_EVENTS);
  const auth = await emitAck(host, 'host:auth', {});
  check(auth.ok === true, 'host authenticates');
  check(auth.maxPlayers === 8, 'lobby cap is 8');
  check(auth.minPlayers === 3, 'minimum is 3 players');

  console.log('\n— Lobby —');
  const tooFew = await emitAck(host, 'host:start', { targetScore: 10 });
  check(tooFew.ok === false && tooFew.reason === 'not-enough-players', 'cannot start with 0 players');

  for (const n of ['Ana', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hal']) await addPlayer(n);
  check(players.every((p) => p.ack.ok), 'eight players join');

  const ninth = await connect();
  const full = await emitAck(ninth, 'player:join', { playerId: 'pid_Ivy', name: 'Ivy' });
  check(full.ok === false && full.reason === 'game-full', 'a ninth player is refused (game-full)');
  ninth.close();

  // Trim to four for a readable vote.
  for (const p of players.slice(4)) await emitAck(host, 'host:kick', { playerId: p.id });
  for (const p of players.splice(4)) p.sock.close();
  await new Promise((r) => setTimeout(r, 150));
  let lobby = null;
  while (hostBus.count('state:lobby')) lobby = await hostBus.next('state:lobby');
  check(lobby && lobby.players.length === 4, 'kick trims the lobby to four players');

  await emitAck(host, 'host:start', { targetScore: 10, autoAdvance: false });
  await hostBus.next('state:intro');
  check(true, 'game starts (intro)');

  const r1 = await playRound('escape', 'Chameleon escapes the vote');
  check(scoreOf(r1.reveal, r1.info.chameleon.id) === 2, 'escaping the vote scores the Chameleon 2');
  check(r1.spotters.length > 0 && r1.spotters.every((p) => gainOf(r1.reveal, p.id) === 1),
    'a player who named the Chameleon still scores 1 when they escape');
  const zeroes = r1.reveal.leaderboard.filter((e) => e.id !== r1.info.chameleon.id
    && !r1.spotters.some((s) => s.id === e.id));
  check(zeroes.every((e) => e.score === 0), 'nobody who voted wrong scores when the Chameleon escapes');

  await emitAck(host, 'host:next', {});   // REVEAL → next round
  const r2 = await playRound('caught-wrong', 'caught, guesses wrong');
  check(r2.catchers.every((p) => gainOf(r2.reveal, p.id) === 2), 'every regular player scores 2 on a failed guess');
  check(gainOf(r2.reveal, r2.info.chameleon.id) === 0, 'a caught Chameleon who guesses wrong scores nothing');
  const r2res = await r2.catchers[0].bus.next('player:result');
  check(r2res.votedCorrectly === true && r2res.pointsEarned === 2, 'player:result reports the catch');

  await emitAck(host, 'host:next', {});
  const r3 = await playRound('caught-right', 'caught, guesses right');
  check(r3.reveal.guessWord === r3.info.secretWord, 'a correct guess names the secret word');
  const chamResult = await r3.info.chameleon.bus.next('player:result');
  check(chamResult.wasChameleon === true, 'the Chameleon sees their own role in the result');
  check(chamResult.pointsEarned === 1, 'guessing right scores the Chameleon 1');

  console.log('\n— Reconnect —');
  await emitAck(host, 'host:next', {});
  const role4 = await hostBus.next('state:role');
  const info4 = await collectRoles(role4.grid);
  const rejoin = players.find((p) => p.id !== info4.chameleon.id);
  rejoin.sock.close();
  await new Promise((r) => setTimeout(r, 120));
  rejoin.sock = await connect();
  rejoin.bus = listen(rejoin.sock, PLAYER_EVENTS);
  const back = await emitAck(rejoin.sock, 'player:reconnect', { playerId: rejoin.id });
  check(back.ok === true && back.phase === 'ROLE', 'reconnect during ROLE returns the phase');
  check(back.myRole && back.myRole.secretWord === info4.secretWord,
    'a reconnecting player gets their secret word back');
  check(back.myRole.isChameleon === false, 'a reconnecting player keeps their role');

  const chamSock = info4.chameleon.sock;
  chamSock.close();
  await new Promise((r) => setTimeout(r, 120));
  info4.chameleon.sock = await connect();
  info4.chameleon.bus = listen(info4.chameleon.sock, PLAYER_EVENTS);
  const chamBack = await emitAck(info4.chameleon.sock, 'player:reconnect', { playerId: info4.chameleon.id });
  check(chamBack.myRole && chamBack.myRole.isChameleon === true, 'the reconnecting Chameleon is still the Chameleon');
  check(chamBack.myRole.secretWord == null, 'the reconnecting Chameleon still gets NO secret word');

  console.log('\n— Fixed roster —');
  const dropped = players.find((p) => p.id !== info4.chameleon.id && p.id !== rejoin.id);
  dropped.sock.close();
  await new Promise((r) => setTimeout(r, 150));
  for (const p of players) {
    if (p.id === dropped.id) continue;
    const ackRes = await emitAck(p.sock, 'player:roleAck', {});
    check(ackRes.total === 4, 'ROLE total stays at four after a drop (' + p.name + ' acked)');
  }
  check(hostBus.count('state:clues') === 0, 'ROLE waits for the missing player instead of advancing');

  dropped.sock = await connect();
  dropped.bus = listen(dropped.sock, PLAYER_EVENTS);
  await emitAck(dropped.sock, 'player:reconnect', { playerId: dropped.id });
  const lastAck = await emitAck(dropped.sock, 'player:roleAck', {});
  check(lastAck.total === 4 && lastAck.acked === 4, 'the fourth ack completes the roster');

  const vote4 = await runClues(await hostBus.next('state:clues'));
  check(vote4.total === 4, 'the vote is counted against all four players');
  check(vote4.players.length === 4, 'the vote list still offers every player');

  const voters = players.filter((p) => p.id !== info4.chameleon.id);
  voters[0].sock.close();
  await new Promise((r) => setTimeout(r, 150));
  let lastVote = null;
  for (const p of voters.slice(1)) lastVote = await emitAck(p.sock, 'player:vote', { targetId: info4.chameleon.id });
  lastVote = await emitAck(info4.chameleon.sock, 'player:vote', { targetId: voters[1].id });
  check(lastVote.total === 4, 'the vote total does not shrink when a player drops');
  check(lastVote.voted === 3, 'only the three present players are counted as voted');
  check(hostBus.count('state:guess') === 0 && hostBus.count('state:reveal') === 0,
    'the vote stays open while a player is missing');

  await emitAck(host, 'host:next', {});               // host closes the stalled vote
  const guess4 = await hostBus.next('state:guess');
  check(guess4.chameleonId === info4.chameleon.id, 'the host can still close a vote a dropped player stalled');

  console.log('\n— A dropped speaker keeps their turn —');
  await emitAck(host, 'host:reset', {});
  for (const p of players) p.sock.close();
  players.length = 0;
  for (const n of ['Ana', 'Ben', 'Cleo']) await addPlayer(n);
  hostBus.flushAll();
  await emitAck(host, 'host:start', { targetScore: 10, autoAdvance: false });
  await hostBus.next('state:intro');
  await hostBus.next('state:role');
  for (const p of players) await p.bus.next('you:role');
  await ackAllRoles();

  const clues5 = await hostBus.next('state:clues');
  const speaker = players.find((p) => p.id === clues5.currentId);
  speaker.sock.close();
  await new Promise((r) => setTimeout(r, 150));
  const afterDrop = await hostBus.next('state:clues');
  check(afterDrop.turnIndex === clues5.turnIndex, 'a dropped speaker does not lose their turn');
  check(afterDrop.currentId === speaker.id, 'the turn stays with the missing player');
  check(afterDrop.order.find((o) => o.id === speaker.id).connected === false,
    'the host sees the missing player dimmed straight away');

  speaker.sock = await connect();
  speaker.bus = listen(speaker.sock, PLAYER_EVENTS);
  await emitAck(speaker.sock, 'player:reconnect', { playerId: speaker.id });
  const backClues = await hostBus.next('state:clues');
  check(backClues.order.find((o) => o.id === speaker.id).connected === true,
    'the host un-dims them the moment they return');
  check(backClues.currentId === speaker.id, 'they come back to their own turn');
  const resumed = await emitAck(speaker.sock, 'player:clueDone', {});
  check(resumed.ok === true, 'a returning speaker can still take their turn');

  const clues6 = await hostBus.next('state:clues');
  const stuck = clues6.currentId;
  await emitAck(host, 'host:next', {});
  const clues7 = await hostBus.next('state:clues');
  check(clues7.turnIndex === clues6.turnIndex + 1, 'the host can skip a stuck turn manually');
  check(clues7.currentId !== stuck, 'the skipped player is no longer up');

  console.log('\n— Tied vote —');
  await emitAck(host, 'host:reset', {});
  for (const p of players) p.sock.close();
  players.length = 0;
  for (const n of ['Ana', 'Ben', 'Cleo', 'Dev']) await addPlayer(n);
  hostBus.flushAll();
  await emitAck(host, 'host:start', { targetScore: 10, autoAdvance: false });
  await hostBus.next('state:intro');

  // Two votes on the Chameleon, two on someone else.
  const tieA = await toVote();
  const othersA = players.filter((p) => p.id !== tieA.chameleon.id);
  await emitAck(othersA[0].sock, 'player:vote', { targetId: tieA.chameleon.id });
  await emitAck(othersA[1].sock, 'player:vote', { targetId: tieA.chameleon.id });
  await emitAck(othersA[2].sock, 'player:vote', { targetId: othersA[0].id });
  await emitAck(tieA.chameleon.sock, 'player:vote', { targetId: othersA[0].id });
  const guessTie = await hostBus.next('state:guess');
  check(guessTie.chameleonId === tieA.chameleon.id, 'a tie the Chameleon shares still accuses them');
  check(guessTie.caughtOnTie === true, 'state:guess flags the shared tie');
  await emitAck(tieA.chameleon.sock, 'player:guess', { wordIndex: (tieA.secretIndex + 1) % 16 });
  const revealTie = await hostBus.next('state:reveal');
  check(revealTie.outcome === 'caught', 'a shared-tie catch scores like any other catch');
  check(revealTie.caughtOnTie === true, 'state:reveal flags the shared tie');
  check(gainOf(revealTie, othersA[0].id) === 2, 'a voter who named the Chameleon scores 2');
  check(gainOf(revealTie, othersA[2].id) === 2, 'a player who voted for an innocent still scores 2 on a catch');
  check(gainOf(revealTie, tieA.chameleon.id) === 0, 'the caught Chameleon scores nothing');

  // Two votes each on two innocents — the Chameleon is not in the tie.
  await emitAck(host, 'host:next', {});
  const tieB = await toVote();
  const othersB = players.filter((p) => p.id !== tieB.chameleon.id);
  await emitAck(tieB.chameleon.sock, 'player:vote', { targetId: othersB[0].id });
  await emitAck(othersB[1].sock, 'player:vote', { targetId: othersB[0].id });
  await emitAck(othersB[0].sock, 'player:vote', { targetId: othersB[1].id });
  await emitAck(othersB[2].sock, 'player:vote', { targetId: othersB[1].id });
  const revealSplit = await hostBus.next('state:reveal');
  check(revealSplit.outcome === 'escaped-vote', 'a tie the Chameleon avoided accuses nobody');
  check(revealSplit.accusedId == null, 'no accused when the top vote splits between innocents');
  check(revealSplit.caughtOnTie === false, 'an escape is never flagged as a tie catch');

  console.log('\n— Reaching the target score —');
  await emitAck(host, 'host:reset', {});
  for (const p of players) p.sock.close();
  players.length = 0;
  for (const n of ['Ana', 'Ben', 'Cleo']) await addPlayer(n);
  hostBus.flushAll();
  await emitAck(host, 'host:start', { targetScore: 2, autoAdvance: false });
  await hostBus.next('state:intro');
  const rf = await playRound('escape', 'escape to hit the target');
  check(rf.reveal.gameOver === true, 'reaching the target ends the game');
  check(rf.reveal.winnerId === rf.info.chameleon.id, 'the Chameleon wins on 2 points');
  await emitAck(host, 'host:next', {});
  const final = await hostBus.next('state:final');
  check(final.winnerName === rf.info.chameleon.name, 'final screen names the winner');
  check(final.fullLeaderboard.length === 3, 'final leaderboard lists everyone');

  console.log('\n' + (failed ? '✗ FAILURES' : '✓ all checks passed'));
  for (const p of players) p.sock.close();
  host.close();
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\nFATAL', e);
  process.exit(1);
});
