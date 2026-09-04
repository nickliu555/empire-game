'use strict';
// Headless end-to-end smoke test for Puck Ball: lobby, teams, bots, start,
// input relay, emote cooldown, pause, goal/end, reconnect and roster locking.
const { io } = require('socket.io-client');
const URL = process.env.PUCKBALL_URL || 'http://localhost:3000/puckball';

function mk(opts) { return io(URL, Object.assign({ transports: ['websocket'], forceNew: true }, opts)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name); if (!cond) failures++; }

async function main() {
  const host = mk();
  await new Promise((r) => host.on('connect', r));
  let auth = await new Promise((r) => host.emit('host:auth', {}, r));
  if (auth && auth.phase !== 'LOBBY') {
    await new Promise((r) => host.emit('host:reset', {}, r));
    auth = await new Promise((r) => host.emit('host:auth', {}, r));
  }
  check('host:auth ok in LOBBY', auth && auth.ok && auth.phase === 'LOBBY');
  check('auth exposes limits', auth && auth.lobby && auth.lobby.capacity === 8 && auth.lobby.perTeam === 4);

  const lobbies = [];
  host.on('state:lobby', (l) => lobbies.push(l));
  const last = () => lobbies[lobbies.length - 1];

  // ---- Joins auto-balance ----
  const players = [];
  const names = ['Alice', 'Bob', 'Cara', 'Dan'];
  for (let i = 0; i < names.length; i++) {
    const s = mk();
    await new Promise((r) => s.on('connect', r));
    const j = await new Promise((r) => s.emit('player:join', { playerId: 'p' + i, name: names[i] }, r));
    check('join ok: ' + names[i], j && j.ok);
    players.push({ s, id: 'p' + i, team: j.ok ? j.player.team : null });
  }
  await wait(100);
  check('4 players, 2 per side', last() && last().total === 4 && last().teams.red.length === 2 && last().teams.blue.length === 2);
  check('tier grows with team size (classic at 2v2)', last() && last().tier === 'classic');

  // Duplicate names are rejected.
  const dup = mk();
  await new Promise((r) => dup.on('connect', r));
  const dupRes = await new Promise((r) => dup.emit('player:join', { playerId: 'pdup', name: 'alice' }, r));
  check('duplicate name rejected', dupRes && !dupRes.ok && dupRes.reason === 'name-taken');
  dup.close();

  // ---- Manual assign + empty-side guard ----
  await new Promise((r) => host.emit('host:assign', { playerId: 'p0', team: 'blue' }, r));
  await wait(60);
  check('assign moved p0 to blue', last() && last().teams.blue.some((p) => p.id === 'p0'));
  // Empty one side entirely — a one-sided roster must not be startable.
  const reds = last().teams.red.map((p) => p.id);
  for (const id of reds) await new Promise((r) => host.emit('host:assign', { playerId: id, team: 'blue' }, r));
  await wait(60);
  check('one-sided roster cannot start', last() && last().teams.red.length === 0 && last().canStart === false);
  await new Promise((r) => host.emit('host:assign', { playerId: 'p0', team: 'red' }, r));
  await new Promise((r) => host.emit('host:assign', { playerId: 'p1', team: 'red' }, r));
  await wait(60);
  check('both sides filled again -> canStart', last() && last().canStart === true);

  // ---- Bots ----
  const bot = await new Promise((r) => host.emit('host:addBot', {}, r));
  await wait(60);
  check('addBot ok', bot && bot.ok);
  check('bot on the roster', last() && last().total === 5 &&
    last().teams.red.concat(last().teams.blue).some((p) => p.isBot));

  // ---- Team cap: never more than 4 on one side ----
  const capRes = [];
  for (const p of last().teams.red.map((x) => x.id)) {
    capRes.push(await new Promise((r) => host.emit('host:assign', { playerId: p, team: 'blue' }, r)));
  }
  await wait(60);
  check('a 5th player cannot stack onto a full team', capRes.some((r) => r && r.ok === false && r.reason === 'team-full'));
  check('blue capped at 4', last() && last().teams.blue.length === 4);
  const moveBack = last().teams.blue[0].id;
  await new Promise((r) => host.emit('host:assign', { playerId: moveBack, team: 'red' }, r));
  await wait(60);

  // ---- Config ----
  await new Promise((r) => host.emit('host:setTimeLimit', { timeLimitSec: 120 }, r));
  await wait(60);
  check('time limit applied', last() && last().timeLimitSec === 120);
  check('no score limit is exposed', last() && last().scoreLimit === undefined);

  // ---- Drag-and-drop ordering (host:assign + beforeId) ----
  const blueIds = last().teams.blue.map((p) => p.id);
  const lastBlue = blueIds[blueIds.length - 1];
  await new Promise((r) => host.emit('host:assign', { playerId: lastBlue, team: 'blue', beforeId: blueIds[0] }, r));
  await wait(60);
  check('beforeId reorders within a team', last() && last().teams.blue[0].id === lastBlue);
  check('reorder keeps the full roster', last() && last().total === 5);
  const redIds = last().teams.red.map((p) => p.id);
  await new Promise((r) => host.emit('host:assign', { playerId: lastBlue, team: 'red', beforeId: redIds[0] }, r));
  await wait(60);
  check('cross-team drop lands at the drop index', last() && last().teams.red[0].id === lastBlue);
  check('cross-team drop keeps the full roster', last() && last().total === 5);

  // ---- Start ----
  const p0 = players[0];
  const evs = [];
  ['m:start', 'm:countdown', 'm:play', 'm:clock', 'm:goal', 'm:pause', 'm:resume', 'm:end']
    .forEach((e) => p0.s.on(e, (d) => evs.push([e, d])));
  const relayed = [];
  host.on('in', (d) => relayed.push(d));
  const emotes = [];
  host.on('emote', (d) => emotes.push(d));

  const start = await new Promise((r) => host.emit('host:start', {}, r));
  check('host:start ok with roster', start && start.ok && start.roster.length === 5);
  check('roster carries team + seat order', start && start.roster.every((r2) => r2.team && typeof r2.seat === 'number'));
  check('host gets a randomized kickoff team', start && (start.kickoffTeam === 'red' || start.kickoffTeam === 'blue'));
  await wait(80);
  const playerStart = evs.find((e) => e[0] === 'm:start');
  check('player got m:start', !!playerStart);
  check('player gets the same kickoff team', playerStart && playerStart[1].kickoffTeam === start.kickoffTeam);

  // Joining mid-match is blocked.
  const late = mk();
  await new Promise((r) => late.on('connect', r));
  const lateRes = await new Promise((r) => late.emit('player:join', { playerId: 'plate', name: 'Zed' }, r));
  check('join blocked mid-match', lateRes && !lateRes.ok && lateRes.reason === 'round-in-progress');
  late.close();

  // ---- Input relay ----
  host.emit('host:play', {});
  await wait(40);
  p0.s.emit('in', { d: 5, k: 1 });          // dx=+1, dy=0, kicking
  p0.s.emit('in', { d: 99 });               // out of range -> ignored
  await wait(80);
  check('input relayed with id', relayed.some((d) => d && d.id === 'p0' && d.d === 5 && d.k === 1));
  check('bad direction code dropped', !relayed.some((d) => d && d.d === 99));

  // ---- Emotes: whitelist + cooldown ----
  p0.s.emit('emote', { e: '🔥' });
  p0.s.emit('emote', { e: '🔥' });           // inside the cooldown
  p0.s.emit('emote', { e: '💀' });           // not whitelisted
  await wait(100);
  check('one emote relayed (cooldown + whitelist)', emotes.length === 1 && emotes[0].e === '🔥');

  // ---- Match meta rebroadcast ----
  host.emit('host:goal', { team: 'red', red: 1, blue: 0 });
  host.emit('host:clock', { ms: 30000 });
  host.emit('host:pause', {});
  await wait(80);
  check('player got m:goal with score', evs.some((e) => e[0] === 'm:goal' && e[1] && e[1].red === 1));
  check('player got m:pause', evs.some((e) => e[0] === 'm:pause'));
  p0.s.emit('in', { d: 1 });
  await wait(60);
  check('input ignored while paused', !relayed.some((d) => d && d.d === 1));
  host.emit('host:resume', { live: true });
  await wait(60);
  check('player got m:resume', evs.some((e) => e[0] === 'm:resume'));

  // ---- A dropped phone never leaves the roster ----
  players[3].s.close();
  await wait(150);
  const meta = await new Promise((r) => {
    const h2 = mk();
    h2.on('connect', () => h2.emit('host:auth', {}, (res) => { h2.close(); r(res); }));
  });
  check('dropped player stays on the roster', meta && meta.match && meta.match.roster.length === 5);
  check('dropped player flagged disconnected, not removed',
    meta && meta.match.roster.some((r2) => r2.id === 'p3' && r2.connected === false));

  // ---- Reconnect mid-match ----
  const p3b = mk();
  await new Promise((r) => p3b.on('connect', r));
  const rec = await new Promise((r) => p3b.emit('player:reconnect', { playerId: 'p3' }, r));
  check('reconnect returns PLAYING + match meta', rec && rec.ok && rec.phase === 'PLAYING' && rec.match && rec.match.redScore === 1);
  check('reconnect returns the same team', rec && rec.player && rec.player.team);

  // ---- End + reset ----
  host.emit('host:matchEnd', { winner: 'red', red: 2, blue: 0 });
  await wait(80);
  check('player got m:end with winner', evs.some((e) => e[0] === 'm:end' && e[1] && e[1].winner === 'red'));
  const fin = await new Promise((r) => host.emit('host:auth', {}, r));
  check('phase is FINAL', fin && fin.phase === 'FINAL');
  check('final meta has no score limit', fin && fin.match && fin.match.scoreLimit === undefined);

  // A level match at full time is a draw: no winner.
  host.emit('host:matchEnd', { winner: null, red: 2, blue: 2 });
  await wait(80);
  const drawEnd = evs.filter((e) => e[0] === 'm:end').pop();
  check('a level match ends as a draw', drawEnd && drawEnd[1].winner === null && drawEnd[1].red === 2 && drawEnd[1].blue === 2);

  await new Promise((r) => host.emit('host:reset', {}, r));
  await wait(80);
  check('reset returns to an empty lobby', last() && last().phase === 'LOBBY' && last().total === 0);
  check('reset from a match keeps the limits', last() && last().timeLimitSec === 120);

  players.forEach((p) => p.s.close());
  p3b.close();
  host.close();
  console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
