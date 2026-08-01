'use strict';
// Bomb Brawl CPU sanity harness: runs full headless rounds of bots against each
// other and asserts they behave like players rather than lemmings.
//
// The failure this guards against: a bot that drops a bomb and then stands on
// its own fuse, which makes every round end in a mutual draw within seconds.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { console: console, Math: seededMath(), Set: Set, Map: Map, Float32Array: Float32Array, Int16Array: Int16Array };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['engine.js', 'bot.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'bombbrawl', 'js', f), 'utf8');
  vm.runInContext(src, sandbox, { filename: f });
}
const BB = sandbox.BombBrawl;
const AI = sandbox.BombBrawlBot;

/**
 * Bots roll Math.random() for blunders and bomb eagerness, so an unseeded
 * harness gives a different verdict every run — which makes a "never blows
 * itself up" assertion meaningless. Swap in a seeded generator inside the
 * sandbox and reseed it per trial.
 */
let rngState = 1;
function seededMath() {
  const m = Object.create(Math);
  m.random = function () {
    rngState = (rngState + 0x6D2B79F5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return m;
}
function seed(n) { rngState = n >>> 0; }

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name + (extra ? '  (' + extra + ')' : ''));
  if (!cond) failures++;
}
function section(t) { console.log('\n' + t); }

const DT = 1 / 60;
const SD_AT = 30;   // host.js starts sudden death 30s into a round

/** Play one round to completion (or timeout). Returns per-bot survival stats. */
function playRound(seed_, n, difficulty, maxSec) {
  seed(seed_);
  const roster = [];
  for (let i = 0; i < n; i++) roster.push({ id: 'b' + i, name: 'CPU ' + i, seat: i, color: '#fff', isBot: true });
  const world = new BB.World();
  world.reset(seed_, roster);
  world.frozen = false;
  const bots = roster.map((r) => new AI.Bot(r.id, difficulty));

  const deaths = {};        // id -> time of death
  let bombsDropped = 0;
  let cratesBroken = 0;
  let t = 0;
  let sdStarted = false;
  while (t < maxSec) {
    for (let i = 0; i < bots.length; i++) bots[i].update(world, DT);
    const evs = world.step(DT);
    for (let i = 0; i < evs.length; i++) {
      if (evs[i].type === 'bomb') bombsDropped++;
      else if (evs[i].type === 'crate') cratesBroken++;
      else if (evs[i].type === 'death') deaths[evs[i].id] = t;
    }
    t += DT;
    if (!sdStarted && t > SD_AT) { world.startSuddenDeath(); sdStarted = true; }
    if (world.alivePlayers().length <= 1) break;
  }
  const alive = world.alivePlayers();
  const times = roster.map((r) => (deaths[r.id] === undefined ? t : deaths[r.id]));
  return {
    duration: t,
    alive: alive.length,
    draw: alive.length === 0,
    deaths: deaths,
    survival: times,
    minSurvival: Math.min.apply(null, times),
    bombsDropped: bombsDropped,
    cratesBroken: cratesBroken,
  };
}

function summarise(label, n, difficulty, rounds) {
  const res = [];
  for (let i = 0; i < rounds; i++) res.push(playRound(1000 + i * 37, n, difficulty, 90));
  const draws = res.filter((r) => r.draw).length;
  const decisive = res.filter((r) => r.alive === 1).length;
  const avgDur = res.reduce((a, r) => a + r.duration, 0) / rounds;
  const avgFirstDeath = res.reduce((a, r) => a + r.minSurvival, 0) / rounds;
  const avgBombs = res.reduce((a, r) => a + r.bombsDropped, 0) / rounds;
  const avgCrates = res.reduce((a, r) => a + r.cratesBroken, 0) / rounds;
  console.log('  ' + label + ': ' + rounds + ' rounds · avg ' + avgDur.toFixed(1) + 's · ' +
    decisive + ' decisive / ' + draws + ' draw · first death ' + avgFirstDeath.toFixed(1) + 's · ' +
    avgBombs.toFixed(0) + ' bombs · ' + avgCrates.toFixed(0) + ' crates');
  return { draws: draws, decisive: decisive, avgDur: avgDur, avgFirstDeath: avgFirstDeath, avgBombs: avgBombs, avgCrates: avgCrates, rounds: rounds };
}

