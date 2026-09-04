(function () {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────
  // Puck Ball engine — a faithful re-implementation of HaxBall's disc physics.
  //
  // Everything below is expressed in HaxBall units and PER 60 Hz TICK (not per
  // second): the world is stepped at a fixed 1/60 s and the constants are taken
  // straight from HaxBall's default player/ball discs (bar `kickStrength`, see
  // the note there). Integration order per tick matches the original:
  //   1. apply movement acceleration to player discs
  //   2. resolve kicks
  //   3. pos += speed;  speed = (speed + gravity) * damping
  //   4. resolve collisions (disc↔disc, disc↔segment, disc↔plane)
  //   5. goal-line test
  // ───────────────────────────────────────────────────────────────────────

  var PHYS = {
    playerRadius: 15,
    playerInvMass: 0.5,
    playerBCoef: 0.5,
    playerDamping: 0.96,
    playerAccel: 0.1,
    kickingAccel: 0.07,
    kickingDamping: 0.96,
    // HaxBall's default is 5. Phone controls are less precise than a keyboard,
    // so shots get a deliberate ~30% bump to feel punchy on the host screen.
    kickStrength: 6.5,
    kickback: 0,
    ballRadius: 10,
    ballInvMass: 1,
    ballBCoef: 0.5,
    ballDamping: 0.99,
    kickRange: 4, // extra reach on top of the two radii
  };

  var STEP = 1 / 60;
  var KICKOFF_LIMIT_TICKS = 7 / STEP;

  // Collision groups (HaxBall cGroup/cMask bitmasks).
  var CG = {
    ball: 1,
    red: 2,
    blue: 4,
    wall: 8,
    player: 16,
    all: 0xffff,
  };

  // Pitch size grows with the larger team, HaxBall Classic/Big/Huge style.
  // Mirrors TIERS in server/puckball/game.js.
  var TIER_SPECS = {
    small: { halfW: 315, halfH: 145, goalHalf: 58, circle: 62 },
    classic: { halfW: 370, halfH: 170, goalHalf: 64, circle: 75 },
    big: { halfW: 480, halfH: 220, goalHalf: 72, circle: 90 },
    huge: { halfW: 575, halfH: 260, goalHalf: 80, circle: 100 },
  };
  var TIERS = ['small', 'classic', 'big', 'huge'];

  function pickTier(maxTeamSize) {
    var i = Math.min(TIERS.length, Math.max(1, maxTeamSize | 0)) - 1;
    return TIERS[i];
  }

  var NET_DEPTH = 32;
  var POST_RADIUS = 8;
  var OUT_PAD = 26; // strip of grass outside the touchline (players stay inside)

  // Kickoff formations per team size, as fractions of (halfW, halfH) on the
  // left (red) half; blue is mirrored.
  var FORMATIONS = {
    1: [[-0.45, 0]],
    2: [[-0.70, 0], [-0.34, 0]],
    3: [[-0.76, 0], [-0.40, -0.42], [-0.40, 0.42]],
    4: [[-0.78, 0], [-0.46, -0.46], [-0.46, 0.46], [-0.20, 0]],
  };

  function seg(x0, y0, x1, y1, bCoef, mask) {
    return { x0: x0, y0: y0, x1: x1, y1: y1, bCoef: bCoef, mask: mask };
  }
  function plane(nx, ny, dist, bCoef, mask) {
    return { nx: nx, ny: ny, dist: dist, bCoef: bCoef, mask: mask };
  }

  /**
   * Build the stadium for a tier. Origin is the centre spot; +x is right, +y is
   * down (canvas orientation). Red defends the left goal, blue the right.
   */
  function makeStadium(tier) {
    var S = TIER_SPECS[tier] || TIER_SPECS.classic;
    var hw = S.halfW;
    var hh = S.halfH;
    var gh = S.goalHalf;
    var outX = hw + NET_DEPTH;
    var outY = hh + OUT_PAD;

    var segments = [];
    // Ball area — bCoef 1, ball only, so the ball keeps its pace off the boards.
    segments.push(seg(-hw, -hh, hw, -hh, 1, CG.ball));
    segments.push(seg(-hw, hh, hw, hh, 1, CG.ball));
    segments.push(seg(-hw, -hh, -hw, -gh, 1, CG.ball));
    segments.push(seg(-hw, gh, -hw, hh, 1, CG.ball));
    segments.push(seg(hw, -hh, hw, -gh, 1, CG.ball));
    segments.push(seg(hw, gh, hw, hh, 1, CG.ball));
    // Goal nets — ball only, deadens the ball so it settles in the net.
    segments.push(seg(-hw, -gh, -outX, -gh, 0.1, CG.ball));
    segments.push(seg(-hw, gh, -outX, gh, 0.1, CG.ball));
    segments.push(seg(-outX, -gh, -outX, gh, 0.1, CG.ball));
    segments.push(seg(hw, -gh, outX, -gh, 0.1, CG.ball));
    segments.push(seg(hw, gh, outX, gh, 0.1, CG.ball));
    segments.push(seg(outX, -gh, outX, gh, 0.1, CG.ball));

    // Players are confined to the pitch + a small run-off strip; they can stand
    // on the goal line but not inside the net.
    var planes = [
      plane(0, 1, -outY, 0.1, CG.player),
      plane(0, -1, -outY, 0.1, CG.player),
      plane(1, 0, -hw, 0.1, CG.player),
      plane(-1, 0, -hw, 0.1, CG.player),
    ];

    // Goal posts: static discs everything bounces off.
    var posts = [
      { x: -hw, y: -gh }, { x: -hw, y: gh },
      { x: hw, y: -gh }, { x: hw, y: gh },
    ].map(function (p) {
      return {
        x: p.x, y: p.y, vx: 0, vy: 0, r: POST_RADIUS,
        invMass: 0, bCoef: 0.5, damping: 1,
        cGroup: CG.wall, cMask: CG.all, isPost: true,
      };
    });

    return {
      tier: tier,
      halfW: hw, halfH: hh, goalHalf: gh,
      netDepth: NET_DEPTH, circle: S.circle,
      outX: outX, outY: outY,
      segments: segments, planes: planes, posts: posts,
    };
  }

  // ───────────────────────────── collision ─────────────────────────────

  function canCollide(a, b) {
    return (a.cGroup & b.cMask) !== 0 && (b.cGroup & a.cMask) !== 0;
  }

  function collideDiscs(a, b, out) {
    if (!canCollide(a, b)) return;
    var im = a.invMass + b.invMass;
    if (im <= 0) return;
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    var d2 = dx * dx + dy * dy;
    var rr = a.r + b.r;
    if (d2 <= 0 || d2 >= rr * rr) return;
    var d = Math.sqrt(d2);
    var nx = dx / d;
    var ny = dy / d;
    var overlap = rr - d;
    var f = a.invMass / im;
    a.x += nx * overlap * f;
    a.y += ny * overlap * f;
    b.x -= nx * overlap * (1 - f);
    b.y -= ny * overlap * (1 - f);
    if (out) out.hit = true;
    var rv = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (rv >= 0) return;
    var e = 1 + a.bCoef * b.bCoef;
    a.vx -= nx * rv * e * f;
    a.vy -= ny * rv * e * f;
    b.vx += nx * rv * e * (1 - f);
    b.vy += ny * rv * e * (1 - f);
    if (out) out.impact = -rv;
  }

  function collideSegment(d, s, out) {
    if ((d.cGroup & s.mask) === 0 || d.invMass <= 0) return;
    var ex = s.x1 - s.x0;
    var ey = s.y1 - s.y0;
    var len2 = ex * ex + ey * ey;
    var t = len2 > 0 ? ((d.x - s.x0) * ex + (d.y - s.y0) * ey) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var px = s.x0 + ex * t;
    var py = s.y0 + ey * t;
    var nx = d.x - px;
    var ny = d.y - py;
    var dist2 = nx * nx + ny * ny;
    if (dist2 <= 0 || dist2 >= d.r * d.r) return;
    var dist = Math.sqrt(dist2);
    nx /= dist; ny /= dist;
    d.x += nx * (d.r - dist);
    d.y += ny * (d.r - dist);
    var vn = d.vx * nx + d.vy * ny;
    if (vn >= 0) return;
    var e = 1 + d.bCoef * s.bCoef;
    d.vx -= nx * vn * e;
    d.vy -= ny * vn * e;
    if (out) out.impact = -vn;
  }

  function collidePlane(d, p, out) {
    if ((d.cGroup & p.mask) === 0 || d.invMass <= 0) return;
    // Inside the plane means dot(pos, n) >= dist.
    var pen = p.dist + d.r - (d.x * p.nx + d.y * p.ny);
    if (pen <= 0) return;
    d.x += p.nx * pen;
    d.y += p.ny * pen;
    var vn = d.vx * p.nx + d.vy * p.ny;
    if (vn >= 0) return;
    var e = 1 + d.bCoef * p.bCoef;
    d.vx -= p.nx * vn * e;
    d.vy -= p.ny * vn * e;
    if (out) out.impact = -vn;
  }

  // ───────────────────────────── world ─────────────────────────────

  function World(opts) {
    opts = opts || {};
    this.stadium = makeStadium(opts.tier || 'classic');
    this.players = [];
    this.byId = new Map();
    this.ball = {
      x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, r: PHYS.ballRadius,
      invMass: PHYS.ballInvMass, bCoef: PHYS.ballBCoef, damping: PHYS.ballDamping,
      cGroup: CG.ball, cMask: CG.all,
    };
    this.frozen = true;
    this.koTeam = 'red';
    this.koActive = true;
    this.koTicks = 0;
    this.redScore = 0;
    this.blueScore = 0;
    this.events = [];
    this.tick = 0;
    this._koBarriers = [];
    this._koCircle = null;
    this._all = [this.ball];
  }

  World.prototype.setTier = function (tier) {
    this.stadium = makeStadium(tier);
  };

  World.prototype.setRoster = function (roster) {
    this.players = [];
    this.byId = new Map();
    for (var i = 0; i < roster.length; i++) {
      var r = roster[i];
      var team = r.team === 'blue' ? 'blue' : 'red';
      var p = {
        id: r.id,
        name: r.name,
        team: team,
        seat: r.seat | 0,
        isBot: !!r.isBot,
        connected: r.connected !== false,
        x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0,
        r: PHYS.playerRadius,
        invMass: PHYS.playerInvMass,
        bCoef: PHYS.playerBCoef,
        damping: PHYS.playerDamping,
        cGroup: CG.player | (team === 'red' ? CG.red : CG.blue),
        cMask: CG.all,
        inX: 0, inY: 0, inKick: false,
        kickArmed: true,
        kickFlash: 0,
        bot: r.isBot ? { until: 0, jx: 0, jy: 0, dx: 0, dy: 0, kick: false } : null,
      };
      this.players.push(p);
      this.byId.set(p.id, p);
    }
    this._all = this.players.concat([this.ball]);
    this.kickoff(this.koTeam);
  };

  World.prototype.teamSize = function (team) {
    var n = 0;
    for (var i = 0; i < this.players.length; i++) if (this.players[i].team === team) n++;
    return n;
  };

  World.prototype.setInput = function (id, dx, dy, kick) {
    var p = this.byId.get(id);
    if (!p) return;
    p.inX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    p.inY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
    p.inKick = !!kick;
    if (!p.inKick) p.kickArmed = true;
  };

  World.prototype.clearInput = function (id) {
    var p = this.byId.get(id);
    if (!p) return;
    p.inX = 0; p.inY = 0; p.inKick = false; p.kickArmed = true;
  };

  World.prototype.setConnected = function (id, on) {
    var p = this.byId.get(id);
    if (!p) return;
    p.connected = !!on;
    // A dropped phone just stops steering — the disc stays on the pitch.
    if (!on) { p.inX = 0; p.inY = 0; p.inKick = false; }
  };

  /** Place everyone in their kickoff formation and stop the ball. */
  World.prototype.kickoff = function (team, unrestricted) {
    var S = this.stadium;
    this.koTeam = team === 'blue' ? 'blue' : 'red';
    this.koActive = !unrestricted;
    this.koTicks = 0;
    this.ball.x = 0; this.ball.y = 0; this.ball.vx = 0; this.ball.vy = 0;
    this.ball.px = 0; this.ball.py = 0;
    var counts = { red: 0, blue: 0 };
    var sizes = { red: this.teamSize('red'), blue: this.teamSize('blue') };
    var sorted = this.players.slice().sort(function (a, b) { return a.seat - b.seat; });
    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      var n = Math.min(4, Math.max(1, sizes[p.team]));
      var form = FORMATIONS[n];
      var slot = form[Math.min(form.length - 1, counts[p.team]++)];
      var sign = p.team === 'red' ? 1 : -1;
      p.x = slot[0] * S.halfW * sign;
      p.y = slot[1] * S.halfH;
      p.px = p.x; p.py = p.y;
      p.vx = 0; p.vy = 0;
      p.inX = 0; p.inY = 0; p.inKick = false; p.kickArmed = true;
    }
    this._buildKickoffBarriers();
  };

  World.prototype._buildKickoffBarriers = function () {
    var S = this.stadium;
    var other = this.koTeam === 'red' ? CG.blue : CG.red;
    // Halfway line: each team stays on its own side until the ball is touched.
    this._koBarriers = [
      plane(-1, 0, 0, 0.1, CG.red),
      plane(1, 0, 0, 0.1, CG.blue),
    ];
    // The defending team also has to stay out of the centre circle.
    this._koCircle = {
      x: 0, y: 0, vx: 0, vy: 0, r: S.circle,
      invMass: 0, bCoef: 0.1, damping: 1,
      cGroup: CG.wall, cMask: other,
    };
  };

  World.prototype.reset = function () {
    this.redScore = 0;
    this.blueScore = 0;
    this.tick = 0;
    this.kickoff('red');
  };

  /**
   * Advance one fixed 60 Hz tick. Returns { team } when a goal was scored.
   * Notable collisions/kicks are pushed onto `world.events` for the host's
   * sound layer to drain.
   */
  World.prototype.step = function () {
    var S = this.stadium;
    var ball = this.ball;
    var i, p;
    this.tick++;

    // Remember where everything was so the renderer can interpolate.
    for (i = 0; i < this._all.length; i++) {
      this._all[i].px = this._all[i].x;
      this._all[i].py = this._all[i].y;
    }

    if (this.frozen) {
      // Still resolve overlaps so nobody is stuck inside another disc.
      this._collide();
      return null;
    }

    if (this.koActive && ++this.koTicks >= KICKOFF_LIMIT_TICKS) this.koActive = false;

    // 1. Movement acceleration.
    for (i = 0; i < this.players.length; i++) {
      p = this.players[i];
      p.damping = p.inKick ? PHYS.kickingDamping : PHYS.playerDamping;
      if (p.inX || p.inY) {
        var len = Math.sqrt(p.inX * p.inX + p.inY * p.inY);
        var a = p.inKick ? PHYS.kickingAccel : PHYS.playerAccel;
        p.vx += (p.inX / len) * a;
        p.vy += (p.inY / len) * a;
      }
      if (p.kickFlash > 0) p.kickFlash--;
    }

    // 2. Kicks — a fresh press is required for each kick.
    var reach = PHYS.playerRadius + PHYS.ballRadius + PHYS.kickRange;
    for (i = 0; i < this.players.length; i++) {
      p = this.players[i];
      if (!p.inKick || !p.kickArmed) continue;
      var dx = ball.x - p.x;
      var dy = ball.y - p.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > reach || d === 0) continue;
      var nx = dx / d;
      var ny = dy / d;
      ball.vx += nx * PHYS.kickStrength * ball.invMass;
      ball.vy += ny * PHYS.kickStrength * ball.invMass;
      p.vx -= nx * PHYS.kickback;
      p.vy -= ny * PHYS.kickback;
      p.kickArmed = false;
      p.kickFlash = 8;
      this.koActive = false;
      this.events.push({ t: 'kick', x: ball.x, y: ball.y, team: p.team });
    }

    // 3. Integrate.
    var prevBallX = ball.x;
    for (i = 0; i < this.players.length; i++) {
      p = this.players[i];
      p.x += p.vx; p.y += p.vy;
      p.vx *= p.damping; p.vy *= p.damping;
    }
    ball.x += ball.vx; ball.y += ball.vy;
    ball.vx *= ball.damping; ball.vy *= ball.damping;

    // 4. Collisions.
    this._collide();

    // 5. Goal line — the ball's centre has to cross it between the posts.
    var line = S.halfW;
    if (prevBallX > -line && ball.x <= -line && Math.abs(ball.y) < S.goalHalf) {
      this.blueScore++;
      this.events.push({ t: 'goal', team: 'blue' });
      return { team: 'blue' };
    }
    if (prevBallX < line && ball.x >= line && Math.abs(ball.y) < S.goalHalf) {
      this.redScore++;
      this.events.push({ t: 'goal', team: 'red' });
      return { team: 'red' };
    }
    return null;
  };

  World.prototype._collide = function () {
    var S = this.stadium;
    var ball = this.ball;
    var all = this._all;
    var i, j;
    var hit = { impact: 0, hit: false };

    for (i = 0; i < all.length; i++) {
      for (j = i + 1; j < all.length; j++) {
        hit.impact = 0; hit.hit = false;
        collideDiscs(all[i], all[j], hit);
        if (hit.hit && (all[i] === ball || all[j] === ball)) {
          // Any touch releases the kickoff barrier.
          this.koActive = false;
          if (hit.impact > 1.2) this.events.push({ t: 'bump', x: ball.x, y: ball.y, v: hit.impact });
        }
      }
    }

    for (i = 0; i < all.length; i++) {
      var d = all[i];
      for (j = 0; j < S.posts.length; j++) {
        hit.impact = 0;
        collideDiscs(d, S.posts[j], hit);
        if (hit.impact > 1.5 && d === ball) this.events.push({ t: 'post', x: d.x, y: d.y });
      }
      for (j = 0; j < S.segments.length; j++) {
        hit.impact = 0;
        collideSegment(d, S.segments[j], hit);
        if (hit.impact > 1.5 && d === ball) this.events.push({ t: 'wall', x: d.x, y: d.y, v: hit.impact });
      }
      for (j = 0; j < S.planes.length; j++) collidePlane(d, S.planes[j], null);
      if (this.koActive) {
        for (j = 0; j < this._koBarriers.length; j++) collidePlane(d, this._koBarriers[j], null);
        if (this._koCircle) collideDiscs(d, this._koCircle, null);
      }
    }
  };

  // ───────────────────────────── bots ─────────────────────────────

  var BOT = {
    thinkTicks: 8,     // re-decide ~7×/s
    jitter: 12,        // aim wobble in world units
    kickAlign: 0.45,   // how well lined up a shot must be
    kickChance: 0.85,  // chance to take the shot on a given decision
  };

  /**
   * Drive every CPU player. Bots go through the exact same input path as a
   * phone, so their physics are identical to a human's.
   */
  World.prototype.stepBots = function () {
    var S = this.stadium;
    var ball = this.ball;
    var i, p;

    // One player per team goes for the ball; the rest hold shape. Humans count
    // too, so a bot never fights its own teammate for the same touch.
    var chaser = { red: null, blue: null };
    var chaseD = { red: Infinity, blue: Infinity };
    for (i = 0; i < this.players.length; i++) {
      p = this.players[i];
      var d = Math.hypot(p.x - ball.x, p.y - ball.y);
      if (d < chaseD[p.team]) { chaseD[p.team] = d; chaser[p.team] = p; }
    }

    var reach = PHYS.playerRadius + PHYS.ballRadius + PHYS.kickRange;
    var behind = PHYS.playerRadius + PHYS.ballRadius - 2;
    var ballSpeed = Math.hypot(ball.vx, ball.vy);

    for (i = 0; i < this.players.length; i++) {
      p = this.players[i];
      if (!p.isBot) continue;
      var b = p.bot;
      if (this.tick >= b.until) {
        b.until = this.tick + BOT.thinkTicks;
        b.jx = (Math.random() * 2 - 1) * BOT.jitter;
        b.jy = (Math.random() * 2 - 1) * BOT.jitter;
        b.shoot = Math.random() < BOT.kickChance;
      }
      var ownGoalX = p.team === 'red' ? -S.halfW : S.halfW;
      var oppGoalX = -ownGoalX;

      // Unit vector from the ball towards the goal we're attacking.
      var gx = oppGoalX - ball.x;
      var gy = 0 - ball.y;
      var gl = Math.hypot(gx, gy) || 1;
      gx /= gl; gy /= gl;

      // Vector from the ball out to us.
      var mx = p.x - ball.x;
      var my = p.y - ball.y;
      var ml = Math.hypot(mx, my) || 1;
      var align = (-mx / ml) * gx + (-my / ml) * gy;

      var tx, ty;
      var kick = false;

      if (chaser[p.team] === p) {
        // Attack: line up behind the ball and drive it at the goal.
        tx = ball.x - gx * behind + b.jx;
        ty = ball.y - gy * behind + b.jy;
        if ((mx / ml) * gx + (my / ml) * gy > -0.15 && ml < behind * 3.5) {
          // We're on the goal side of the ball — swing around instead of
          // shoving it back the way it came.
          var side = (-gy * mx + gx * my) >= 0 ? 1 : -1;
          tx = ball.x + -gy * side * behind * 2.2 - gx * behind * 0.6;
          ty = ball.y + gx * side * behind * 2.2 - gy * behind * 0.6;
        }
        var inRange = ml <= reach - 1;
        // Take the shot when lined up, or just belt it if the ball has gone dead
        // in a scrum.
        kick = b.shoot && inRange && (align > BOT.kickAlign || ballSpeed < 0.5);
      } else if ((p.team === 'red') === (ball.x < 0)) {
        // Ball in our half: sit goal-side of it.
        tx = ownGoalX + (ball.x - ownGoalX) * 0.38;
        ty = ball.y * 0.5;
        kick = b.shoot && ml <= reach - 1;
      } else {
        // Ball up the other end: trail the play, spread off the ball line.
        tx = ball.x - gx * S.halfW * 0.28;
        ty = ball.y + (p.seat % 2 === 0 ? -1 : 1) * S.halfH * 0.45;
        kick = b.shoot && ml <= reach - 1 && align > BOT.kickAlign;
      }

      // Keep targets inside the pitch so bots don't grind along a wall.
      tx = Math.max(-S.halfW + p.r, Math.min(S.halfW - p.r, tx));
      ty = Math.max(-S.halfH + p.r, Math.min(S.halfH - p.r, ty));

      var dx = tx - p.x;
      var dy = ty - p.y;
      var ix = 0, iy = 0;
      if (Math.hypot(dx, dy) > 5) {
        // Quantise to the 8 directions a phone stick can send.
        var oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
        ix = Math.round(Math.cos(oct * Math.PI / 4));
        iy = Math.round(Math.sin(oct * Math.PI / 4));
      }
      this.setInput(p.id, ix, iy, kick);
    }
  };

  var api = {
    World: World,
    PHYS: PHYS,
    STEP: STEP,
    CG: CG,
    TIERS: TIERS,
    TIER_SPECS: TIER_SPECS,
    FORMATIONS: FORMATIONS,
    makeStadium: makeStadium,
    pickTier: pickTier,
    NET_DEPTH: NET_DEPTH,
  };

  if (typeof window !== 'undefined') window.PuckBall = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
