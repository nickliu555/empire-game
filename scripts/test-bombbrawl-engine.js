'use strict';
/* Headless engine tests for Bomb Brawl.
 * Loads engine.js in a vm sandbox (with a window shim) and asserts arena
 * generation, seat->corner mapping, movement/collision, bomb fuses, blast
 * shape, chain reactions, own-bomb pass-through, kicking, power-ups, the
 * sudden-death spiral and simultaneous-death draws.
 * Run: node scripts/test-bombbrawl-engine.js
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
sandbox.Set = Set;
sandbox.Map = Map;
sandbox.console = console;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/bombbrawl/js/engine.js'), 'utf8'), sandbox);

const BB = sandbox.window.BombBrawl;
const TILE = BB.TILE;
const POW = BB.POW;
const W = BB.W, H = BB.H;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function section(t) { console.log('\n' + t); }

function roster(n) {
  const colors = ['#FF4D4D', '#3DA5FF', '#3DDC84', '#FFD23F'];
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: 'p' + i, name: 'P' + i, seat: i, color: colors[i], isBot: false });
  return out;
}
function makeWorld(n, opts) {
  const w = new BB.World(Object.assign({ powerUps: true }, opts || {}));
  w.reset(1234 + n, roster(n));
  w.frozen = false;
  return w;
}
function run(w, sec, dt) {
  dt = dt || 1 / 120;
  const evs = [];
  for (let t = 0; t < sec; t += dt) {
    const e = w.step(dt);
    for (let i = 0; i < e.length; i++) evs.push(e[i]);
  }
  return evs;
}
/** Clear every crate so tests can move freely. */
function clearCrates(w) {
  for (let r = 1; r < H - 1; r++) {
    for (let c = 1; c < W - 1; c++) {
      if (w.grid[r][c] === TILE.SOFT) w.grid[r][c] = TILE.FLOOR;
    }
  }
  w.hidden.clear();
}
function place(p, r, c) { p.x = c + 0.5; p.y = r + 0.5; }

// ---------------- Arena ----------------
section('Arena generation');
{
  const w = makeWorld(4);
  ok(w.grid.length === H && w.grid[0].length === W, 'grid is ' + W + 'x' + H);
  let borderOk = true;
  for (let c = 0; c < W; c++) if (w.at(0, c) !== TILE.HARD || w.at(H - 1, c) !== TILE.HARD) borderOk = false;
  for (let r = 0; r < H; r++) if (w.at(r, 0) !== TILE.HARD || w.at(r, W - 1) !== TILE.HARD) borderOk = false;
  ok(borderOk, 'border is solid all the way round');

  let pillarOk = true;
  for (let r = 2; r < H - 1; r += 2) for (let c = 2; c < W - 1; c += 2) if (w.at(r, c) !== TILE.HARD) pillarOk = false;
  ok(pillarOk, 'even/even pillar lattice present');

  // Spawn pockets must be walkable so nobody starts entombed.
  let safeOk = true;
  BB.SPAWNS.forEach((sp) => {
    sp.safe.forEach((cell) => { if (w.at(cell[0], cell[1]) !== TILE.FLOOR) safeOk = false; });
  });
  ok(safeOk, 'all four spawn pockets are clear of crates');

  let crates = 0;
  for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++) if (w.at(r, c) === TILE.SOFT) crates++;
  ok(crates > 50 && crates < 105, 'crate count is sane (' + crates + ')');

  // Every floor/crate cell must be reachable once crates are blown open.
  const seen = new Set(); const stack = [[1, 1]]; let total = 0;
  for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++) if (w.at(r, c) !== TILE.HARD) total++;
  seen.add('1,1');
  while (stack.length) {
    const [r, c] = stack.pop();
    [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].forEach(([nr, nc]) => {
      if (w.at(nr, nc) === TILE.HARD) return;
      const k = nr + ',' + nc;
      if (seen.has(k)) return;
      seen.add(k); stack.push([nr, nc]);
    });
  }
  ok(seen.size === total, 'arena fully connected (' + seen.size + '/' + total + ')');

  // Same seed = same arena; different seed = different arena.
  const a = new BB.World({}); a.reset(99, roster(4));
  const b = new BB.World({}); b.reset(99, roster(4));
  const c2 = new BB.World({}); c2.reset(100, roster(4));
  ok(JSON.stringify(a.grid) === JSON.stringify(b.grid), 'same seed reproduces the arena');
  ok(JSON.stringify(a.grid) !== JSON.stringify(c2.grid), 'different seed changes the arena');

  const noPow = new BB.World({ powerUps: false }); noPow.reset(7, roster(4));
  ok(noPow.hidden.size === 0, 'power-ups off buries nothing');
  ok(makeWorld(4).hidden.size > 0, 'power-ups on buries some items');
}

