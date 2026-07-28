/* Sling Soccer — CPU (bot) turn planner.
 *
 * Pure decision logic: given the resting world and the team to move, return the
 * flick to play as { idx, dx, dy, mode } (a PULL vector, the same shape a phone
 * sends) or null if nothing is possible. Every candidate is SIMULATED on a
 * throwaway copy of the world, so plans are judged by the real physics.
 *
 * The CPU must always look like it is playing the ball:
 *   ENGAGE — any flick that genuinely moves the ball; the best-scoring one wins.
 *   CHASE  — if the ball is out of range this turn, drive a token onto the spot
 *            it would shoot from next turn (never a shuffle at the back).
 *
 * Loaded by the host page (after engine.js) and by scripts/test-slingsoccer-ai.js.
 */
(function () {
  'use strict';

  const STEP = 1 / 120;
  const MAX_STEPS = 900;          // a flick always settles well inside this
  const TOUCH_PX = 26;            // ball displacement that counts as a real touch
  // Travel distance is very close to linear in flick power (measured off the
  // engine): travel ≈ TRAVEL_K * power − TRAVEL_C. Used to size flicks so a token
  // actually REACHES the ball instead of dying halfway there.
  const TRAVEL_K = 1394, TRAVEL_C = 96;

  function other(team) { return team === 'red' ? 'blue' : 'red'; }
  function powerForTravel(d) { return Math.max(0.18, Math.min(1, (d + TRAVEL_C) / TRAVEL_K)); }

  // Add a little human aim wobble to a pull vector so the CPU stays beatable.
  function withNoise(shot, amt) {
    const n = (Math.random() * 2 - 1) * amt;
    const c = Math.cos(n), s = Math.sin(n);
    return { idx: shot.idx, dx: shot.dx * c - shot.dy * s, dy: shot.dx * s + shot.dy * c };
  }

  function plan(world, team) {
    if (!world || !window.SlingSoccer) return null;
    const f = world.field;
    const ball = world.ball;
    const opp = other(team);
    const tx = team === 'red' ? f.W : 0;      // opponent goal line
    const ownX = team === 'red' ? 0 : f.W;    // our own goal line
    const goalY = f.H / 2;
    const R = f.BALL_R + f.TOKEN_R + 4;

    // Reserve the rearmost token as the keeper (so a defender always stays back).
    let keeperIdx = 0, keeperDist = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = world.tokenAt(team, i);
      const d = Math.abs(t.x - ownX);
      if (d < keeperDist) { keeperDist = d; keeperIdx = i; }
    }

    // Aim at an OPEN part of the mouth, away from the opponent's rearmost token
    // (their keeper), so shots aren't fired straight down the goalie's throat.
    let gk = null, gkDist = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = world.tokenAt(opp, i);
      const d = Math.abs(t.x - tx);
      if (d < gkDist) { gkDist = d; gk = t; }
    }
    const halfMouth = (f.GOAL_BOT - f.GOAL_TOP) / 2;
    const openY = gk ? goalY + (gk.y >= goalY ? -1 : 1) * halfMouth * 0.55 : goalY;
    const targets = [{ x: tx, y: openY }, { x: tx, y: goalY }];

    // Progress = how close the ball is to SCORING for us (bigger is better).
    const progressOf = function (x) { return team === 'red' ? x : (f.W - x); };
    const baseProgress = progressOf(ball.x);
    const DANGER = f.W * 0.30;   // ball this deep in our own third is trouble

    // One reusable sim world; reset it to the current resting board each try.
    const board = world.snapshot();
    const sim = new window.SlingSoccer.World();
    // Play out a candidate flick and report what it achieved.
    const runShot = function (idx, dx, dy) {
      sim.restore(board);
      const bx0 = sim.ball.x, by0 = sim.ball.y;
      sim.applyFlick(team, idx, dx, dy);
      let goal = null;
      for (let s = 0; s < MAX_STEPS; s++) {
        goal = sim.step(STEP);
        if (goal) break;
        if (sim.allAtRest()) break;
      }
      const st = sim.tokenAt(team, idx);
      return {
        goal: goal,
        moved: Math.hypot(sim.ball.x - bx0, sim.ball.y - by0),
        bx: sim.ball.x, by: sim.ball.y,
        tx: st.x, ty: st.y,
      };
    };
    // How good is the resulting board for us?
    const valueOf = function (r) {
      if (r.goal === team) return 1e6;
      if (r.goal === opp) return -1e6;                   // own goal — never
      const end = progressOf(r.bx);
      let v = end - baseProgress;                         // ground gained up-field
      if (end < DANGER) v -= (DANGER - end) * 0.8;        // left loose in front of us
      return v;
    };
    // The spot a token must sit on to strike the ball toward `target`.
    const contactSpot = function (target) {
      const dgx = target.x - ball.x, dgy = target.y - ball.y;
      const dl = Math.hypot(dgx, dgy) || 1;
      return { x: ball.x - (dgx / dl) * R, y: ball.y - (dgy / dl) * R };
    };
    // Pull vector that launches token `t` toward `spot` at `power`.
    const pullToward = function (t, spot, power) {
      let lx = spot.x - t.x, ly = spot.y - t.y;
      const ll = Math.hypot(lx, ly) || 1; lx /= ll; ly /= ll;
      return { dx: -lx * power, dy: -ly * power };        // pull is opposite launch
    };
    // Apply human aim wobble, but never one that would sim into our own net, and
    // (for shots meant to connect) never one that makes us whiff the ball — the
    // CPU stays beatable without gifting own goals or flicking at thin air.
    const finalize = function (shot, amt, mode, mustTouch) {
      for (let k = 0; k < 3; k++) {
        const s = withNoise(shot, amt);
        const r = runShot(s.idx, s.dx, s.dy);
        if (r.goal === opp) continue;
        if (mustTouch && !r.goal && r.moved < TOUCH_PX) continue;
        s.mode = mode;
        return s;
      }
      return { idx: shot.idx, dx: shot.dx, dy: shot.dy, mode: mode };
    };

    // ---- ENGAGE: try every attacker × aim × power and keep the best flick that
    // genuinely MOVES THE BALL. Power is never too weak to get there. ----
    let best = null, bestVal = -Infinity;          // best ball-moving flick
    let nearest = null, nearestMiss = Infinity;    // closest near-miss, if none connect
    const distGoal = Math.hypot(tx - ball.x, goalY - ball.y);
    const pStrike = Math.max(0.55, Math.min(1, 0.55 + distGoal / (f.W * 1.1)));
    for (let i = 0; i < 5; i++) {
      if (i === keeperIdx) continue;
      const t = world.tokenAt(team, i);
      for (let ti = 0; ti < targets.length; ti++) {
        const spot = contactSpot(targets[ti]);
        const gap = Math.hypot(spot.x - t.x, spot.y - t.y);
        const reach = powerForTravel(gap);
        // Enough power to cover the gap (plus margin so it arrives still moving),
        // and a firmer option for a harder strike.
        const powers = [
          Math.min(1, Math.max(pStrike, reach * 1.35)),
          Math.min(1, Math.max(pStrike * 0.82, reach * 1.15)),
        ];
        for (let pi = 0; pi < powers.length; pi++) {
          const v = pullToward(t, spot, powers[pi]);
          const r = runShot(i, v.dx, v.dy);
          if (r.moved >= TOUCH_PX || r.goal) {
            const val = valueOf(r);
            if (val > bestVal) { bestVal = val; best = { idx: i, dx: v.dx, dy: v.dy }; }
          } else {
            const miss = Math.hypot(r.tx - spot.x, r.ty - spot.y);
            if (miss < nearestMiss) { nearestMiss = miss; nearest = { idx: i, dx: v.dx, dy: v.dy }; }
          }
        }
      }
    }
    // Any real contact beats standing around — only refuse if every touch is an
    // own goal, in which case fall through and close the ball down instead.
    if (best && bestVal > -1e5) return finalize(best, 0.03, 'attack', true);

    // ---- CHASE: the ball is out of range this turn, so move a token ONTO the
    // spot it would shoot from next turn. Always toward the ball — never a
    // pointless shuffle in front of our own goal. ----
    const spot = contactSpot(targets[1]);   // straight-at-goal striking spot
    let chase = null, chaseEnd = Infinity;
    for (let i = 0; i < 5; i++) {
      if (i === keeperIdx) continue;
      const t = world.tokenAt(team, i);
      const gap = Math.hypot(spot.x - t.x, spot.y - t.y);
      const reach = powerForTravel(gap);
      const powers = [reach, reach * 1.2, reach * 1.5];
      for (let pi = 0; pi < powers.length; pi++) {
        const v = pullToward(t, spot, Math.min(1, powers[pi]));
        const r = runShot(i, v.dx, v.dy);
        if (r.goal === opp) continue;                       // never concede
        if (r.goal === team) return finalize({ idx: i, dx: v.dx, dy: v.dy }, 0.02, 'attack', true);
        // Prefer whoever ends up closest to the striking spot, and only count it
        // if the token actually closed the gap.
        const end = Math.hypot(r.tx - spot.x, r.ty - spot.y);
        if (end < gap - 20 && end < chaseEnd) { chaseEnd = end; chase = { idx: i, dx: v.dx, dy: v.dy }; }
      }
    }
    if (chase) return finalize(chase, 0.03, 'chase');
    // Boxed in — still swing at the ball rather than fiddle about at the back.
    if (nearest) return finalize(nearest, 0.03, 'attack');
    return best ? finalize(best, 0.03, 'attack', true) : null;
  }

  window.SlingSoccerAI = { plan: plan };
})();
