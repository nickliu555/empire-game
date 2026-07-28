/* Sling Soccer — top-down flick physics engine (host-authoritative).
 *
 * Runs entirely on the host browser. A fixed-timestep world modelling a
 * birds-eye soccer table: five circular tokens per side, one ball, solid walls
 * with a goal mouth (and a pocket) on the left and right. Turn-based: a token
 * is given an impulse (a "flick"), everything slides with friction, bounces off
 * walls / posts / each other with mass-weighted elastic collisions, and comes
 * to rest — then the turn passes. "The angle of the collision matters" is
 * inherent in the impulse-along-the-contact-normal resolution.
 *
 * Units are world pixels; the renderer scales this to the canvas. Time is in
 * seconds. The host steps at a fixed dt (1/120s) for stable, deterministic feel.
 */
(function () {
  'use strict';

  // ---- Field geometry (world units) ----
  const W = 1280, H = 860;            // tighter pitch so the (fixed-size) tokens fill more of it
  const GOAL_H = Math.round(H * 0.30); // 258 — vertical opening of each net
  const GOAL_DEPTH = 84;              // pocket depth behind the goal line
  const GOAL_TOP = (H - GOAL_H) / 2;
  const GOAL_BOT = (H + GOAL_H) / 2;
  const POST_R = 13;                  // goal-post radius (solid bounce)
  const FIELD_MARGIN = 24;            // pitch boundary inset (matches renderer)
  const PBOX_W = Math.round(W * 0.14); // ~179: penalty-box depth (matches renderer)
  const CORNER_CHAMFER = 90;          // 45° wall cut across each field corner so the
                                      // ball can't wedge in a 90° pocket (foosball-style)

  // ---- Bodies ----
  const TOKEN_R = 38;
  const BALL_R = 20;
  const TOKEN_M = 3.4;                // tokens are heavy; the ball flies off them
  const BALL_M = 0.85;                // lighter ball => springs off tokens faster

  // ---- Motion / feel ----
  const DRAG = 1.32;                  // exponential-ish velocity damping / sec (shots bleed energy)
  const LIN_DECEL = 130;              // linear slowdown / sec (crisp stop)
  const STOP_SPEED = 26;             // below this a body is snapped to rest
  const REST = 1.0;                   // body-body restitution (fully elastic — lively deflections)
  const WALL_REST = 0.78;             // wall / post restitution
  const MAX_SPEED = 3400;             // hard cap (keeps 1/120 step tunnel-free)
  const COLLISION_ITERS = 4;          // relaxation passes for stacked tokens

  // ---- Flick ----
  const FLICK_MAX = 2050;             // launch speed at full power

  const TEAMS = ['red', 'blue'];

  // Kickoff formation for the RED side (attacks +x / right), as fractions of the
  // field so it scales with W/H. idx = token number-1. 0 = keeper, 1/2 =
  // defenders, 3/4 = forwards. Blue is the mirror (x -> W-x).
  const RED_FORMATION = [
    { x: W * 0.09, y: H * 0.50 },   // 1 — keeper
    { x: W * 0.25, y: H * 0.33 },   // 2 — defender (top)
    { x: W * 0.25, y: H * 0.67 },   // 3 — defender (bottom)
    { x: W * 0.41, y: H * 0.42 },   // 4 — forward (top)
    { x: W * 0.41, y: H * 0.58 },   // 5 — forward (bottom)
  ];

  function makeBody(type, team, idx, x, y, r, m) {
    return { type, team, idx, x, y, vx: 0, vy: 0, r, m, static: false };
  }

  class World {
    constructor() {
      this.field = {
        W, H, GOAL_H, GOAL_DEPTH, GOAL_TOP, GOAL_BOT, POST_R,
        TOKEN_R, BALL_R, FIELD_MARGIN, PBOX_W, CORNER_CHAMFER,
        // Round goal posts, centred just OUTSIDE each mouth edge so the clear
        // opening stays exactly GOAL_H: a body of radius r can pass only where
        // its centre is >= POST_R + r from a post centre, i.e. r inside the
        // mouth — exactly the "whole disc fits through" rule. Without them a
        // body clipping the mouth edge was snapped inside the mouth in one step
        // (a visible jump off the post).
        posts: [
          { x: 0, y: GOAL_TOP - POST_R }, { x: 0, y: GOAL_BOT + POST_R },
          { x: W, y: GOAL_TOP - POST_R }, { x: W, y: GOAL_BOT + POST_R },
        ],
      };
      this.posts = this.field.posts.map((p) => ({ x: p.x, y: p.y, vx: 0, vy: 0, r: POST_R, static: true }));
      this.tokens = [];   // 10 tokens (5 red, 5 blue)
      this.ball = null;
      this.bodies = [];   // all movable bodies (tokens + ball)
      this.byKey = new Map(); // 'red-0' -> token
      this._build();
      this.setFormation();
    }

    _build() {
      this.tokens = [];
      this.byKey.clear();
      for (const team of TEAMS) {
        for (let i = 0; i < 5; i++) {
          const t = makeBody('token', team, i, 0, 0, TOKEN_R, TOKEN_M);
          this.tokens.push(t);
          this.byKey.set(team + '-' + i, t);
        }
      }
      this.ball = makeBody('ball', null, -1, W / 2, H / 2, BALL_R, BALL_M);
      this.bodies = this.tokens.concat([this.ball]);
    }

    tokenAt(team, idx) { return this.byKey.get(team + '-' + idx) || null; }

    // Place every token + the ball at the kickoff formation, velocities zeroed.
    setFormation() {
      for (let i = 0; i < 5; i++) {
        const rf = RED_FORMATION[i];
        const rt = this.tokenAt('red', i);
        rt.x = rf.x; rt.y = rf.y; rt.vx = 0; rt.vy = 0;
        const bt = this.tokenAt('blue', i);
        bt.x = W - rf.x; bt.y = rf.y; bt.vx = 0; bt.vy = 0;
      }
      this.ball.x = W / 2; this.ball.y = H / 2; this.ball.vx = 0; this.ball.vy = 0;
    }

    // Apply a flick to a token: the client sends the PULL vector (dx,dy) with
    // |v|<=1 encoding power; the token launches in the OPPOSITE direction.
    applyFlick(team, idx, dx, dy) {
      const t = this.tokenAt(team, idx);
      if (!t) return false;
      let px = Number(dx) || 0, py = Number(dy) || 0;
      const mag = Math.hypot(px, py);
      if (mag > 1) { px /= mag; py /= mag; } // clamp power to 1
      t.vx = -px * FLICK_MAX;
      t.vy = -py * FLICK_MAX;
      this._clampSpeed(t);
      return true;
    }

    // ---- Per-step integration ----
    step(dt) {
      for (const b of this.bodies) {
        this._friction(b, dt);
        b.x += b.vx * dt;
        b.y += b.vy * dt;
      }
      // Goal check first: the ball crossing a goal line (within the mouth) ends
      // the play immediately, before any wall clamps it back onto the pitch.
      const g = this._checkGoal();
      if (g) return g;
      for (const b of this.bodies) this._walls(b);
      for (let it = 0; it < COLLISION_ITERS; it++) this._collisions();
      for (const b of this.bodies) this._clampSpeed(b);
      return null;
    }

    _friction(b, dt) {
      if (b.vx === 0 && b.vy === 0) return;
      // Multiplicative drag + a small linear decel so bodies settle crisply.
      let f = 1 - DRAG * dt;
      if (f < 0) f = 0;
      b.vx *= f; b.vy *= f;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) {
        const ns = Math.max(0, sp - LIN_DECEL * dt);
        if (ns <= STOP_SPEED) { b.vx = 0; b.vy = 0; }
        else { const k = ns / sp; b.vx *= k; b.vy *= k; }
      }
    }

    _checkGoal() {
      const b = this.ball;
      if (b.y > GOAL_TOP && b.y < GOAL_BOT) {
        if (b.x <= 0) return 'blue';   // ball in the LEFT (red) net -> blue scores
        if (b.x >= W) return 'red';    // ball in the RIGHT (blue) net -> red scores
      }
      return null;
    }

    _walls(b) {
      const r = b.r;
      // Cut the four sharp corners first so a body sliding into one is deflected
      // back toward play along a 45° face instead of wedging in a 90° pocket.
      this._chamferCorners(b);
      const inMouthY = (b.y > GOAL_TOP && b.y < GOAL_BOT);
      // Horizontal walls / pocket back wall.
      if (!inMouthY) {
        if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx) * WALL_REST; }
        else if (b.x > W - r) { b.x = W - r; b.vx = -Math.abs(b.vx) * WALL_REST; }
      } else {
        // Open mouth: allow travel into the pocket, stopped by its back wall.
        if (b.x < -GOAL_DEPTH + r) { b.x = -GOAL_DEPTH + r; b.vx = Math.abs(b.vx) * WALL_REST; }
        else if (b.x > W + GOAL_DEPTH - r) { b.x = W + GOAL_DEPTH - r; b.vx = -Math.abs(b.vx) * WALL_REST; }
      }
      // Vertical walls. On the main pitch use the outer walls; once the CENTRE
      // is past a goal line the body is in that pocket, so confine it to the
      // mouth height. Testing the centre (not centre ± r) matters: the posts
      // already keep a body r inside the mouth by the time it gets here, so the
      // clamp only trims a pixel or two instead of snapping it up to r sideways.
      const inPocket = (b.x < 0) || (b.x > W);
      if (!inPocket) {
        if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy) * WALL_REST; }
        else if (b.y > H - r) { b.y = H - r; b.vy = -Math.abs(b.vy) * WALL_REST; }
      } else {
        if (b.y < GOAL_TOP + r) { b.y = GOAL_TOP + r; b.vy = Math.abs(b.vy) * WALL_REST; }
        else if (b.y > GOAL_BOT - r) { b.y = GOAL_BOT - r; b.vy = -Math.abs(b.vy) * WALL_REST; }
      }
    }

    // Push a body off any of the four 45° corner faces. Each face is the line
    // u + v = CORNER_CHAMFER, where (u,v) are the body's distances from the two
    // walls meeting at that corner; the inward normal is (su,sv)/√2.
    _chamferCorners(b) {
      if (!CORNER_CHAMFER) return;
      const r = b.r, inv = Math.SQRT1_2;
      const corners = [
        [+1, +1], // top-left
        [-1, +1], // top-right
        [+1, -1], // bottom-left
        [-1, -1], // bottom-right
      ];
      for (let i = 0; i < corners.length; i++) {
        const su = corners[i][0], sv = corners[i][1];
        const u = su > 0 ? b.x : (W - b.x);
        const v = sv > 0 ? b.y : (H - b.y);
        const d = (u + v - CORNER_CHAMFER) * inv; // signed dist to face (playable +)
        const pen = r - d;
        if (pen <= 0) continue;                    // outside this corner's zone
        const nx = su * inv, ny = sv * inv;        // inward unit normal
        b.x += pen * nx; b.y += pen * ny;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { b.vx -= (1 + WALL_REST) * vn * nx; b.vy -= (1 + WALL_REST) * vn * ny; }
      }
    }

    _collisions() {
      const bs = this.bodies;
      for (let i = 0; i < bs.length; i++) {
        for (let j = i + 1; j < bs.length; j++) this._resolve(bs[i], bs[j]);
        for (let k = 0; k < this.posts.length; k++) this._resolve(bs[i], this.posts[k]);
      }
    }

    _resolve(a, b) {
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      const minD = a.r + b.r;
      if (dist >= minD) return;
      let nx, ny;
      if (dist < 1e-6) { nx = 1; ny = 0; dist = 0; } // exact overlap → arbitrary unit axis
      else { nx = dx / dist; ny = dy / dist; }
      const overlap = minD - dist;
      const ima = a.static ? 0 : 1 / a.m;
      const imb = b.static ? 0 : 1 / b.m;
      const imSum = ima + imb;
      if (imSum === 0) return;
      // Positional correction (split by inverse mass) so bodies never sink in.
      a.x -= nx * overlap * (ima / imSum);
      a.y -= ny * overlap * (ima / imSum);
      b.x += nx * overlap * (imb / imSum);
      b.y += ny * overlap * (imb / imSum);
      // Impulse along the contact normal.
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const relN = rvx * nx + rvy * ny;
      if (relN > 0) return; // already separating
      const e = (a.static || b.static) ? WALL_REST : REST;
      const jImp = -(1 + e) * relN / imSum;
      const jx = jImp * nx, jy = jImp * ny;
      a.vx -= jx * ima; a.vy -= jy * ima;
      b.vx += jx * imb; b.vy += jy * imb;
    }

    _clampSpeed(b) {
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > MAX_SPEED) { const k = MAX_SPEED / sp; b.vx *= k; b.vy *= k; }
    }

    // Every movable body is stationary (velocities are snapped to 0 below
    // STOP_SPEED, so this is an exact test).
    allAtRest() {
      for (const b of this.bodies) if (b.vx !== 0 || b.vy !== 0) return false;
      return true;
    }

    // Any token whose CENTRE crossed a goal line (sitting in a pocket) is moved
    // back onto the pitch at a RANDOM spot just beyond that goal's penalty box,
    // so it lands well clear of the net and can't wall off future shots.
    // Returns the list of respawned tokens (for a little host FX).
    respawnTokensInGoal() {
      const moved = [];
      for (const t of this.tokens) {
        const leftGoal = t.x <= TOKEN_R * 0.5;
        const rightGoal = t.x >= W - TOKEN_R * 0.5;
        if (!leftGoal && !rightGoal) continue;
        const spot = this._randomSpotBehindBox(leftGoal ? 'left' : 'right', t);
        t.x = spot.x; t.y = spot.y; t.vx = 0; t.vy = 0;
        moved.push(t);
      }
      return moved;
    }

    // A random, non-overlapping spot just BEHIND (outside) the goal's penalty
    // box, toward midfield — keeps the respawned token in play but far from goal.
    _randomSpotBehindBox(side, self) {
      const boxOutL = FIELD_MARGIN + PBOX_W;       // 236: right edge of the left box
      const boxOutR = W - FIELD_MARGIN - PBOX_W;   // 1264: left edge of the right box
      const yLo = TOKEN_R + 30;
      const yHi = H - TOKEN_R - 30;
      for (let tries = 0; tries < 60; tries++) {
        const x = side === 'left'
          ? boxOutL + 30 + Math.random() * 190     // ~266..456
          : boxOutR - 30 - Math.random() * 190;    // ~1034..1234
        const y = yLo + Math.random() * (yHi - yLo);
        if (this._spotClear(x, y, self)) return { x, y };
      }
      return { x: side === 'left' ? boxOutL + 90 : boxOutR - 90, y: H / 2 };
    }

    _spotClear(x, y, self) {
      for (const b of this.bodies) {
        if (b === self) continue;
        const need = self.r + b.r + 3;
        if (Math.hypot(b.x - x, b.y - y) < need) return false;
      }
      return true;
    }

    // ---- Snapshot / restore (host refresh restores the exact resting board) ----
    snapshot() {
      return {
        tokens: this.tokens.map((t) => ({ team: t.team, idx: t.idx, x: Math.round(t.x), y: Math.round(t.y) })),
        ball: { x: Math.round(this.ball.x), y: Math.round(this.ball.y) },
      };
    }

    restore(board) {
      if (!board || !Array.isArray(board.tokens) || !board.ball) return false;
      for (const s of board.tokens) {
        const t = this.tokenAt(s.team, s.idx);
        if (t) { t.x = s.x; t.y = s.y; t.vx = 0; t.vy = 0; }
      }
      this.ball.x = board.ball.x; this.ball.y = board.ball.y; this.ball.vx = 0; this.ball.vy = 0;
      return true;
    }
  }

  window.SlingSoccer = { World, WORLD_W: W, WORLD_H: H };
})();