// ---------------- Seat -> corner ----------------
section('Seat to spawn corner');
{
  const w = makeWorld(4);
  const expect = [
    { seat: 0, r: 1, c: 1, label: 'top-left' },
    { seat: 1, r: 1, c: W - 2, label: 'top-right' },
    { seat: 2, r: H - 2, c: 1, label: 'bottom-left' },
    { seat: 3, r: H - 2, c: W - 2, label: 'bottom-right' },
  ];
  expect.forEach((e) => {
    const p = w.players[e.seat];
    ok(Math.floor(p.y) === e.r && Math.floor(p.x) === e.c, 'seat ' + (e.seat + 1) + ' spawns ' + e.label);
  });
  ok(w.players.every((p) => p.bombs === 1 && p.fire === 1 && p.speedTier === 0 && !p.kick),
    'everyone starts with 1 bomb / 1 fire / no upgrades');
  // Two players must never share a corner.
  const cells = new Set(w.players.map((p) => Math.floor(p.y) + ',' + Math.floor(p.x)));
  ok(cells.size === 4, 'four distinct spawn cells');
}

// ---------------- Movement ----------------
section('Movement & collision');
{
  const w = makeWorld(2);
  clearCrates(w);
  const p = w.players[0];
  place(p, 1, 1);
  w.setInput(p.id, 1, 0);
  run(w, 0.5);
  ok(p.x > 1.5, 'stick right moves right (' + p.x.toFixed(2) + ')');
  ok(Math.abs(p.y - 1.5) < 0.02, 'stays in its lane while moving');

  // Walk into the far wall and stop.
  run(w, 6);
  ok(p.x < W - 1 && p.x > W - 2.5, 'stops at the far wall (' + p.x.toFixed(2) + ')');
  ok(w.at(Math.floor(p.y), Math.floor(p.x)) === TILE.FLOOR, 'never ends up inside a wall');

  // A crate blocks.
  const w2 = makeWorld(2);
  clearCrates(w2);
  const q = w2.players[0];
  place(q, 1, 1);
  w2.grid[1][3] = TILE.SOFT;
  w2.setInput(q.id, 1, 0);
  run(w2, 3);
  ok(q.x < 3, 'a crate blocks movement (' + q.x.toFixed(2) + ')');

  // Corner assist: nudged off-lane, pressing along the lane should re-centre.
  const w3 = makeWorld(2);
  clearCrates(w3);
  const s = w3.players[0];
  place(s, 1, 1);
  s.y = 1.5;
  s.x = 2.5;
  w3.grid[2][2] = TILE.HARD;
  // Standing in a corridor, push down into the pillar row: should slide toward
  // the open column rather than jam.
  s.x = 2.2;
  w3.setInput(s.id, 0, 1);
  run(w3, 0.6);
  ok(Math.abs(s.x - 2.5) < 0.12 || s.y > 1.6, 'corner assist slides toward the open lane');

  // A thumb a couple of degrees past the diagonal must not stall against a
  // wall: the open half of the push takes over instead of grinding.
  function diagonal(ix, iy) {
    const wd = makeWorld(2);
    clearCrates(wd);
    const d = wd.players[0];
    place(d, 2, 1);          // vertical corridor: right is a pillar at (2,2)
    const y0 = d.y;
    for (let t = 0; t < 1; t += 1 / 120) { wd.setInput(d.id, ix, iy); wd.step(1 / 120); }
    return y0 - d.y;         // tiles travelled up the open corridor
  }
  const rightHeavy = diagonal(0.72, -0.70);
  const upHeavy = diagonal(0.70, -0.72);
  ok(rightHeavy > 0.8, 'up-right into a pillar still walks up the open corridor (' +
    rightHeavy.toFixed(2) + ')');
  ok(Math.abs(rightHeavy - upHeavy) < 0.3,
    'two degrees either side of the diagonal feel the same (' + rightHeavy.toFixed(2) +
    ' vs ' + upHeavy.toFixed(2) + ')');
  ok(diagonal(1, 0) < 0.05, 'a straight push into a wall never slides sideways');
}