// ------------------------------------------------------------------ helpers
section('Danger map & escape fields');
(function () {
  const roster = [{ id: 'a', name: 'A', seat: 0, color: '#fff', isBot: true }];
  const w = new BB.World();
  w.reset(7, roster);
  const p = w.playerById('a');
  w.requestBomb('a');
  w.frozen = false;
  w.step(1 / 60);
  const bomb = w.bombs[0];
  check('bomb was placed at the spawn', !!bomb && bomb.r === 1 && bomb.c === 1);

  const danger = AI.dangerMap(w);
  const K = (r, c) => r * BB.W + c;
  check('own tile is marked dangerous', danger[K(1, 1)] !== Infinity);
  check('tile in the blast line is dangerous', danger[K(1, 2)] !== Infinity);
  check('tile off the blast line is safe', danger[K(2, 2)] === Infinity ||
    w.at(2, 2) !== BB.TILE.FLOOR);

  // The escape field must be able to leave the bomb tile...
  const esc = AI.escapeField(w, 1, 1, danger, w.speedOf(p), 0.2);
  check('escape field reaches somewhere', esc.dist.some((d) => d > 0));
  // ...and the safe field must refuse to route through the blast at all.
  const safe = AI.safeField(w, 1, 1, danger);
  check('safe field refuses the blast line', safe.dist[K(1, 2)] === -1);
})();

section('A bot never parks on its own fuse');
(function () {
  function countSoft(world) {
    let n = 0;
    for (let r = 0; r < BB.H; r++) for (let c = 0; c < BB.W; c++) if (world.at(r, c) === BB.TILE.SOFT) n++;
    return n;
  }
  // One lone bot, no opponents: the only thing that can kill it is its own bomb.
  // `normal`/`easy` blunder on purpose, so measure the survival rate over several
  // seeds rather than demanding a single perfect run.
  function trial(s, difficulty) {
    seed(s);
    const roster = [{ id: 'a', name: 'A', seat: 0, color: '#fff', isBot: true }];
    const w = new BB.World();
    w.reset(s, roster);
    const initialSoft = countSoft(w);
    w.frozen = false;
    const bot = new AI.Bot('a', difficulty);
    let died = false;
    for (let i = 0; i < 60 * 60; i++) {
      bot.update(w, DT);
      const evs = w.step(DT);
      for (const e of evs) if (e.type === 'death') died = true;
      if (died) break;
    }
    return { died: died, cleared: initialSoft - countSoft(w) };
  }

  const TRIALS = 10;
  const hard = [];
  const normal = [];
  for (let i = 0; i < TRIALS; i++) {
    hard.push(trial(11 + i, 'hard'));
    normal.push(trial(11 + i, 'normal'));
  }
  const hardDeaths = hard.filter((t) => t.died).length;
  const normalDeaths = normal.filter((t) => t.died).length;
  const cleared = normal.reduce((a, t) => a + t.cleared, 0) / TRIALS;

  check('hard bots never blow themselves up', hardDeaths === 0,
    hardDeaths + '/' + TRIALS + ' died');
  check('normal bots rarely blow themselves up', normalDeaths <= 2,
    normalDeaths + '/' + TRIALS + ' died');
  check('a lone bot actually breaks crates', cleared > 10,
    cleared.toFixed(1) + ' crates cleared on average');
})();

