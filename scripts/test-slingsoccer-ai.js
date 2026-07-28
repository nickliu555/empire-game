'use strict';

// Sling Soccer CPU probe — loads engine.js + ai.js in a window shim and plays
// full CPU-vs-CPU matches, measuring how OFTEN the bot actually attacks:
//
//   node scripts/test-slingsoccer-ai.js [matches]
//
// A turn is "lazy" when the ball ends up where it started — the flick achieved
// nothing, i.e. the pointless back-and-forth shuffling players complain about.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'public', 'slingsoccer', 'js');
const sandbox = { window: {}, Math, console, performance: { now: () => Date.now() } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(dir, 'ai.js'), 'utf8'), sandbox);
const { World } = sandbox.window.SlingSoccer;
const AI = sandbox.window.SlingSoccerAI;

const DT = 1 / 120;
const MATCHES = Math.max(1, Number(process.argv[2]) || 12);
const MAX_TURNS = 120;
const MOVED_PX = 26;    // ball displacement that counts as "the CPU did something"

function other(t) { return t === 'red' ? 'blue' : 'red'; }

// Play one turn; returns stats about what the flick achieved.
function playTurn(world, team) {
  const p = AI.plan(world, team);
  if (!p) return { none: true };
  const tok = world.tokenAt(team, p.idx);
  const ballBefore = { x: world.ball.x, y: world.ball.y };
  const tokBefore = { x: tok.x, y: tok.y };
  const ballR = world.field.BALL_R + world.field.TOKEN_R + 6;

  world.applyFlick(team, p.idx, p.dx, p.dy);
  let goal = null;
  let touched = false;
  let minBallGap = Infinity;
  for (let s = 0; s < 2400; s++) {
    goal = world.step(DT);
    const gap = Math.hypot(tok.x - world.ball.x, tok.y - world.ball.y);
    if (gap < minBallGap) minBallGap = gap;
    if (gap <= ballR) touched = true;
    if (goal) break;
    if (world.allAtRest()) break;
  }
  const ballMoved = Math.hypot(world.ball.x - ballBefore.x, world.ball.y - ballBefore.y);
  const tokMoved = Math.hypot(tok.x - tokBefore.x, tok.y - tokBefore.y);
  if (!goal) world.respawnTokensInGoal();
  return { goal, touched, ballMoved, tokMoved, minBallGap, idx: p.idx, mode: p.mode, team };
}

function playMatch() {
  const world = new World();
  world.setFormation();
  let team = Math.random() < 0.5 ? 'red' : 'blue';
  const stats = {
    turns: 0, lazy: 0, engaged: 0, direct: 0, goals: 0, ballMoved: 0, none: 0,
    repeatTok: 0, chase: 0, lazyChase: 0, lazyAttack: 0, worstStreak: 0,
  };
  const lastTok = { red: null, blue: null };
  let streak = 0;
  for (let t = 0; t < MAX_TURNS; t++) {
    const r = playTurn(world, team);
    stats.turns++;
    if (r.none) { stats.none++; team = other(team); continue; }
    if (r.mode === 'chase') stats.chase++;
    if (r.touched) stats.direct++;
    const did = r.ballMoved >= MOVED_PX || r.goal;
    if (did) {
      stats.engaged++;
      streak = 0;
    } else {
      stats.lazy++;
      if (r.mode === 'chase') stats.lazyChase++; else stats.lazyAttack++;
      streak++;
      if (streak > stats.worstStreak) stats.worstStreak = streak;
    }
    stats.ballMoved += r.ballMoved;
    if (lastTok[team] === r.idx && !did) stats.repeatTok++;
    lastTok[team] = r.idx;
    if (r.goal) {
      stats.goals++;
      world.setFormation();
      team = other(r.goal);
      streak = 0;
      continue;
    }
    team = other(team);
  }
  return stats;
}

const total = {
  turns: 0, lazy: 0, engaged: 0, direct: 0, goals: 0, ballMoved: 0, none: 0,
  repeatTok: 0, chase: 0, lazyChase: 0, lazyAttack: 0, worstStreak: 0,
};
for (let m = 0; m < MATCHES; m++) {
  const s = playMatch();
  for (const k of Object.keys(total)) {
    if (k === 'worstStreak') total[k] = Math.max(total[k], s[k]);
    else total[k] += s[k];
  }
}

const pct = (n) => ((n / total.turns) * 100).toFixed(1) + '%';
console.log('Sling Soccer CPU probe — ' + MATCHES + ' matches, ' + total.turns + ' turns');
console.log('  ball played       : ' + total.engaged + '  (' + pct(total.engaged) + ')');
console.log('    └ struck direct  : ' + total.direct + '  (' + pct(total.direct) + ')');
console.log('  LAZY (ball still) : ' + total.lazy + '  (' + pct(total.lazy) + ')');
console.log('    └ while chasing  : ' + total.lazyChase);
console.log('    └ while shooting : ' + total.lazyAttack);
console.log('  chase plans       : ' + total.chase + '  (' + pct(total.chase) + ')');
console.log('  same token twice  : ' + total.repeatTok + '  (' + pct(total.repeatTok) + ')  <- shuffling');
console.log('  worst lazy streak : ' + total.worstStreak + ' turns in a row');
console.log('  no plan at all    : ' + total.none);
console.log('  goals             : ' + total.goals + '  (' + (total.goals / MATCHES).toFixed(1) + ' per match)');
console.log('  avg ball travel   : ' + (total.ballMoved / total.turns).toFixed(0) + ' px/turn');

const LAZY_MAX = 0.08;
const failed = (total.lazy / total.turns) > LAZY_MAX;
console.log(failed
  ? '\n\u2717 FAILED: ' + pct(total.lazy) + ' of CPU turns left the ball untouched (limit ' + (LAZY_MAX * 100) + '%)'
  : '\n\u2713 PASSED: CPU plays the ball on ' + pct(total.engaged) + ' of turns');
process.exit(failed ? 1 : 0);