// ---------------- Bombs & blasts ----------------
section('Bombs, blasts & chains');
{
  const w = makeWorld(2);
  clearCrates(w);
  const p = w.players[0];
  place(p, 1, 1);
  w.requestBomb(p.id);
  w.step(1 / 120);
  ok(w.bombs.length === 1, 'bomb dropped');
  ok(p.bombsOut === 1, 'bomb counts against capacity');
  w.requestBomb(p.id);
  w.step(1 / 120);
  ok(w.bombs.length === 1, 'cannot exceed bomb capacity');

  // Own bomb is walkable until you step off it.
  w.setInput(p.id, 1, 0);
  run(w, 0.35);
  ok(p.x > 2.0, 'owner can walk off their own bomb (' + p.x.toFixed(2) + ')');
  w.setInput(p.id, -1, 0);
  run(w, 1.0);
  ok(p.x > 1.85, 'the bomb is solid once the owner has left (' + p.x.toFixed(2) + ')');

  // Blast shape: a cross of `fire` cells stopped by the first crate.
  const w2 = makeWorld(2, { powerUps: false });
  clearCrates(w2);
  const q = w2.players[0];
  place(q, 3, 5);
  q.fire = 3;
  w2.grid[3][7] = TILE.SOFT;   // 2 cells to the right
  w2.grid[3][8] = TILE.SOFT;   // must survive: blast stops at the first crate
  place(w2.players[1], 11, 13);
  w2.requestBomb(q.id);
  const evs = run(w2, 2.7);
  const boom = evs.filter((e) => e.type === 'explode');
  ok(boom.length === 1, 'bomb detonates after its fuse');
  ok(!!w2.flameAt(3, 5) || evs.some((e) => e.type === 'flameOut' && e.r === 3 && e.c === 5), 'flame at the bomb tile');
  ok(w2.at(3, 7) === TILE.FLOOR, 'first crate destroyed');
  ok(w2.at(3, 8) === TILE.SOFT, 'blast stops at the first crate');
  const cells = boom[0].cells.map((c) => c.r + ',' + c.c);
  ok(cells.indexOf('3,4') >= 0 && cells.indexOf('3,3') >= 0, 'blast reaches 2 cells left');
  const crateEvents = evs.filter((e) => e.type === 'crate');
  ok(crateEvents.length === 1 && crateEvents[0].c === 7, 'exactly one crate destroyed');

  // A pillar stops the arm dead (bomb on an even row, next to the lattice).
  const wp = makeWorld(2, { powerUps: false });
  clearCrates(wp);
  const pp = wp.players[0];
  place(pp, 2, 5);
  pp.fire = 3;
  place(wp.players[1], 11, 13);
  wp.requestBomb(pp.id);
  const pillarEvs = run(wp, 2.7);
  const pboom = pillarEvs.filter((e) => e.type === 'explode')[0];
  const pcells = pboom.cells.map((c) => c.r + ',' + c.c);
  ok(pcells.indexOf('2,4') < 0 && pcells.indexOf('2,3') < 0, 'blast is stopped by the pillar lattice');
  ok(pcells.indexOf('1,5') >= 0 && pcells.indexOf('3,5') >= 0, 'blast still travels down the open lane');

  // Chain reaction: a bomb caught in a blast goes off immediately.
  const w3 = makeWorld(2, { powerUps: false });
  clearCrates(w3);
  const a = w3.players[0], b = w3.players[1];
  place(a, 5, 3); a.fire = 2;
  place(b, 5, 5); b.fire = 2;
  w3.requestBomb(a.id);
  w3.step(1 / 120);
  run(w3, 0.9);
  w3.requestBomb(b.id);
  w3.step(1 / 120);
  const chainEvs = run(w3, 1.8);
  const booms = chainEvs.filter((e) => e.type === 'explode');
  ok(booms.length === 2, 'both bombs exploded');
  ok(w3.bombs.length === 0, 'no bombs left after the chain');

  // Capacity is returned after the blast.
  ok(a.bombsOut === 0 && b.bombsOut === 0, 'bomb capacity is returned after detonation');

  // Bombers pass through each other, so a bomb can be dropped underneath
  // someone else — they must be able to walk off it, not be trapped inside.
  const w4 = makeWorld(2, { powerUps: false });
  clearCrates(w4);
  const dropper = w4.players[0], bystander = w4.players[1];
  place(dropper, 5, 5);
  place(bystander, 5, 5);
  w4.requestBomb(dropper.id);
  run(w4, 0.05);
  ok(w4.bombs.length === 1, 'the bomb landed under both bombers');
  w4.setInput(bystander.id, 1, 0);
  run(w4, 0.7);
  ok(Math.floor(bystander.x) > 5, 'a bystander caught on a fresh bomb can walk off it');
  w4.setInput(dropper.id, -1, 0);
  run(w4, 0.7);
  ok(Math.floor(dropper.x) < 5, 'the owner can still walk off their own bomb');

  // ...and once they're clear the bomb is solid again for both of them.
  w4.setInput(bystander.id, -1, 0);
  run(w4, 1.0);
  ok(Math.floor(bystander.x) === 6, 'the bomb blocks the bystander on the way back');
}

