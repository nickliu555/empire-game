'use strict';
// Headless probe of the Puck Ball physics engine (public/puckball/js/engine.js).
// Loads the browser IIFE with a minimal window shim and checks it against the
// HaxBall reference numbers.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'puckball', 'js', 'engine.js'), 'utf8');
const sandbox = { window: {}, Math: Math };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const PB = sandbox.window.PuckBall;
const PHYS = PB.PHYS;

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failures++;
}
function speed(d) { return Math.hypot(d.vx, d.vy); }

function makeWorld(tier, roster) {
  const w = new PB.World({ tier: tier || 'classic' });
  w.setRoster(roster || [
    { id: 'r', name: 'Red', team: 'red', seat: 0 },
    { id: 'b', name: 'Blue', team: 'blue', seat: 0 },
  ]);
  w.frozen = false;
  w.koActive = false;
  return w;
}
// Discs can't be parked off-pitch (the walls push them back), so tests that need
// an empty pitch use a one-player roster.
function soloWorld(tier) {
  return makeWorld(tier, [{ id: 'r', name: 'Red', team: 'red', seat: 0 }]);
}
function emptyWorld(tier) {
  return makeWorld(tier, []);
}
function stepN(w, n) { let g = null; for (let i = 0; i < n; i++) { const r = w.step(); if (r) g = r; } return g; }

console.log('Puck Ball physics');

// 1. Terminal player speed = a·d/(1−d) = 2.4 u/tick.
(function () {
  const w = soloWorld();
  const p = w.byId.get('r');
  p.x = -w.stadium.halfW + 20; p.y = 0; p.vx = 0; p.vy = 0;
  w.ball.x = 0; w.ball.y = -w.stadium.halfH + 20; // out of the run
  w.setInput('r', 1, 0, false);
  stepN(w, 150);
  check('player terminal speed ≈ 2.4 u/tick', Math.abs(speed(p) - 2.4) < 0.01, 'v=' + speed(p).toFixed(4));
})();

// 2. Kick imparts kickStrength along the player→ball normal.
(function () {
  const w = soloWorld();
  const p = w.byId.get('r');
  p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
  w.ball.x = 20; w.ball.y = 0; w.ball.vx = 0; w.ball.vy = 0;
  w.setInput('r', 0, 0, true);
  w.step();
  const expect = PHYS.kickStrength * PHYS.ballInvMass * PHYS.ballDamping;
  check('kick sends the ball at ≈' + PHYS.kickStrength + ' u/tick',
    Math.abs(w.ball.vx - expect) < 0.05, 'vx=' + w.ball.vx.toFixed(3) + ' expect=' + expect.toFixed(3));
  check('kick is at least as strong as HaxBall', PHYS.kickStrength >= 5, 'k=' + PHYS.kickStrength);
})();

// 3. Kick needs a fresh press: holding it does not re-kick.
(function () {
  const w = soloWorld();
  const p = w.byId.get('r');
  p.x = 0; p.y = 0;
  w.ball.x = 20; w.ball.y = 0;
  w.setInput('r', 0, 0, true);
  w.step();
  const after1 = w.ball.vx;
  w.ball.x = p.x + 20; w.ball.y = p.y; w.ball.vx = 0; w.ball.vy = 0;
  w.step(); // still held
  check('held kick does not re-fire', Math.abs(w.ball.vx) < 0.01, 'vx=' + w.ball.vx.toFixed(3));
  w.setInput('r', 0, 0, false);
  w.setInput('r', 0, 0, true);
  w.ball.x = p.x + 20; w.ball.y = p.y; w.ball.vx = 0; w.ball.vy = 0;
  w.step();
  check('re-press kicks again', w.ball.vx > 4, 'vx=' + w.ball.vx.toFixed(3) + ' (first ' + after1.toFixed(2) + ')');
})();
// 4. Kick range is exactly r_p + r_b + 4 = 29.
(function () {
  const reach = PHYS.playerRadius + PHYS.ballRadius + PHYS.kickRange;
  check('kick reach constant is 29', reach === 29, 'reach=' + reach);
  const w = soloWorld();
  const p = w.byId.get('r');
  p.x = 0; p.y = 0;
  w.ball.x = reach + 0.5; w.ball.y = 0; w.ball.vx = 0; w.ball.vy = 0;
  w.setInput('r', 0, 0, true);
  w.step();
  check('kick misses just outside reach', Math.abs(w.ball.vx) < 0.01, 'vx=' + w.ball.vx.toFixed(3));
})();

// 5. Ball damping: v after n free ticks = v0 · 0.99^n.
(function () {
  const w = emptyWorld();
  w.ball.x = 0; w.ball.y = 0; w.ball.vx = 2; w.ball.vy = 0;
  const expect = 2 * Math.pow(PHYS.ballDamping, 60);
  stepN(w, 60);
  check('ball damping matches 0.99^n', Math.abs(w.ball.vx - expect) < 1e-6, 'vx=' + w.ball.vx.toFixed(5) + ' expect=' + expect.toFixed(5));
})();

// 6. Board rebound uses the product of the bCoefs (ball 0.5 × ballArea 1).
(function () {
  const w = emptyWorld();
  const S = w.stadium;
  w.ball.x = 0; w.ball.y = -(S.halfH - PHYS.ballRadius - 3); w.ball.vx = 0; w.ball.vy = -2;
  stepN(w, 12);
  check('ball rebounds off the touchline at ≈half speed', w.ball.vy > 0.85 && w.ball.vy < 1.05, 'vy=' + w.ball.vy.toFixed(3));
})();

