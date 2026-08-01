'use strict';
// Headless end-to-end smoke test for Bomb Brawl: lobby gating, capacity,
// seat reordering, CPU bots, config clamps, input-relay gating, round meta
// rebroadcast, elimination, round results, reconnect snapshots and reset.
// Not a unit test — a socket-flow probe against a running server (BB_URL to
// point it somewhere other than :3000).
const { io } = require('socket.io-client');
const URL = (process.env.BB_URL || 'http://localhost:3000') + '/bombbrawl';
const SEAT_COLORS = ['#FF4D4D', '#3DA5FF', '#3DDC84', '#FFD23F'];

function mk(opts) { return io(URL, Object.assign({ transports: ['websocket'], forceNew: true }, opts)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (sock, ev, payload) => new Promise((r) => sock.emit(ev, payload, r));
let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }
function section(t) { console.log('\n' + t); }

async function main() {
  const host = mk();
  await new Promise((r) => host.on('connect', r));
  const auth = await ask(host, 'host:auth', {});
  check('host:auth ok (LOBBY)', auth && auth.ok && auth.phase === 'LOBBY');
  check('auth exposes config bounds', auth && auth.minRoundsToWin === 1 && auth.maxRoundsToWin === 7 &&
    Array.isArray(auth.botDifficulties) && auth.botDifficulties.length === 3);

  const hostLobbies = [];
  host.on('state:lobby', (l) => hostLobbies.push(l));
  const last = () => hostLobbies[hostLobbies.length - 1];

  // ---------------------------------------------------------------- lobby
  section('Lobby & capacity');
  const early = await ask(host, 'host:start', {});
  check('start blocked with 0 players', early && !early.ok);

  const p1 = mk();
  await new Promise((r) => p1.on('connect', r));
  const j1 = await ask(p1, 'player:join', { playerId: 'p1', name: 'Alice' });
  check('p1 join ok', j1 && j1.ok);
  await wait(60);
  check('1 player cannot start yet', last() && last().total === 1 && last().canStart === false);

  const p2 = mk();
  await new Promise((r) => p2.on('connect', r));
  const j2 = await ask(p2, 'player:join', { playerId: 'p2', name: 'Bob' });
  check('p2 join ok', j2 && j2.ok);
  await wait(60);
  check('2 players → canStart', last() && last().total === 2 && last().canStart === true);

  const dupe = mk();
  await new Promise((r) => dupe.on('connect', r));
  const jd = await ask(dupe, 'player:join', { playerId: 'p9', name: 'alice' });
  check('duplicate name rejected', jd && !jd.ok && jd.reason === 'name-taken');
  dupe.close();

  // Fill to capacity (4) then verify the 5th is rejected.
  const p3 = mk();
  await new Promise((r) => p3.on('connect', r));
  await ask(p3, 'player:join', { playerId: 'p3', name: 'Cara' });
  const p4 = mk();
  await new Promise((r) => p4.on('connect', r));
  await ask(p4, 'player:join', { playerId: 'p4', name: 'Dan' });
  await wait(60);
  check('capacity is 4', last() && last().capacity === 4 && last().total === 4);
  const p5 = mk();
  await new Promise((r) => p5.on('connect', r));
  const j5 = await ask(p5, 'player:join', { playerId: 'p5', name: 'Eve' });
  check('5th player rejected as game-full', j5 && !j5.ok && j5.reason === 'game-full');
  const st = await ask(p5, 'query:status', {});
  check('query:status reports total/capacity', st && st.total === 4 && st.capacity === 4);
  p5.close();

  const botFull = await ask(host, 'host:addBot', {});
  check('addBot rejected when full', botFull && !botFull.ok);

  // ------------------------------------------------------------- ordering
  section('Seat order → spawn corners');
  let roster = last().players;
  check('seats are 0..3 in order', roster.every((p, i) => p.seat === i));
  check('corners follow the seat map',
    roster[0].corner === 'Top-left' && roster[1].corner === 'Top-right' &&
    roster[2].corner === 'Bottom-left' && roster[3].corner === 'Bottom-right');
  check('colours are distinct', new Set(roster.map((p) => p.color)).size === 4);

  // Move Dan (seat 3) in front of Bob (seat 1).
  const ro = await ask(host, 'host:reorder', { playerId: 'p4', beforeId: 'p2' });
  check('host:reorder ok', ro && ro.ok);
  await wait(60);
  roster = last().players;
  check('reorder renumbers seats', roster.map((p) => p.id).join(',') === 'p1,p4,p2,p3');
  check('reorder reassigns corners', roster[1].corner === 'Top-right' && roster[1].id === 'p4');
  check('reorder reassigns colours', roster[1].color === SEAT_COLORS[1] &&
    roster.every((p, i) => p.color === SEAT_COLORS[i]));

  // Put it back so the rest of the test reads naturally.
  await ask(host, 'host:reorder', { playerId: 'p4', beforeId: null });
  await wait(60);
  check('reorder to end works', last().players.map((p) => p.id).join(',') === 'p1,p2,p3,p4');

  // Make room for a CPU so bot handling is covered too.
  const kick = await ask(host, 'host:kick', { playerId: 'p4' });
  check('host:kick ok', kick && kick.ok);
  await wait(60);
  check('kicked player removed', last().total === 3);
  const bot = await ask(host, 'host:addBot', {});
  check('addBot ok when there is room', bot && bot.ok);
  await wait(60);
  check('bot joined with a colour + corner',
    last().players.some((p) => p.isBot && p.color && p.corner));

  // --------------------------------------------------------------- config
  section('Config clamps');
  const rw = await ask(host, 'host:setRoundsToWin', { roundsToWin: 2 });
  check('setRoundsToWin ok', rw && rw.ok && rw.roundsToWin === 2);
  const rwHigh = await ask(host, 'host:setRoundsToWin', { roundsToWin: 99 });
  check('roundsToWin clamped to max', rwHigh && rwHigh.roundsToWin === 7);
  await ask(host, 'host:setRoundsToWin', { roundsToWin: 2 });
  const rl = await ask(host, 'host:setRoundLength', { roundLengthSec: 5 });
  check('roundLength clamped to min', rl && rl.roundLengthSec === 60);
  const rl2 = await ask(host, 'host:setRoundLength', { roundLengthSec: 90 });
  check('setRoundLength ok', rl2 && rl2.roundLengthSec === 90);
  const pu = await ask(host, 'host:setPowerUps', { on: false });
  check('setPowerUps off', pu && pu.ok && pu.powerUps === false);
  await ask(host, 'host:setPowerUps', { on: true });
  const bd = await ask(host, 'host:setBotDifficulty', { level: 'hard' });
  check('setBotDifficulty ok', bd && bd.ok && bd.botDifficulty === 'hard');
  const bdBad = await ask(host, 'host:setBotDifficulty', { level: 'nightmare' });
  check('bad difficulty rejected', bdBad && !bdBad.ok);

  // ---------------------------------------------------------------- match
  section('Match flow');
  const pev = [];
  ['m:start', 'm:roundStart', 'm:countdown', 'm:play', 'm:clock', 'm:hud',
   'm:eliminated', 'm:pause', 'm:resume', 'm:roundEnd', 'm:end']
    .forEach((e) => p1.on(e, (d) => pev.push([e, d])));
  const got = (e, fn) => pev.some((x) => x[0] === e && (!fn || fn(x[1])));
  const inRelay = [];
  const bombRelay = [];
  host.on('in', (d) => inRelay.push(d));
  host.on('bomb', (d) => bombRelay.push(d));

  const start = await ask(host, 'host:start', {});
  check('host:start ok with roster', start && start.ok && Array.isArray(start.roster) && start.roster.length === 4);
  check('start echoes config', start.roundsToWin === 2 && start.roundLengthSec === 90 && start.powerUps === true);
  await wait(60);
  check('player got m:start', got('m:start'));

  const roLate = await ask(host, 'host:reorder', { playerId: 'p2', beforeId: 'p1' });
  check('reorder rejected outside LOBBY', roLate && !roLate.ok);

  // Input before the round is live must NOT be relayed.
  p1.emit('in', { x: 1, y: 0 });
  p1.emit('bomb', {});
  await wait(40);
  check('input dropped before live', inRelay.length === 0 && bombRelay.length === 0);

  host.emit('host:roundStart', { round: 1, seed: 1234, durationSec: 90 });
  await wait(40);
  check('player got m:roundStart with hud', got('m:roundStart', (d) => d && d.round === 1 && d.hud && d.hud.p1));
  host.emit('host:countdown', { n: 3, note: 'Get ready' });
  host.emit('host:play', {});
  await wait(40);
  check('player got m:countdown', got('m:countdown', (d) => d && d.n === 3));
  check('player got m:play', got('m:play'));

  p1.emit('in', { x: -1, y: 0.5 });
  p1.emit('bomb', {});
  await wait(40);
  check('stick relayed once live', inRelay.some((d) => d && d.id === 'p1' && d.x === -1 && d.y === 0.5));
  check('bomb relayed once live', bombRelay.some((d) => d && d.id === 'p1'));

  p1.emit('in', { x: 9, y: -9 });
  await wait(40);
  check('stick vector clamped to -1..1', inRelay.some((d) => d && d.x === 1 && d.y === -1));

  // Pause gating.
  host.emit('host:pause', {});
  await wait(40);
  check('player got m:pause', got('m:pause'));
  let n = inRelay.length;
  p1.emit('in', { x: 0.5, y: 0 });
  await wait(40);
  check('input dropped while paused', inRelay.length === n);
  host.emit('host:resume', { live: true });
  await wait(40);
  check('player got m:resume (live)', got('m:resume', (d) => d && d.live === true));

  // HUD + clock + sudden death.
  host.emit('host:hud', { id: 'p1', bombs: 3, fire: 4, speed: 2, kick: true, out: 1 });
  host.emit('host:clock', { ms: 30000, suddenDeath: true });
  await wait(40);
  check('player got m:hud', got('m:hud', (d) => d && d.id === 'p1' && d.bombs === 3 && d.kick === true && d.out === 1));
  check('player got m:clock with suddenDeath', got('m:clock', (d) => d && d.ms === 30000 && d.suddenDeath === true));

  // Elimination gates input.
  host.emit('host:eliminated', { id: 'p1', by: 'p2' });
  await wait(40);
  check('player got m:eliminated', got('m:eliminated', (d) => d && d.id === 'p1' && d.by === 'p2'));
  n = inRelay.length;
  p1.emit('in', { x: 1, y: 0 });
  p1.emit('bomb', {});
  await wait(40);
  check('eliminated player input dropped', inRelay.length === n);

  // Reconnect mid-round returns a full snapshot.
  section('Reconnect snapshots');
  const p1b = mk();
  await new Promise((r) => p1b.on('connect', r));
  const rec = await ask(p1b, 'player:reconnect', { playerId: 'p1' });
  check('reconnect returns PLAYING + meta', rec && rec.ok && rec.phase === 'PLAYING' && rec.match);
  check('snapshot shows eliminated', rec.match.alive && rec.match.alive.p1 === false);
  check('snapshot carries hud', rec.match.hud && rec.match.hud.p1 && rec.match.hud.p1.fire === 4);
  check('snapshot carries roster + round', Array.isArray(rec.match.roster) && rec.match.round === 1);
  check('snapshot carries config', rec.match.roundsToWin === 2 && rec.match.powerUps === true);

  const host2 = mk();
  await new Promise((r) => host2.on('connect', r));
  const auth2 = await ask(host2, 'host:auth', {});
  check('host reconnect returns PLAYING + match', auth2 && auth2.ok && auth2.phase === 'PLAYING' && auth2.match);

  // Round + match end.
  section('Round & match end');
  host.emit('host:roundEnd', { round: 1, winnerId: 'p2', gamePoints: { p2: 1 } });
  await wait(40);
  check('player got m:roundEnd', got('m:roundEnd', (d) => d && d.winnerId === 'p2' && d.gamePoints.p2 === 1));
  check('roundEnd echoes roundsToWin', got('m:roundEnd', (d) => d && d.roundsToWin === 2));

  // A wipeout is still decided by the host (whoever fell last), so the relay
  // only ever carries a winner.
  host.emit('host:roundEnd', { round: 2, winnerId: 'p3', gamePoints: { p2: 1, p3: 1 } });
  await wait(40);
  check('wipeout winner relayed', got('m:roundEnd', (d) => d && d.winnerId === 'p3' && d.gamePoints.p3 === 1));

  host.emit('host:matchEnd', { winnerIds: ['p2'], gamePoints: { p2: 2 } });
  await wait(40);
  check('player got m:end', got('m:end', (d) => d && d.winnerIds.indexOf('p2') >= 0));
  const authFinal = await ask(host2, 'host:auth', {});
  check('host sees FINAL phase', authFinal && authFinal.phase === 'FINAL');

  // ---------------------------------------------------------------- reset
  section('Reset');
  const resets = [];
  p1.on('state:reset', () => resets.push(1));
  await ask(host, 'host:reset', {});
  await wait(60);
  check('players got state:reset', resets.length > 0);
  const authAfter = await ask(host, 'host:auth', {});
  check('back in LOBBY', authAfter && authAfter.phase === 'LOBBY');
  check('config survives reset', authAfter.lobby && authAfter.lobby.roundsToWin === 2 && authAfter.lobby.roundLengthSec === 90);

  // Clean up so a re-run starts from an empty lobby.
  const leftover = (last() && last().players) || [];
  for (const p of leftover) await ask(host, 'host:kick', { playerId: p.id });
  await wait(60);
  [host, host2, p1, p1b, p2, p3, p4].forEach((s) => s.close());
  console.log('\n' + (failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