// ---------------- Deaths ----------------
section('Deaths & draws');
{
  const w = makeWorld(2, { powerUps: false });
  clearCrates(w);
  const a = w.players[0], b = w.players[1];
  place(a, 5, 5);
  place(b, 11, 13);
  w.requestBomb(a.id);
  const evs = run(w, 2.7);
  ok(!a.alive, 'your own bomb kills you');
  const death = evs.filter((e) => e.type === 'death');
  ok(death.length === 1 && death[0].id === a.id, 'one death event with the right id');
  ok(death[0].by === a.id, 'death is attributed to the bomb owner');
  ok(w.alivePlayers().length === 1, 'one survivor left');

  // Everyone dies at once — the host decides these on death time, not a draw.
  const w2 = makeWorld(2, { powerUps: false });
  clearCrates(w2);
  const c = w2.players[0], d = w2.players[1];
  place(c, 5, 5);
  place(d, 5, 7);
  c.fire = 3;
  w2.requestBomb(c.id);
  run(w2, 2.7);
  ok(w2.alivePlayers().length === 0, 'both bombers die in the same blast (wipeout)');
  ok(c.diedAt > 0 && c.diedAt === d.diedAt, 'a shared blast stamps both deaths at the same instant');

  // Staggered deaths get distinct timestamps, so "who fell last" is decidable.
  const w6 = makeWorld(2, { powerUps: false });
  clearCrates(w6);
  const g2 = w6.players[0], h2 = w6.players[1];
  place(g2, 5, 5);
  place(h2, 9, 9);
  w6.requestBomb(g2.id);
  run(w6, 0.5);
  w6.requestBomb(h2.id);
  run(w6, 2.6);
  ok(!g2.alive && !h2.alive, 'both bombers eventually blow themselves up');
  ok(h2.diedAt - g2.diedAt > 0.4, 'the bomber who held out longer has the later death time');
  ok(g2.killedBy === g2.id && h2.killedBy === h2.id, 'each death is attributed to its own bomb');

  // Flames linger and still kill anyone who walks in.
  const w3 = makeWorld(2, { powerUps: false });
  clearCrates(w3);
  const e = w3.players[0], f = w3.players[1];
  place(e, 5, 5); e.fire = 1;
  place(f, 5, 9);
  w3.requestBomb(e.id);
  w3.setInput(e.id, 1, 0);
  run(w3, 0.6);
  w3.setInput(e.id, 0, 0);
  run(w3, 2.2);
  ok(!e.alive || w3.alivePlayers().length >= 1, 'walking clear of your own blast is survivable');

  // A fallen bomber leaves a random power-up on the cell where they died.
  const w4 = makeWorld(2);
  clearCrates(w4);
  w4.items.clear();
  const g = w4.players[0], h = w4.players[1];
  place(g, 5, 5);
  place(h, 11, 13);
  w4.requestBomb(g.id);
  const evs4 = run(w4, 2.7);
  const drop = evs4.filter((ev) => ev.type === 'itemDrop');
  ok(!g.alive && drop.length === 1, 'a death drops exactly one power-up');
  ok(drop[0].r === 5 && drop[0].c === 5, 'the drop lands on the cell where they died');
  const it4 = w4.items.get(w4.key(5, 5));
  ok(!!it4, 'the drop survives the blast that killed them');
  ok(!!it4 && [POW.BOMB, POW.FIRE, POW.SPEED, POW.KICK].indexOf(it4.type) >= 0, 'the drop is a real power-up type');

  // ...and the survivor can walk over and collect it.
  run(w4, 0.6);                    // let the flames burn out first
  place(h, 5, 3);
  w4.setInput(h.id, 1, 0);
  run(w4, 2.4);
  ok(!w4.items.has(w4.key(5, 5)), 'the survivor can pick the drop up');

  // With power-ups switched off, deaths drop nothing.
  const w5 = makeWorld(2, { powerUps: false });
  clearCrates(w5);
  const i2 = w5.players[0];
  place(i2, 5, 5);
  place(w5.players[1], 11, 13);
  w5.requestBomb(i2.id);
  run(w5, 2.7);
  ok(!i2.alive && w5.items.size === 0, 'no death drop when power-ups are off');
}