// 7. Players stay on the pitch; the ball can leave through the goal mouth only.
(function () {
  const w = soloWorld();
  const S = w.stadium;
  const p = w.byId.get('r');
  p.x = 0; p.y = 0;
  w.ball.x = 0; w.ball.y = S.halfH - 20;
  w.setInput('r', -1, 0, false);
  stepN(w, 600);
  check('player is stopped by the goal line', p.x > -S.halfW - 1 && p.x < -S.halfW + PHYS.playerRadius + 1, 'x=' + p.x.toFixed(1));
})();

// 8. Goal only counts between the posts.
(function () {
  const w = emptyWorld();
  const S = w.stadium;
  w.ball.x = -(S.halfW - 30); w.ball.y = 0; w.ball.vx = -4; w.ball.vy = 0;
  const g = stepN(w, 40);
  check('ball in the middle of the mouth is a goal for blue', !!g && g.team === 'blue', 'g=' + JSON.stringify(g));

  const w2 = emptyWorld();
  w2.ball.x = -(S.halfW - 30); w2.ball.y = S.goalHalf + 30; w2.ball.vx = -4; w2.ball.vy = 0;
  const g2 = stepN(w2, 60);
  check('ball wide of the post is not a goal', !g2, 'g=' + JSON.stringify(g2));
})();

// 9. The opening kickoff is unrestricted; later kickoffs hold the defending team.
(function () {
  const w = makeWorld();
  w.kickoff('red', true);
  w.frozen = false;
  const openingBlue = w.byId.get('b');
  openingBlue.x = 40; openingBlue.y = 0;
  w.setInput('b', -1, 0, false);
  stepN(w, 120);
  check('opening kickoff has no barrier', w.koActive === false && openingBlue.x < 0, 'x=' + openingBlue.x.toFixed(1));

  w.kickoff('red');
  const blue = w.byId.get('b');
  blue.x = 40; blue.y = 0;
  w.setInput('b', -1, 0, false);
  stepN(w, 419);
  check('kickoff barrier holds the defending team back', blue.x > -1, 'x=' + blue.x.toFixed(1));
  check('kickoff barrier stays active before seven seconds', w.koActive === true);
  w.step();
  check('kickoff barrier drops after seven seconds', w.koActive === false);

  w.kickoff('red');
  const red = w.byId.get('r');
  red.x = -60; red.y = 0;
  w.setInput('r', 1, 0, true); // touch/kick the ball
  stepN(w, 120);
  check('barrier drops once the ball is played', w.koActive === false);
})();

// 9b. A kick thrown during the goal freeze must not still be flashing at kickoff.
(function () {
  const w = makeWorld();
  const p = w.byId.get('r');
  p.x = 0; p.y = 0;
  w.ball.x = 20; w.ball.y = 0;
  w.setInput('r', 0, 0, true);
  w.step();
  check('kicking sets the flash ring', p.kickFlash > 0, 'flash=' + p.kickFlash);
  w.frozen = true;
  stepN(w, 30);
  check('the flash is held while the world is frozen', p.kickFlash > 0, 'flash=' + p.kickFlash);
  w.kickoff('blue');
  check('kickoff clears the flash on every player',
    w.players.every(function (q) { return q.kickFlash === 0; }), 'flash=' + p.kickFlash);
})();

// 10. Pitch tiers.
(function () {
  check('tier for 1v1 is small', PB.pickTier(1) === 'small');
  check('tier for 2v2 is classic', PB.pickTier(2) === 'classic');
  check('tier for 3v3 is big', PB.pickTier(3) === 'big');
  check('tier for 4v4 is huge', PB.pickTier(4) === 'huge');
  let sizesOk = true;
  let spawnsOk = true;
  let prev = 0;
  PB.TIERS.forEach(function (t, i) {
    const S = PB.makeStadium(t);
    if (S.halfW <= prev) sizesOk = false;
    prev = S.halfW;
    const roster = [];
    for (let k = 0; k < i + 1; k++) {
      roster.push({ id: 'r' + k, name: 'R' + k, team: 'red', seat: k });
      roster.push({ id: 'b' + k, name: 'B' + k, team: 'blue', seat: k });
    }
    const w = new PB.World({ tier: t });
    w.setRoster(roster);
    w.players.forEach(function (p) {
      if (Math.abs(p.x) > S.halfW - p.r || Math.abs(p.y) > S.halfH - p.r) spawnsOk = false;
      if (p.team === 'red' && p.x >= 0) spawnsOk = false;
      if (p.team === 'blue' && p.x <= 0) spawnsOk = false;
    });
  });
  check('each tier is bigger than the last', sizesOk);
  check('every tier spawns its full roster in bounds and on its own half', spawnsOk);
})();

// 11. Bots produce legal 8-way input and can score against an empty net.
(function () {
  const w = new PB.World({ tier: 'classic' });
  w.setRoster([{ id: 'bot-1', name: 'CPU', team: 'red', seat: 0, isBot: true }]);
  w.frozen = false;
  w.koActive = false;
  let legal = true;
  let goal = null;
  for (let i = 0; i < 60 * 30 && !goal; i++) {
    w.stepBots();
    const bot = w.byId.get('bot-1');
    if (![-1, 0, 1].includes(bot.inX) || ![-1, 0, 1].includes(bot.inY)) legal = false;
    goal = w.step();
  }
  check('bot input stays on the 8-way grid', legal);
  check('bot scores on an empty net within 30s', !!goal && goal.team === 'red', 'goal=' + JSON.stringify(goal));
})();

console.log(failures === 0 ? '\nAll physics checks passed.' : '\n' + failures + ' check(s) failed.');
process.exit(failures === 0 ? 0 : 1);