section('Sudden death is on the danger map');
(function () {
  const roster = [{ id: 'a', name: 'A', seat: 0, color: '#fff', isBot: true }];
  const w = new BB.World({ powerUps: false });
  w.reset(7, roster);
  w.frozen = false;
  const K = (r, c) => r * BB.W + c;

  w.startSuddenDeath();
  let warned = null;
  for (let i = 0; i < 600 && !warned; i++) {
    const evs = w.step(DT);
    for (const e of evs) if (e.type === 'sdWarn') warned = e;
  }
  check('a block was telegraphed', !!warned);
  const danger = AI.dangerMap(w);
  const pend = w.sdPending[0];
  check('the telegraphed block is dangerous', danger[K(warned.r, warned.c)] !== Infinity);
  check('its danger time is when the block lands',
    !!pend && Math.abs(danger[K(pend.r, pend.c)] - pend.t) < 0.02,
    pend && (danger[K(pend.r, pend.c)].toFixed(2) + 's vs ' + pend.t.toFixed(2) + 's'));

  // The next cells down the spiral are doomed too, and later than the one that
  // has already been announced.
  let next = null;
  for (let i = w.sdIndex; i < w.sdOrder.length && !next; i++) {
    if (w.at(w.sdOrder[i][0], w.sdOrder[i][1]) !== BB.TILE.HARD) next = w.sdOrder[i];
  }
  check('the next cell in the spiral is already dangerous',
    !!next && danger[K(next[0], next[1])] !== Infinity);
  check('it is dangerous later than the telegraphed one',
    !!next && !!pend && danger[K(next[0], next[1])] > danger[K(pend.r, pend.c)]);

  // Far ahead of the spiral there is still somewhere safe to run to, or a bot
  // would decide the whole arena is lethal and freeze.
  let floorCells = 0, safeCells = 0;
  for (let r = 1; r < BB.H - 1; r++) {
    for (let c = 1; c < BB.W - 1; c++) {
      if (w.at(r, c) !== BB.TILE.FLOOR) continue;
      floorCells++;
      if (danger[K(r, c)] === Infinity) safeCells++;
    }
  }
  check('most of the arena is still safe to retreat into', safeCells > floorCells * 0.8,
    safeCells + '/' + floorCells + ' open cells');
})();

section('Bots run from the falling blocks');
(function () {
  // A lone bot in a cleared arena with the spiral closing in: nothing else can
  // kill it and nothing is in its way, so how long it lasts is a direct measure
  // of how well it reads the blocks. The spiral needs ~34s to fill the arena.
  function trial(s, difficulty) {
    seed(s);
    const roster = [{ id: 'a', name: 'A', seat: 0, color: '#fff', isBot: true }];
    const w = new BB.World({ powerUps: false });
    w.reset(s, roster);
    for (let r = 1; r < BB.H - 1; r++) {
      for (let c = 1; c < BB.W - 1; c++) if (w.grid[r][c] === BB.TILE.SOFT) w.grid[r][c] = BB.TILE.FLOOR;
    }
    w.frozen = false;
    const bot = new AI.Bot('a', difficulty);
    w.startSuddenDeath();
    let t = 0;
    for (let i = 0; i < 60 * 60; i++) {
      bot.update(w, DT);
      const evs = w.step(DT);
      t += DT;
      if (evs.some((e) => e.type === 'death')) break;
    }
    return t;
  }

  const TRIALS = 8;
  for (const difficulty of ['normal', 'hard']) {
    let total = 0;
    for (let i = 0; i < TRIALS; i++) total += trial(21 + i, difficulty);
    const avg = total / TRIALS;
    check(difficulty + ' bots survive deep into sudden death', avg > 25,
      'avg ' + avg.toFixed(1) + 's before being crushed');
  }
})();

section('Full rounds — 4 CPUs');
const easy = summarise('easy  ', 4, 'easy', 12);
const normal = summarise('normal', 4, 'normal', 12);
const hard = summarise('hard  ', 4, 'hard', 12);

section('Assertions');
for (const [name, s] of [['easy', easy], ['normal', normal], ['hard', hard]]) {
  check(name + ': most rounds have a single winner', s.decisive >= s.rounds * 0.6,
    s.decisive + '/' + s.rounds);
  check(name + ': rounds are not instant wipes', s.avgFirstDeath > 6,
    'first death at ' + s.avgFirstDeath.toFixed(1) + 's');
  check(name + ': CPUs actually play (bombs dropped)', s.avgBombs > 8, s.avgBombs.toFixed(0));
  check(name + ': CPUs clear crates', s.avgCrates > 8, s.avgCrates.toFixed(0));
}
check('harder CPUs survive longer than easy ones', hard.avgFirstDeath >= easy.avgFirstDeath * 0.9,
  'easy ' + easy.avgFirstDeath.toFixed(1) + 's vs hard ' + hard.avgFirstDeath.toFixed(1) + 's');

section('2-CPU rounds still resolve');
const duo = summarise('normal', 2, 'normal', 10);
check('2 CPUs reach a result', duo.decisive + duo.draws >= duo.rounds * 0.8,
  duo.decisive + ' decisive / ' + duo.draws + ' draw');

console.log('\n' + (failures === 0 ? '✓ all checks passed' : '✗ ' + failures + ' failed'));
process.exit(failures === 0 ? 0 : 1);