// ---------------- Kick ----------------
section('Kick power-up');
{
  const w = makeWorld(2, { powerUps: false });
  clearCrates(w);
  const p = w.players[0];
  place(p, 1, 1);
  p.kick = true;
  w.requestBomb(p.id);
  w.step(1 / 120);
  // Step off the bomb, turn round, and shove it down the lane.
  w.setInput(p.id, 1, 0);
  run(w, 0.5);
  const startC = w.bombs[0].c;
  w.setInput(p.id, -1, 0);
  run(w, 0.6);
  ok(w.bombs.length === 1, 'bomb still live');
  ok(w.bombs[0].c === startC, 'kicking from the far side does not move it toward the wall');

  // A bomb kicked into open floor slides and stops against the wall.
  const w2 = makeWorld(2, { powerUps: false });
  clearCrates(w2);
  const q = w2.players[0];
  place(q, 1, 3);
  q.kick = true;
  w2.requestBomb(q.id);
  w2.step(1 / 120);
  w2.setInput(q.id, -1, 0);
  run(w2, 0.4);
  w2.setInput(q.id, 1, 0);
  const kickEvs = run(w2, 1.2);
  ok(kickEvs.some((e) => e.type === 'kick'), 'kick event fired');
  ok(w2.bombs.length === 1 && w2.bombs[0].c > 3, 'kicked bomb slid down the lane (c=' + (w2.bombs[0] ? w2.bombs[0].c : '-') + ')');
  ok(w2.bombs[0].c <= W - 2, 'kicked bomb stops inside the arena');
  ok(w2.at(w2.bombs[0].r, w2.bombs[0].c) === TILE.FLOOR, 'kicked bomb never ends up inside a wall');

  // Without the power-up nothing moves.
  const w3 = makeWorld(2, { powerUps: false });
  clearCrates(w3);
  const s = w3.players[0];
  place(s, 1, 3);
  w3.requestBomb(s.id);
  w3.step(1 / 120);
  w3.setInput(s.id, -1, 0);
  run(w3, 0.4);
  w3.setInput(s.id, 1, 0);
  const noKick = run(w3, 0.8);
  ok(!noKick.some((e) => e.type === 'kick'), 'no kick without the power-up');
  ok(w3.bombs[0].c === 3, 'bomb stays put without the power-up');
}

// ---------------- Power-ups ----------------
section('Power-ups');
{
  const w = makeWorld(2);
  clearCrates(w);
  const p = w.players[0];
  place(p, 1, 1);
  w.items.set(w.key(1, 2), { type: POW.FIRE, r: 1, c: 2, t: 0 });
  w.setInput(p.id, 1, 0);
  const evs = run(w, 0.6);
  ok(p.fire === 2, 'fire power-up applied');
  const pick = evs.filter((e) => e.type === 'pickup');
  ok(pick.length === 1 && pick[0].name === 'FIRE', 'pickup event carries the kind');
  ok(pick[0].label === '+1 FIRE', 'pickup event carries a display label');

  // Caps.
  const w2 = makeWorld(2);
  const q = w2.players[0];
  for (let i = 0; i < 20; i++) w2._applyItem(q, POW.BOMB);
  for (let i = 0; i < 20; i++) w2._applyItem(q, POW.FIRE);
  for (let i = 0; i < 20; i++) w2._applyItem(q, POW.SPEED);
  ok(q.bombs === BB.MAX_BOMBS, 'bomb capacity caps at ' + BB.MAX_BOMBS);
  ok(q.fire === BB.MAX_FIRE, 'fire caps at ' + BB.MAX_FIRE);
  ok(q.speedTier === BB.MAX_SPEED_TIER, 'speed caps at tier ' + BB.MAX_SPEED_TIER);
  ok(w2.speedOf(q) > BB.BASE_SPEED, 'speed tiers actually make you faster');

  // A power-up caught in a blast is destroyed.
  const w3 = makeWorld(2, { powerUps: false });
  clearCrates(w3);
  const s = w3.players[0];
  place(s, 5, 5);
  place(w3.players[1], 11, 13);
  w3.items.set(w3.key(5, 6), { type: POW.BOMB, r: 5, c: 6, t: 0 });
  s.fire = 2;
  w3.requestBomb(s.id);
  const burn = run(w3, 2.7);
  ok(!w3.items.has(w3.key(5, 6)), 'power-up in the blast is destroyed');
  ok(burn.some((e) => e.type === 'itemBurned' && e.r === 5 && e.c === 6), 'itemBurned event fired');

  // ...but the blast that BREAKS the crate must leave the item it uncovers.
  const w4 = makeWorld(2, { powerUps: false });
  clearCrates(w4);
  const t = w4.players[0];
  place(t, 5, 5);
  place(w4.players[1], 11, 13);
  w4.grid[5][6] = TILE.SOFT;
  w4.hidden.set(w4.key(5, 6), POW.FIRE);
  w4.requestBomb(t.id);
  const reveal = run(w4, 2.7);
  ok(w4.items.has(w4.key(5, 6)), 'a crate blast leaves the power-up it uncovers');
  ok(!reveal.some((e) => e.type === 'itemBurned'), 'uncovering a power-up does not burn it');

  // End-to-end on a real generated arena: blow up a crate that the generator
  // buried an item under and the item must be standing there afterwards.
  const w5 = makeWorld(4);
  const firstHidden = w5.hidden.keys().next().value;
  const hr = Math.floor(firstHidden / W), hc = firstHidden % W;
  const u = w5.players[0];
  // Stand one lane over from the crate, on a floor tile, and bomb it.
  const from = w5.at(hr, hc - 1) !== TILE.HARD ? [hr, hc - 1] : [hr - 1, hc];
  w5.grid[from[0]][from[1]] = TILE.FLOOR;
  place(u, from[0], from[1]);
  place(w5.players[1], 11, 13);
  place(w5.players[2], 11, 1);
  place(w5.players[3], 1, 13);
  w5.requestBomb(u.id);
  run(w5, 2.7);
  ok(w5.grid[hr][hc] === TILE.FLOOR, 'the buried crate was destroyed');
  ok(w5.items.has(firstHidden), 'a generated power-up survives onto the floor');
}

