'use strict';
/* Headless engine tests for Pac-Man Royale.
 * Loads mazes.js + engine.js in a vm sandbox (with a window shim) and asserts
 * maze connectivity, movement, wrap, scoring, ghost/player collisions, and a
 * multi-second NaN-free simulation. Run: node scripts/test-pacman-engine.js
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sandbox = {};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.module = { exports: {} };
sandbox.Math = Math;
sandbox.console = console;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/pacman/js/mazes.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/pacman/js/engine.js'), 'utf8'), sandbox);

const Pacman = sandbox.window.Pacman;
const Mazes = sandbox.window.PacmanMazes;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function section(t) { console.log('\n' + t); }

// ---- Maze connectivity (all mazes) ----
section('Mazes');
function walkable(ch, forGhost) { if (ch === '#') return false; if (ch === '-') return !!forGhost; return true; }
Mazes.forEach((def) => {
  const rows = def.grid; const H = rows.length, W = rows[0].length;
  let rectOk = rows.every((r) => r.length === W);
  ok(rectOk, def.name + ' rectangular');
  // Flood over ghost-walkable (door open) from first walkable.
  let start = null, total = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { if (walkable(rows[r][c], true)) { total++; if (!start) start = [r, c]; } }
  const seen = new Set([start[0] + ',' + start[1]]);
  const st = [start];
  while (st.length) {
    const [r, c] = st.pop();
    const nb = [[r - 1, c], [r + 1, c], [r, (c - 1 + W) % W], [r, (c + 1) % W]];
    for (const [nr, nc] of nb) {
      if (nr < 0 || nr >= H) continue;
      const k = nr + ',' + nc; if (seen.has(k)) continue;
      if (!walkable(rows[nr][nc], true)) continue;
      seen.add(k); st.push([nr, nc]);
    }
  }
  ok(seen.size === total, def.name + ' fully connected (' + seen.size + '/' + total + ')');
  const parsed = Mazes.parse(def);
  ok(parsed.playerSpawns.length === 4, def.name + ' has 4 player spawns');
  ok(parsed.ghostSpawns.length === 4, def.name + ' has 4 ghost spawns');
  ok(parsed.powerPellets.size === 4, def.name + ' has 4 power pellets');
  ok(parsed.pellets.size > 100, def.name + ' has plenty of pellets');
  ok(!!parsed.door, def.name + ' has a door');
});

function makeWorld(n) {
  const roster = [];
  const colors = ['#FFE100', '#3DDC84', '#A96BFF', '#34C6FF'];
  for (let i = 0; i < n; i++) roster.push({ id: 'p' + i, name: 'P' + i, color: colors[i], seat: i });
  const w = new Pacman.World({ rng: () => 0.5 });
  w.setRoster(roster);
  w.reset(0);
  w.frozen = false;
  return w;
}

// ---- Movement (maze-agnostic: derive a corridor from the board) ----
section('Movement');
function openTile(w, r, c) { return w.passable(r, c, { door: false }); }
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  // Find any open tile with an open horizontal neighbour to the right.
  let found = null;
  for (let r = 1; r < w.board.h - 1 && !found; r++) for (let c = 1; c < w.board.w - 2; c++) {
    if (openTile(w, r, c) && openTile(w, r, c + 1)) { found = [r, c]; break; }
  }
  p.y = found[0]; p.x = found[1]; p.dirIdx = -1; p.desired = 3; // move right
  const x0 = p.x;
  for (let i = 0; i < 60; i++) w.step(1 / 120);
  ok(p.x > x0 + 0.9, 'pac moves right along a corridor');
  ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'pac position finite');
}
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  // Find an open tile whose UP neighbour is a wall.
  let found = null;
  for (let r = 2; r < w.board.h - 1 && !found; r++) for (let c = 1; c < w.board.w - 1; c++) {
    if (openTile(w, r, c) && !openTile(w, r - 1, c)) { found = [r, c]; break; }
  }
  p.y = found[0]; p.x = found[1]; p.dirIdx = -1; p.desired = 0; // up into a wall
  for (let i = 0; i < 30; i++) w.step(1 / 120);
  ok(Math.abs(p.y - found[0]) < 0.001, 'pac blocked by a wall stays put');
}
{
  // Facing is preserved: a pac that runs up into a wall keeps facing up.
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  // A one-tile up-stub: up is open, but two-up is a wall (so it moves then stops).
  let found = null;
  for (let r = 3; r < w.board.h - 1 && !found; r++) for (let c = 1; c < w.board.w - 1; c++) {
    if (openTile(w, r, c) && openTile(w, r - 1, c) && !openTile(w, r - 2, c)) { found = [r, c]; break; }
  }
  p.y = found[0]; p.x = found[1]; p.dirIdx = -1; p.desired = 0; p.facing = 1; // start facing DOWN
  for (let i = 0; i < 120; i++) w.step(1 / 120); // travels up, then hits the wall
  ok(p.facing === 0, 'pac keeps facing the way it was going after hitting a wall');
  ok(p.dirIdx === -1, 'blocked pac has no active movement direction');
}

// ---- Wrap tunnel (use a real tunnel row) ----
section('Tunnel wrap');
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  const trow = w.board.tunnelRows.values().next().value;
  p.x = 1; p.y = trow; p.dirIdx = -1; p.desired = 2; // left toward the tunnel
  for (let i = 0; i < 120; i++) w.step(1 / 120);
  ok(p.x > 10, 'pac wraps around the left tunnel to the right side (x=' + p.x.toFixed(1) + ')');
}

// ---- Pellet scoring ----
section('Pellets');
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  const key = w.board.pellets.values().next().value;
  const [r, c] = key.split(',').map(Number);
  p.x = c; p.y = r; p.dirIdx = -1; p.desired = -1;
  const before = w.pelletsLeft();
  w.step(0.001);
  ok((p.score || 0) === Pacman.PELLET_PTS, 'eating a pellet scores 10');
  ok(w.pelletsLeft() === before - 1, 'pellet removed from board');
}

// ---- Power pellet + fright ----
section('Power pellet');
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  const key = w.board.powerPellets.values().next().value;
  const [r, c] = key.split(',').map(Number);
  p.x = c; p.y = r; p.dirIdx = -1; p.desired = -1;
  w.step(0.001);
  ok(p.powered === true, 'power pellet powers the pac');
  ok(w.frightUntil > w.now, 'power pellet frightens ghosts globally');
  ok((p.score || 0) === Pacman.POWER_PTS, 'power pellet scores 50');
}

// ---- Ghost eats unpowered pac ----
section('Ghost vs pac');
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  const g = w.ghosts[0];
  g.state = 'active'; g.x = 5; g.y = 5; g.dirIdx = 2;
  p.x = 5; p.y = 5; p.dirIdx = -1; p.desired = -1; p.powered = false;
  const ev = w.step(0.001);
  ok(p.alive === false, 'ghost eats an unpowered pac');
  ok(ev.deaths.indexOf('p0') >= 0, 'death event fired');
}
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  const g = w.ghosts[0];
  g.state = 'frightened'; g.x = 5; g.y = 5; g.dirIdx = 2;
  w.frightUntil = w.now + 5;
  w.board.pellets.delete('5,5');
  p.x = 5; p.y = 5; p.dirIdx = -1; p.desired = -1; p.powered = true; p.poweredEnd = w.now + 5;
  const ev = w.step(0.001);
  ok(g.state === 'eyes', 'powered pac eats a frightened ghost (→ eyes)');
  ok(ev.ghostsEaten.length === 1 && (p.score || 0) === Pacman.GHOST_BASE_PTS, 'ghost eaten scores the base amount');
  ok(p.alive === true, 'powered pac survives eating a ghost');
}
// Classic Battle-Royale rule: fright applies ONLY to the ghosts on the maze at
// the instant the pellet is eaten. A ghost that becomes active AFTER (just left
// the pen or respawned from eyes) stays NORMAL — it is not retro-frightened.
{
  const w = makeWorld(2);
  const g = w.ghosts[0];
  g.state = 'active'; g.x = 5; g.y = 5; g.dirIdx = 2; // e.g. just left the pen
  w.frightUntil = w.now + 5;                          // a power pellet is active
  w.step(0.001);
  ok(g.state === 'active', 'ghost that goes active mid-power stays normal (not retro-frightened)');
}
// A NORMAL ghost kills a POWERED player — power is not invincibility, only the
// ability to eat the blue ghosts the pellet caught.
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  const g = w.ghosts[0];
  g.state = 'active'; g.x = 5; g.y = 5; g.dirIdx = 2;
  w.frightUntil = w.now + 5;
  w.board.pellets.delete('5,5');
  p.x = 5; p.y = 5; p.dirIdx = -1; p.desired = -1; p.powered = true; p.poweredEnd = w.now + 5;
  const ev = w.step(0.001);
  ok(p.alive === false && ev.deaths.indexOf('p0') >= 0, 'a normal ghost kills a powered player');
  ok(ev.ghostsEaten.length === 0, 'no ghost eaten in that lethal collision');
}
// A ghost leaving the pen while power is active comes out NORMAL (not frightened).
{
  const w = makeWorld(2);
  const door = w.board.door;
  const g = w.ghosts[0];
  g.state = 'leaving'; g.x = door[1]; g.y = door[0] - 1; g.dirIdx = 0; // just above the door
  w.frightUntil = w.now + 5;
  w.step(0.001);
  ok(g.state === 'active', 'ghost leaving the pen during power comes out normal');
}
// An UNPOWERED player must NOT be able to eat a frightened ghost — passes through.
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  const g = w.ghosts[0];
  g.state = 'frightened'; g.x = 5; g.y = 5; g.dirIdx = 2;
  w.frightUntil = w.now + 5;
  w.board.pellets.delete('5,5');
  p.x = 5; p.y = 5; p.dirIdx = -1; p.desired = -1; p.powered = false;
  const ev = w.step(0.001);
  ok(p.alive === true, 'unpowered pac is unharmed by a frightened ghost');
  ok(g.state === 'frightened' && ev.ghostsEaten.length === 0, 'unpowered pac cannot eat a frightened ghost (passes through)');
}

// ---- Eyes always return home ----
section('Eyes return home');
{
  // Every walkable tile in EVERY maze must have a finite path home.
  let allMazesFinite = true;
  for (let mi = 0; mi < Mazes.length; mi++) {
    const w = makeWorld(2); w.reset(mi); w.frozen = false;
    for (let r = 0; r < w.board.h; r++) for (let c = 0; c < w.board.w; c++) {
      if (w.board.tiles[r][c] === 0) continue;
      if (!Number.isFinite(w.board.eyesDist[r][c])) allMazesFinite = false;
    }
  }
  ok(allMazesFinite, 'every walkable tile in every maze has a finite path home');

  const w = makeWorld(2);
  ok(!!w.board.eyesDist, 'eyes flow field computed on reset');
  let far = null, maxd = -1;
  for (let r = 0; r < w.board.h; r++) for (let c = 0; c < w.board.w; c++) {
    if (w.board.tiles[r][c] === 0) continue;
    const d = w.board.eyesDist[r][c];
    if (Number.isFinite(d) && d > maxd) { maxd = d; far = [r, c]; }
  }
  // Drop eyes at the farthest reachable tile and confirm they get to the pen.
  const g = w.ghosts[0];
  g.state = 'eyes'; g.x = far[1]; g.y = far[0]; g.dirIdx = 0; g.home = w.board.ghostSpawns[0];
  let home = false;
  for (let i = 0; i < 120 * 25; i++) { w.step(1 / 120); if (g.state === 'pen') { home = true; break; } }
  ok(home, 'eyes reach the pen from the farthest tile (never stuck)');
}

// ---- Dual pen doors (top + bottom) ----
section('Dual pen doors');
{
  // Every maze now has a TOP and a BOTTOM pen entrance.
  Mazes.forEach((def) => {
    const p = Mazes.parse(def);
    ok(p.doors && p.doors.length === 2, def.name + ' has two pen doors (top + bottom)');
  });

  const w = makeWorld(4); // four ghosts
  const meta = w.board.doorMeta;
  ok(meta.length === 2 && meta.filter((m) => m.isTop).length === 1 && meta.filter((m) => !m.isTop).length === 1,
    'door metadata classifies one top and one bottom door');

  // Ghosts split their exit door by home row → 2 use the top, 2 the bottom.
  let top = 0, bot = 0;
  for (const g of w.ghosts) { if (w._exitDoor(g).isTop) top++; else bot++; }
  ok(top === 2 && bot === 2, 'pen splits evenly: 2 ghosts exit the top door, 2 the bottom');

  // A bottom-assigned ghost actually travels DOWN through the bottom door.
  let botGhost = null;
  for (const g of w.ghosts) { if (!w._exitDoor(g).isTop) { botGhost = g; break; } }
  const bd = w._exitDoor(botGhost);
  botGhost.state = 'leaving'; botGhost.releaseAt = 0;
  botGhost.x = botGhost.home[1]; botGhost.y = botGhost.home[0]; botGhost.dirIdx = 0;
  let exitedBottom = false;
  for (let i = 0; i < 120 * 8; i++) {
    w.step(1 / 120);
    if (Math.round(botGhost.y) === bd.outsideR && Math.round(botGhost.x) === bd.c) exitedBottom = true;
    if (botGhost.state === 'active') break;
  }
  ok(exitedBottom, 'a bottom-door ghost leaves downward through the bottom door');

  // Eyes dropped just below the bottom door return home through it.
  const w2 = makeWorld(2);
  const bm = w2.board.doorMeta.filter((m) => !m.isTop)[0];
  const g2 = w2.ghosts[0];
  g2.state = 'eyes'; g2.x = bm.c; g2.y = bm.outsideR; g2.dirIdx = 0; g2.home = w2.board.ghostSpawns[0];
  let back = false;
  for (let i = 0; i < 120 * 15; i++) { w2.step(1 / 120); if (g2.state === 'pen') { back = true; break; } }
  ok(back, 'eyes return home through the bottom door');
}

// ---- Pac vs pac ----
section('Pac vs pac');
{
  const w = makeWorld(2);
  const a = w.byId.get('p0'), b = w.byId.get('p1');
  w.board.pellets.delete('5,5');
  a.x = 5; a.y = 5; a.dirIdx = -1; a.desired = -1; a.powered = true; a.poweredEnd = w.now + 5;
  b.x = 5; b.y = 5; b.dirIdx = -1; b.desired = -1; b.powered = false;
  const ev = w.step(0.001);
  ok(b.alive === false && a.alive === true, 'powered pac eats an unpowered pac');
  ok((a.score || 0) === Pacman.EAT_PLAYER_PTS, 'eating a player scores 200');
  ok(ev.playerKills.length === 1, 'player kill event fired');
}
{
  const w = makeWorld(2);
  const a = w.byId.get('p0'), b = w.byId.get('p1');
  a.x = 5; a.y = 5; a.dirIdx = 3; a.desired = -1; a.powered = false;
  b.x = 5; b.y = 5; b.dirIdx = 2; b.desired = -1; b.powered = false;
  w.step(0.001);
  ok(a.alive && b.alive, 'equal-size pacs both survive a bump');
  ok(a.knockUntil > w.now && b.knockUntil > w.now, 'equal-size bump knocks both back');
}

// ---- Random power pellets ----
section('Random power pellets');
{
  const w = makeWorld(2);
  ok(w.board.powerPellets.size === 4, 'reset seeds 4 power pellets');
  // The maze corners (fixed 'o') are now ordinary pellets, not power pellets.
  ok(w.board.pellets.has('1,1') || !w.board.powerPellets.has('1,1'), 'corner is not forced to be a power pellet');
  // Eat one power pellet → count drops and a respawn is scheduled.
  const key = w.board.powerPellets.values().next().value;
  const [r, c] = key.split(',').map(Number);
  const p = w.byId.get('p0');
  p.x = c; p.y = r; p.dirIdx = -1; p.desired = -1;
  w.step(0.001);
  ok(w.board.powerPellets.size === 3, 'eating a power pellet removes it');
  ok(w.powerRespawns.length === 1, 'a replacement is scheduled');
  // Advance past the respawn window → back to a full complement.
  for (let i = 0; i < 120 * 7; i++) { p.desired = -1; p.dirIdx = -1; w.step(1 / 120); }
  ok(w.board.powerPellets.size === 4, 'power pellet respawns elsewhere on the map');
}

// ---- Eating a power pellet WHILE already powered ----
section('Power pellet while already powered');
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  p.powered = true; p.poweredEnd = 5.0; // already powered with a fixed timer
  const key = w.board.powerPellets.values().next().value;
  const [r, c] = key.split(',').map(Number);
  const scoreBefore = p.score || 0;
  p.x = c; p.y = r; p.dirIdx = -1; p.desired = -1;
  const ev = w.step(0.001);
  ok(p.poweredEnd === 5.0, 'eating a power pellet while powered does NOT extend the timer');
  ok((p.score || 0) === scoreBefore + Pacman.POWER_PTS, 'the consumed power pellet still scores');
  ok(ev.powerEaten.length === 0, 'no fresh power-up event for an already-powered player');
  ok(!w.board.powerPellets.has(key), 'the power pellet is consumed');
}

// ---- Fruit attribution (for the Sweet Tooth award) ----
section('Fruit attribution');
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  w.fruit = { r: 5, c: 5, until: w.now + 5 };
  w.board.pellets.delete('5,5');
  p.x = 5; p.y = 5; p.dirIdx = -1; p.desired = -1;
  const ev = w.step(0.001);
  ok(ev.fruitEaten === true && ev.fruitBy === 'p0', 'eating fruit reports the eater (fruitBy)');
  ok(!w.fruit, 'fruit is consumed');
}

// ---- Board refill (cleared board keeps the round going) ----
section('Board refill');
{
  const w = makeWorld(2);
  ok(w.board.pellets.size > 100, 'board starts full of pellets');
  w.board.pellets.clear();               // simulate the whole board being eaten
  const ev = w.step(0.001);
  ok(ev.boardCleared === true, 'clearing the board fires boardCleared');
  ok(w.board.pellets.size > 100, 'board refills with pellets instead of ending the round');
}

// ---- Death animation state ----
section('Death animation');
{
  const w = makeWorld(2);
  const p = w.byId.get('p0');
  const g = w.ghosts[0];
  g.state = 'active'; g.x = 5; g.y = 5; g.dirIdx = 2;
  p.x = 5; p.y = 5; p.dirIdx = -1; p.desired = -1; p.powered = false;
  w.step(0.001);
  ok(p.alive === false && p.dying != null, 'death sets a dying timestamp');
  ok(w.anyDying() === true, 'anyDying true right after a death');
  const settleFrames = Math.ceil(Pacman.DEATH_ANIM_SEC * 120) + 30;
  for (let i = 0; i < settleFrames; i++) w.step(1 / 120);
  ok(w.anyDying() === false, 'anyDying false after the animation finishes');
}

// ---- Settle freeze (guarantees a round winner) ----
section('Settle freeze');
{
  const w = makeWorld(3);
  const g = w.ghosts[0]; g.state = 'active'; g.x = 5; g.y = 5; g.dirIdx = 2;
  const victim = w.byId.get('p0'); victim.x = 5; victim.y = 5; victim.dirIdx = -1; victim.desired = -1; victim.powered = false;
  w.step(0.001); // p0 dies
  w.settleFreeze = true;
  const surv = w.byId.get('p1'); surv.x = 10; surv.y = 11; surv.dirIdx = 3; surv.desired = 3;
  const gx = g.x, gy = g.y, sx = surv.x, now0 = w.now, anim0 = w.animClock;
  for (let i = 0; i < 60; i++) w.step(1 / 120);
  ok(w.now > now0 + 0.4, 'settleFreeze still advances the clock');
  ok(w.animClock === anim0, 'settleFreeze freezes the cosmetic clock (power aura/flash)');
  ok(g.x === gx && g.y === gy && surv.x === sx, 'settleFreeze halts all movement');
  ok(surv.alive === true, 'no new deaths while settling');
}

// ---- Round-end helpers + NaN-free long sim ----
section('Simulation');
{
  const w = makeWorld(4);
  let finite = true;
  const rnd = () => (Math.random() * 4) | 0;
  for (let i = 0; i < 1440; i++) { // ~12s
    if (i % 30 === 0) for (const p of w.players) if (p.alive) w.setDesiredDir(p.id, rnd());
    w.step(1 / 120);
    for (const p of w.players) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) finite = false;
    for (const g of w.ghosts) if (!Number.isFinite(g.x) || !Number.isFinite(g.y)) finite = false;
  }
  ok(finite, '12s sim keeps all positions finite (no NaN)');
  ok(w.aliveCount() <= 4 && w.aliveCount() >= 0, 'aliveCount in range');
  ok(w.pelletsLeft() < w.board.pellets.size + w.board.powerPellets.size + 999, 'pelletsLeft works');
  let ghostsOut = w.ghosts.some((g) => g.state === 'active' || g.state === 'frightened' || g.state === 'eyes');
  ok(ghostsOut, 'ghosts leave the pen and roam');
}

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ ' + fail + ' FAILED') + '  (' + pass + ' passed)');
process.exit(fail === 0 ? 0 : 1);
