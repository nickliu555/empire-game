'use strict';
// Headless end-to-end smoke test for Pac-Man Royale: lobby, start gating,
// CPU bots, input-relay gating, round-meta rebroadcast, elimination, reconnect.
// Not a unit test — a socket-flow probe against a running server on :3000.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000/pacman';

function mk(opts) { return io(URL, Object.assign({ transports: ['websocket'], forceNew: true }, opts)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }

async function main() {
  const host = mk();
  await new Promise((r) => host.on('connect', r));
  const auth = await new Promise((r) => host.emit('host:auth', {}, r));
  check('host:auth ok (LOBBY)', auth && auth.ok && auth.phase === 'LOBBY');

  const hostLobbies = [];
  host.on('state:lobby', (l) => hostLobbies.push(l));

  // Start with too few players is blocked.
  const early = await new Promise((r) => host.emit('host:start', {}, r));
  check('start blocked with 0 players', early && !early.ok);

  // One human joins.
  const p1 = mk();
  await new Promise((r) => p1.on('connect', r));
  const j1 = await new Promise((r) => p1.emit('player:join', { playerId: 'p1', name: 'Alice' }, r));
  check('p1 join ok', j1 && j1.ok);
  await wait(60);
  let lob = hostLobbies[hostLobbies.length - 1];
  check('1 player cannot start yet', lob && lob.total === 1 && lob.canStart === false);

  // Config setters.
  const rw = await new Promise((r) => host.emit('host:setRoundsToWin', { roundsToWin: 2 }, r));
  check('setRoundsToWin ok', rw && rw.ok && rw.roundsToWin === 2);
  const rl = await new Promise((r) => host.emit('host:setRoundLength', { roundLengthSec: 60 }, r));
  check('setRoundLength ok', rl && rl.ok && rl.roundLengthSec === 60);

  // Add a CPU to make it 2 → canStart.
  const bot = await new Promise((r) => host.emit('host:addBot', {}, r));
  check('addBot ok', bot && bot.ok);
  await wait(60);
  lob = hostLobbies[hostLobbies.length - 1];
  check('2 players (1 human + CPU) canStart', lob && lob.total === 2 && lob.canStart === true);
  check('roster has a bot with a colour', lob.players.some((p) => p.isBot && p.color));

  // Player receives m:start and round events.
  const pev = [];
  ['m:start', 'm:roundStart', 'm:countdown', 'm:play', 'm:clock', 'm:powered', 'm:eliminated', 'm:pause', 'm:resume', 'm:roundOver', 'm:end'].forEach((e) => p1.on(e, (d) => pev.push([e, d])));
  const relayed = [];
  host.on('in', (d) => relayed.push(d));

  const start = await new Promise((r) => host.emit('host:start', {}, r));
  check('host:start ok with roster', start && start.ok && Array.isArray(start.roster) && start.roster.length === 2);
  check('start echoes config', start.roundsToWin === 2 && start.roundLengthSec === 60);
  await wait(60);
  check('player got m:start', pev.some((e) => e[0] === 'm:start'));

  // Input BEFORE the round is live must NOT be relayed.
  p1.emit('in', { dir: 3 });
  await wait(40);
  check('input dropped before live', !relayed.some((d) => d && d.id === 'p1'));

  // Host drives the round meta.
  host.emit('host:roundStart', { round: 1, mazeIndex: 0, durationSec: 60 });
  await wait(30);
  host.emit('host:play', {});
  await wait(40);
  check('player got m:roundStart', pev.some((e) => e[0] === 'm:roundStart'));
  check('player got m:play', pev.some((e) => e[0] === 'm:play'));

  // Now input IS relayed with id + dir.
  p1.emit('in', { dir: 2 });
  await wait(40);
  check('input relayed once live', relayed.some((d) => d && d.id === 'p1' && d.dir === 2));

  // Pause blocks input relay; resume restores it.
  host.emit('host:pause', {});
  await wait(40);
  check('player got m:pause', pev.some((e) => e[0] === 'm:pause'));
  const beforePause = relayed.length;
  p1.emit('in', { dir: 1 });
  await wait(40);
  check('input dropped while paused', relayed.length === beforePause);
  host.emit('host:resume', { live: true });
  await wait(40);
  check('player got m:resume (live)', pev.some((e) => e[0] === 'm:resume' && e[1] && e[1].live === true));
  p1.emit('in', { dir: 3 });
  await wait(40);
  check('input relayed after resume', relayed.some((d) => d && d.id === 'p1' && d.dir === 3));

  // Powered + clock + elimination rebroadcasts.
  host.emit('host:powered', { id: 'p1', on: true });
  host.emit('host:clock', { ms: 42000, scores: { p1: 120 } });
  await wait(40);
  check('player got m:powered', pev.some((e) => e[0] === 'm:powered' && e[1] && e[1].on === true));
  check('player got m:clock with scores', pev.some((e) => e[0] === 'm:clock' && e[1] && e[1].scores && e[1].scores.p1 === 120));

  host.emit('host:eliminated', { id: 'p1' });
  await wait(40);
  check('player got m:eliminated', pev.some((e) => e[0] === 'm:eliminated' && e[1] && e[1].id === 'p1'));

  // Input from an ELIMINATED player must NOT be relayed.
  const beforeLen = relayed.length;
  p1.emit('in', { dir: 0 });
  await wait(40);
  check('eliminated player input dropped', relayed.length === beforeLen);

  // Reconnect mid-round returns PLAYING + match meta (alive=false for p1).
  const p1b = mk();
  await new Promise((r) => p1b.on('connect', r));
  const rec = await new Promise((r) => p1b.emit('player:reconnect', { playerId: 'p1' }, r));
  check('reconnect returns PLAYING + meta', rec && rec.ok && rec.phase === 'PLAYING' && rec.match);
  check('reconnect meta shows eliminated', rec.match && rec.match.alive && rec.match.alive.p1 === false);

  // Round over → game points; then match end.
  host.emit('host:roundOver', { round: 1, scores: { p1: 120, 'bot-1': 90 }, winnerIds: ['p1'], gamePoints: { p1: 1 }, alive: { p1: false } });
  await wait(40);
  check('player got m:roundOver', pev.some((e) => e[0] === 'm:roundOver' && e[1] && e[1].winnerIds.indexOf('p1') >= 0));

  host.emit('host:matchEnd', { winnerIds: ['p1'], gamePoints: { p1: 2 } });
  await wait(40);
  check('player got m:end', pev.some((e) => e[0] === 'm:end' && e[1] && e[1].winnerIds.indexOf('p1') >= 0));

  // Reset returns to lobby.
  await new Promise((r) => host.emit('host:reset', {}, r));
  await wait(40);

  [host, p1, p1b].forEach((s) => s.close());
  console.log('\n' + (failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