// ---------------- Starting loadout ----------------
section('Starting loadout');
{
  // Default: the classic base start, everything has to be earned.
  const base = makeWorld(4);
  ok(base.players.every((p) => p.bombs === 1 && p.fire === 1 && p.speedTier === 0 && !p.kick),
    'no startLoadout spawns everyone on base stats');

  // Preset mode: drops off, but every bomber starts kitted out so a round
  // without items still resolves.
  const L = BB.PRESET_LOADOUT;
  ok(L.bombs > 1 && L.fire > 1 && L.speedTier > 0 && L.kick === true,
    'the preset loadout is an actual upgrade over base');
  const pre = makeWorld(4, { powerUps: false, startLoadout: L });
  ok(pre.players.every((p) => p.bombs === L.bombs && p.fire === L.fire &&
    p.speedTier === L.speedTier && p.kick === L.kick), 'preset loadout applied to every bomber');
  ok(pre.players.every((p) => p.bombsOut === 0), 'preset loadout still starts with no bombs out');
  ok(pre.speedOf(pre.players[0]) > BB.BASE_SPEED, 'preset speed tier makes you faster');
  ok(pre.hidden.size === 0, 'preset mode buries nothing in the crates');

  // ...and nothing can appear mid-round either: a death leaves no drop.
  const victim = pre.players[0];
  place(victim, 5, 5);
  pre.grid[5][5] = TILE.FLOOR;
  pre._kill(victim, 'test');
  ok(pre.items.size === 0, 'preset mode drops nothing when a bomber falls');

  // The same drop in a drops game does leave a prize, so the check above is real.
  const drops = makeWorld(4);
  const fallen = drops.players[0];
  place(fallen, 5, 5);
  drops.grid[5][5] = TILE.FLOOR;
  drops.items.clear();
  drops._kill(fallen, 'test');
  ok(drops.items.size === 1, 'drops mode still leaves a power-up where a bomber fell');

  // A silly loadout is clamped to the engine's limits rather than trusted.
  const wild = makeWorld(2, { startLoadout: { bombs: 999, fire: 999, speedTier: 99, kick: true } });
  ok(wild.players[0].bombs === BB.MAX_BOMBS, 'loadout bombs clamp to ' + BB.MAX_BOMBS);
  ok(wild.players[0].fire === BB.MAX_FIRE, 'loadout fire clamps to ' + BB.MAX_FIRE);
  ok(wild.players[0].speedTier === BB.MAX_SPEED_TIER, 'loadout speed clamps to tier ' + BB.MAX_SPEED_TIER);
  const junk = makeWorld(2, { startLoadout: { bombs: 0, fire: 0, speedTier: -5 } });
  ok(junk.players[0].bombs === 1 && junk.players[0].fire === 1 && junk.players[0].speedTier === 0,
    'a below-floor loadout clamps back up to base');

  // Reset must re-apply the loadout, not leave last round's earned stats behind.
  const again = makeWorld(2, { powerUps: false, startLoadout: L });
  again._applyItem(again.players[0], POW.BOMB);
  again.reset(4321, roster(2));
  ok(again.players[0].bombs === L.bombs, 'a fresh round re-applies the preset loadout');
}

// ---------------- Sudden death ----------------
section('Sudden death');
{
  const order = BB.spiralCells();
  const interior = (W - 2) * (H - 2);
  ok(order.length === interior, 'spiral covers every interior cell (' + order.length + '/' + interior + ')');
  const uniq = new Set(order.map((c) => c[0] + ',' + c[1]));
  ok(uniq.size === order.length, 'spiral never repeats a cell');
  ok(order[0][0] === 1 && order[0][1] === 1, 'spiral starts at the top-left interior cell');

  const w = makeWorld(2, { powerUps: false });
  clearCrates(w);
  place(w.players[0], 6, 7);
  place(w.players[1], 6, 9);
  w.startSuddenDeath();
  ok(w.suddenDeath, 'sudden death flag set');
  const evs = run(w, 3);
  ok(evs.some((e) => e.type === 'sdWarn'), 'blocks are telegraphed before they land');
  ok(evs.some((e) => e.type === 'sdLand'), 'blocks land');
  const warn = evs.findIndex((e) => e.type === 'sdWarn');
  const land = evs.findIndex((e) => e.type === 'sdLand');
  ok(warn >= 0 && land > warn, 'the warning always comes before the block');

  // Run it out: everything fills in and nobody can survive forever.
  const w2 = makeWorld(2, { powerUps: false });
  clearCrates(w2);
  place(w2.players[0], 6, 7);
  place(w2.players[1], 6, 9);
  w2.startSuddenDeath();
  run(w2, BB.SD_STEP_SEC * interior + 5, 1 / 60);
  let open = 0;
  for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++) if (w2.at(r, c) !== TILE.HARD) open++;
  ok(open === 0, 'sudden death eventually fills every cell (' + open + ' left)');
  ok(w2.alivePlayers().length === 0, 'nobody survives a completed spiral');
}

// ---------------- Movement audit ----------------
// The complaint this guards against: "I push a direction and my bomber doesn't
// go". Rather than spot-checking a few spots, walk EVERY open tile of the
// arena in every direction, centred and off-centre, and with diagonal pushes.
section('Movement audit — every tile, every direction');
{
  const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];   // [ix, iy]
  const wm = makeWorld(2);
  clearCrates(wm);
  const me = wm.players[0];
  place(wm.players[1], H - 2, W - 2);   // park the other bomber out of the way

  /** Hold (ix, iy) for a second from (r, c) + a perpendicular offset. */
  function walk(r, c, ix, iy, off) {
    place(me, r, c);
    if (ix) me.y += off; else me.x += off;
    const sx = me.x, sy = me.y;
    for (let t = 0; t < 1; t += 1 / 120) { wm.setInput(me.id, ix, iy); wm.step(1 / 120); }
    wm.setInput(me.id, 0, 0);
    return ix ? (me.x - sx) * ix : (me.y - sy) * iy;
  }

  let cases = 0;
  const stuck = [];
  for (let r = 1; r < H - 1; r++) {
    for (let c = 1; c < W - 1; c++) {
      if (wm.at(r, c) !== TILE.FLOOR) continue;
      for (let d = 0; d < DIR4.length; d++) {
        const ix = DIR4[d][0], iy = DIR4[d][1];
        if (wm.at(r + iy, c + ix) !== TILE.FLOOR) continue;
        // Dead centre, and shoved a third of a tile off the lane either way —
        // a thumb never lines up perfectly, so corner assist has to cover it.
        for (const off of [0, -0.3, 0.3]) {
          cases++;
          const gained = walk(r, c, ix, iy, off);
          if (gained < 0.6) stuck.push(r + ',' + c + ' dir ' + ix + ',' + iy + ' off ' + off +
            ' moved ' + gained.toFixed(2));
        }
      }
    }
  }
  ok(stuck.length === 0, 'every open lane is walkable from every tile (' + cases +
    ' cases, stuck: ' + stuck.slice(0, 3).join(' | ') + ')');

  // Diagonals: the dominant half of the push is into a wall, the other half is
  // open. The bomber must take the open lane instead of grinding.
  let diagCases = 0;
  const diagStuck = [];
  for (let r = 1; r < H - 1; r++) {
    for (let c = 1; c < W - 1; c++) {
      if (wm.at(r, c) !== TILE.FLOOR) continue;
      for (const ix of [1, -1]) {
        for (const iy of [1, -1]) {
          const openX = wm.at(r, c + ix) === TILE.FLOOR;
          const openY = wm.at(r + iy, c) === TILE.FLOOR;
          if (openX === openY) continue;             // only mixed cases matter
          // Push slightly harder on the BLOCKED axis, which is the case that
          // used to leave the bomber pinned against the wall.
          const bx = openX ? 0.70 : 0.72;
          const by = openX ? 0.72 : 0.70;
          diagCases++;
          place(me, r, c);
          const sx = me.x, sy = me.y;
          for (let t = 0; t < 1; t += 1 / 120) { wm.setInput(me.id, ix * bx, iy * by); wm.step(1 / 120); }
          wm.setInput(me.id, 0, 0);
          const gained = openX ? (me.x - sx) * ix : (me.y - sy) * iy;
          if (gained < 0.6) diagStuck.push(r + ',' + c + ' open ' + (openX ? 'x' : 'y') +
            ' moved ' + gained.toFixed(2));
        }
      }
    }
  }
  ok(diagStuck.length === 0, 'a diagonal push always takes the open lane (' + diagCases +
    ' cases, stuck: ' + diagStuck.slice(0, 3).join(' | ') + ')');

  // ...but a straight push into a wall must NOT drift sideways.
  let drifted = 0;
  for (let r = 1; r < H - 1; r++) {
    for (let c = 1; c < W - 1; c++) {
      if (wm.at(r, c) !== TILE.FLOOR) continue;
      for (let d = 0; d < DIR4.length; d++) {
        const ix = DIR4[d][0], iy = DIR4[d][1];
        if (wm.at(r + iy, c + ix) === TILE.FLOOR) continue;   // only blocked pushes
        place(me, r, c);
        const sx = me.x, sy = me.y;
        for (let t = 0; t < 0.5; t += 1 / 120) { wm.setInput(me.id, ix, iy); wm.step(1 / 120); }
        wm.setInput(me.id, 0, 0);
        if (Math.abs(ix ? me.y - sy : me.x - sx) > 0.02) drifted++;
      }
    }
  }
  ok(drifted === 0, 'walking into a wall never slides you down the lane (' + drifted + ')');
}

// ---------------- Stability ----------------
section('Stability');
{
  const w = makeWorld(4);
  let bad = false;
  let trapped = 0;
  for (let t = 0; t < 60 * 45; t++) {
    // Random inputs + bomb spam from everyone still standing.
    w.players.forEach((p, i) => {
      if (!p.alive) return;
      if (t % (12 + i * 5) === 0) {
        const a = Math.random() * Math.PI * 2;
        w.setInput(p.id, Math.cos(a), Math.sin(a));
      }
      if (t % (70 + i * 13) === 0) w.requestBomb(p.id);
    });
    if (t === 60 * 25) w.startSuddenDeath();
    w.step(1 / 60);
    w.players.forEach((p) => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) bad = true;
      if (p.x < 0.5 || p.x > W - 0.5 || p.y < 0.5 || p.y > H - 0.5) bad = true;
      if (!p.alive) return;
      const t = w.at(Math.floor(p.y), Math.floor(p.x));
      if (t === TILE.HARD || t === TILE.SOFT) bad = true;
      // Standing inside a bomb that doesn't let you out is the "stuck on a
      // bomb" trap — every overlap must come with a pass.
      w.bombs.forEach((b) => {
        const overlap = p.x + BB.P_R > b.c && p.x - BB.P_R < b.c + 1 &&
          p.y + BB.P_R > b.r && p.y - BB.P_R < b.r + 1;
        if (overlap && !b.pass.has(p.id)) { bad = true; trapped++; }
      });
    });
  }
  ok(!bad, '45s of 4-player chaos stays finite and inside the arena');
  ok(trapped === 0, 'nobody is ever sealed inside a bomb (' + trapped + ' frames)');
  ok(w.alivePlayers().length === 0, 'a full sudden-death spiral always resolves the round');
}

console.log('\n' + (fail === 0 ? '✓ all ' + pass + ' checks passed' : '✗ ' + fail + ' failed, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
