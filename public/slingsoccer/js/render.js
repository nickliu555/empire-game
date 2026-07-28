/* Sling Soccer — top-down canvas renderer.
 *
 * Draws a birds-eye grass pitch (stripes, boundary + centre + penalty lines,
 * side goals with nets) and the dynamic layer (numbered tokens, the ball, the
 * active-token highlight, and the live slingshot aim: pull band, launch arrow,
 * dotted trajectory + power). World units come from the engine (1500x1000 plus
 * the goal pockets); the canvas is fit with letterboxing at device resolution.
 */
(function () {
  'use strict';

  const COL = {
    grassA: '#2f9e57',
    grassB: '#2a924f',
    line: 'rgba(255,255,255,0.5)',
    lineSoft: 'rgba(255,255,255,0.6)',
    surround: '#0c3a22',
    net: 'rgba(255,255,255,0.5)',
    post: '#f4f7f5',
    red: '#e4483b',
    redDeep: '#a52a22',
    blue: '#2f7de0',
    blueDeep: '#1b4e96',
    ball: '#ffffff',
    ballDark: '#1c2530',
    aim: '#f4c430',
  };

  // The surround behind each goal is washed in the defending team's colour so
  // it's obvious whose end is whose (red keeps the left goal, blue the right).
  // ZONE_W is reserved in the world box so the wash is visible even when there
  // is no letterbox slack; it spreads into any extra space beyond that.
  const ZONE_W = 132;

  function lerp(a, b, t) { return a + (b - a) * t; }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Classic soccer ball geometry (truncated icosahedron): 60 vertices, 90 panel
  // edges (the seams), 12 black pentagon faces + 20 white hexagons. We fill the
  // pentagons and stroke every edge as a faint seam so the seams connect the
  // hexagons like a real ball. All rotated with the ball's travel to roll.
  const BALL_GEO = (function () {
    const P = 1.6180339887;
    // 60 vertices = cyclic permutations + all sign combos of three base triples.
    const bases = [
      [0, 1, 3 * P],
      [1, 2 + P, 2 * P],
      [P, 2, 2 * P + 1],
    ];
    const verts = [], seen = {};
    function add(x, y, z) {
      const L = Math.hypot(x, y, z);
      const v = [x / L, y / L, z / L];
      const key = v[0].toFixed(4) + ',' + v[1].toFixed(4) + ',' + v[2].toFixed(4);
      if (seen[key]) return; seen[key] = 1; verts.push(v);
    }
    bases.forEach(function (b) {
      for (let s = 0; s < 8; s++) {
        const a = ((s & 1) ? -1 : 1) * b[0], c = ((s & 2) ? -1 : 1) * b[1], d = ((s & 4) ? -1 : 1) * b[2];
        add(a, c, d); add(d, a, c); add(c, d, a);   // 3 cyclic permutations
      }
    });
    // Seams: join each vertex to its 3 nearest neighbours (the polyhedron edges).
    const seams = [], eseen = {};
    for (let i = 0; i < verts.length; i++) {
      const ds = [];
      for (let j = 0; j < verts.length; j++) {
        if (j === i) continue;
        const dx = verts[i][0] - verts[j][0], dy = verts[i][1] - verts[j][1], dz = verts[i][2] - verts[j][2];
        ds.push([dx * dx + dy * dy + dz * dz, j]);
      }
      ds.sort(function (a, b) { return a[0] - b[0]; });
      for (let k = 0; k < 3; k++) {
        const j = ds[k][1], key = i < j ? i + '_' + j : j + '_' + i;
        if (eseen[key]) continue; eseen[key] = 1;
        seams.push([verts[i], verts[j]]);
      }
    }
    // Pentagon faces sit at the 12 icosahedron directions: take the 5 nearest
    // vertices to each and order them around the centre.
    const n = Math.hypot(1, P);
    const centers = [
      [0, 1, P], [0, 1, -P], [0, -1, P], [0, -1, -P],
      [1, P, 0], [1, -P, 0], [-1, P, 0], [-1, -P, 0],
      [P, 0, 1], [-P, 0, 1], [P, 0, -1], [-P, 0, -1],
    ].map(function (v) { return [v[0] / n, v[1] / n, v[2] / n]; });
    const pentFaces = centers.map(function (c) {
      const scored = verts.map(function (v, idx) { return [v[0] * c[0] + v[1] * c[1] + v[2] * c[2], idx]; });
      scored.sort(function (a, b) { return b[0] - a[0]; });
      const picked = scored.slice(0, 5).map(function (s) { return verts[s[1]]; });
      const a = Math.abs(c[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const dd = a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
      let u = [a[0] - dd * c[0], a[1] - dd * c[1], a[2] - dd * c[2]];
      const ul = Math.hypot(u[0], u[1], u[2]); u = [u[0] / ul, u[1] / ul, u[2] / ul];
      const w = [c[1] * u[2] - c[2] * u[1], c[2] * u[0] - c[0] * u[2], c[0] * u[1] - c[1] * u[0]];
      picked.sort(function (A, B) {
        return Math.atan2(A[0] * w[0] + A[1] * w[1] + A[2] * w[2], A[0] * u[0] + A[1] * u[1] + A[2] * u[2])
          - Math.atan2(B[0] * w[0] + B[1] * w[1] + B[2] * w[2], B[0] * u[0] + B[1] * u[1] + B[2] * u[2]);
      });
      return { c: c, verts: picked };
    });
    return { pentFaces: pentFaces, seams: seams };
  })();

  class Renderer {
    constructor(canvas, world) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = world;
      this.f = world.field;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Extra world margin so the goal pockets (x<0, x>W) and the team-coloured
      // end zones behind them are on-screen.
      this.padX = this.f.GOAL_DEPTH + ZONE_W;
      this.padY = 26;
      this.scale = 1; this.offX = 0; this.offY = 0;
      this.particles = [];
      // Ball orientation: a 3x3 rotation matrix (row-major) advanced by travel
      // so the printed spots roll. `_ballPrev` tracks last position for the delta.
      this._ballRot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      this._ballPrev = null;
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width * this.dpr));
      const ch = Math.max(1, Math.round(rect.height * this.dpr));
      if (this.canvas.width !== cw) this.canvas.width = cw;
      if (this.canvas.height !== ch) this.canvas.height = ch;
      const worldW = this.f.W + 2 * this.padX;
      const worldH = this.f.H + 2 * this.padY;
      const s = Math.min(cw / worldW, ch / worldH);
      this.scale = s;
      this.offX = (cw - worldW * s) / 2 + this.padX * s;
      this.offY = (ch - worldH * s) / 2 + this.padY * s;
    }

    // Map convenience.
    _applyTransform() {
      const s = this.scale;
      this.ctx.setTransform(s, 0, 0, s, this.offX, this.offY);
    }

    render(opts) {
      const ctx = this.ctx;
      const f = this.f;
      opts = opts || {};
      // Clear to the stadium surround.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = COL.surround;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      this._applyTransform();
      this._drawEndZones();
      this._drawPitch();
      this._drawBoundary();
      this._drawGoals();
      // Aim (drawn under the tokens so the disc + number stay crisp on top).
      if (opts.aim) this._drawAim(opts.aim);
      this._drawBall();
      this._drawTokens(opts.active);
      this._updateParticles(opts.dt || 0.016);
      this._drawParticles();
    }

    // Team end zones: the stadium floor behind each goal glows in the colour of
    // the team defending it. It's an unclipped ellipse centred just outside the
    // back of the net, so the colour falls off smoothly in every direction —
    // there is no edge to it anywhere. Drawn before the pitch, so the grass
    // covers everything from the goal line inwards.
    _drawEndZones() {
      const ctx = this.ctx, f = this.f;
      const cy = f.H / 2;
      const zones = [
        { cx: -f.GOAL_DEPTH - 24, rgb: '255,92,78' },
        { cx: f.W + f.GOAL_DEPTH + 24, rgb: '86,160,255' },
      ];
      const rx = ZONE_W * 1.5, ry = f.H * 0.62;
      for (const z of zones) {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        g.addColorStop(0, 'rgba(' + z.rgb + ',0.88)');
        g.addColorStop(0.35, 'rgba(' + z.rgb + ',0.62)');
        g.addColorStop(0.7, 'rgba(' + z.rgb + ',0.24)');
        g.addColorStop(1, 'rgba(' + z.rgb + ',0)');
        ctx.save();
        ctx.translate(z.cx, cy);
        ctx.scale(1, ry / rx);
        ctx.fillStyle = g;
        ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
        ctx.restore();
      }
    }

    _drawPitch() {
      const ctx = this.ctx, f = this.f;
      const m = f.FIELD_MARGIN || 24;
      const cc = f.CORNER_CHAMFER || 0;
      // Grass, clipped to the chamfered-corner octagon so the pitch has NO square
      // corners at all (matches the physics corner cut — no leftover rectangle).
      ctx.save();
      if (cc > 0) {
        ctx.beginPath();
        ctx.moveTo(cc, 0);
        ctx.lineTo(f.W - cc, 0);
        ctx.lineTo(f.W, cc);
        ctx.lineTo(f.W, f.H - cc);
        ctx.lineTo(f.W - cc, f.H);
        ctx.lineTo(cc, f.H);
        ctx.lineTo(0, f.H - cc);
        ctx.lineTo(0, cc);
        ctx.closePath();
        ctx.clip();
      }
      // Mowed stripes.
      const stripes = 10;
      for (let i = 0; i < stripes; i++) {
        ctx.fillStyle = i % 2 === 0 ? COL.grassA : COL.grassB;
        ctx.fillRect((f.W / stripes) * i, 0, f.W / stripes + 1, f.H);
      }
      ctx.restore();
      // Boundary (chamfered to match the corners).
      ctx.strokeStyle = COL.line;
      ctx.lineWidth = 6;
      if (cc > 0) {
        ctx.beginPath();
        ctx.moveTo(cc, m); ctx.lineTo(f.W - cc, m);            // top
        ctx.lineTo(f.W - m, cc); ctx.lineTo(f.W - m, f.H - cc); // right
        ctx.lineTo(f.W - cc, f.H - m); ctx.lineTo(cc, f.H - m); // bottom
        ctx.lineTo(m, f.H - cc); ctx.lineTo(m, cc);            // left
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.strokeRect(m, m, f.W - 2 * m, f.H - 2 * m);
      }
      // Halfway line + centre circle + spot.
      ctx.beginPath();
      ctx.moveTo(f.W / 2, m); ctx.lineTo(f.W / 2, f.H - m);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(f.W / 2, f.H / 2, f.H * 0.14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = COL.line;
      ctx.beginPath(); ctx.arc(f.W / 2, f.H / 2, 8, 0, Math.PI * 2); ctx.fill();
      // Penalty boxes (near each goal mouth).
      const boxW = f.PBOX_W || 180, boxH = f.GOAL_H + f.H * 0.2;
      const boxTop = (f.H - boxH) / 2;
      ctx.strokeRect(m, boxTop, boxW, boxH);
      ctx.strokeRect(f.W - m - boxW, boxTop, boxW, boxH);
      // Six-yard boxes.
      const sixW = Math.round((f.PBOX_W || 180) * 0.5), sixH = f.GOAL_H + f.H * 0.06;
      const sixTop = (f.H - sixH) / 2;
      ctx.strokeRect(m, sixTop, sixW, sixH);
      ctx.strokeRect(f.W - m - sixW, sixTop, sixW, sixH);
    }

    // The TRUE field edge (where the ball actually bounces), drawn as a bold rail
    // around the grass octagon so it's obvious where the pitch ends — clearly
    // distinct from the thin inner markings. Gaps are left at the goal mouths.
    _drawBoundary() {
      const ctx = this.ctx, f = this.f;
      const cc = f.CORNER_CHAMFER || 0;
      const path = function () {
        ctx.beginPath();
        ctx.moveTo(cc, 0);
        ctx.lineTo(f.W - cc, 0);              // top edge
        ctx.lineTo(f.W, cc);                  // top-right chamfer
        ctx.lineTo(f.W, f.GOAL_TOP);          // right edge → mouth
        ctx.moveTo(f.W, f.GOAL_BOT);          // (skip the goal mouth)
        ctx.lineTo(f.W, f.H - cc);
        ctx.lineTo(f.W - cc, f.H);            // bottom-right chamfer
        ctx.lineTo(cc, f.H);                  // bottom edge
        ctx.lineTo(0, f.H - cc);              // bottom-left chamfer
        ctx.lineTo(0, f.GOAL_BOT);            // left edge → mouth
        ctx.moveTo(0, f.GOAL_TOP);            // (skip the goal mouth)
        ctx.lineTo(0, cc);
        ctx.lineTo(cc, 0);                    // top-left chamfer
      };
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // Dark base gives the rail a raised, framed feel against the grass.
      ctx.strokeStyle = 'rgba(0,0,0,0.38)';
      ctx.lineWidth = 15;
      path(); ctx.stroke();
      // Bright rail on top.
      ctx.strokeStyle = '#f4f9f5';
      ctx.lineWidth = 8;
      path(); ctx.stroke();
    }

    _drawGoals() {
      const ctx = this.ctx, f = this.f;
      // Neutral white goals — team identity lives in the stands behind each end.
      const sides = [
        { x0: -f.GOAL_DEPTH, outer: -f.GOAL_DEPTH, line: 0 },
        { x0: f.W, outer: f.W + f.GOAL_DEPTH, line: f.W },
      ];
      const RAIL = '#f4f9f5';
      for (const s of sides) {
        // Netting inside the pocket.
        ctx.save();
        ctx.beginPath();
        ctx.rect(s.x0, f.GOAL_TOP, f.GOAL_DEPTH, f.GOAL_H);
        ctx.clip();
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(s.x0, f.GOAL_TOP, f.GOAL_DEPTH, f.GOAL_H);
        ctx.strokeStyle = COL.net;
        ctx.lineWidth = 1.5;
        for (let gx = s.x0; gx <= s.x0 + f.GOAL_DEPTH; gx += 14) {
          ctx.beginPath(); ctx.moveTo(gx, f.GOAL_TOP); ctx.lineTo(gx, f.GOAL_TOP + f.GOAL_H); ctx.stroke();
        }
        for (let gy = f.GOAL_TOP; gy <= f.GOAL_TOP + f.GOAL_H; gy += 14) {
          ctx.beginPath(); ctx.moveTo(s.x0, gy); ctx.lineTo(s.x0 + f.GOAL_DEPTH, gy); ctx.stroke();
        }
        ctx.restore();
        // Goal line (the scoring line).
        ctx.strokeStyle = RAIL;
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(s.line, f.GOAL_TOP); ctx.lineTo(s.line, f.GOAL_BOT);
        ctx.stroke();
        // Rail around the OUTER walls of the pocket (the part that juts away
        // from the pitch), matching the field border so the goal box is framed.
        const pocket = function () {
          ctx.beginPath();
          ctx.moveTo(s.line, f.GOAL_TOP);
          ctx.lineTo(s.outer, f.GOAL_TOP);
          ctx.lineTo(s.outer, f.GOAL_BOT);
          ctx.lineTo(s.line, f.GOAL_BOT);
        };
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.38)';
        ctx.lineWidth = 15;
        pocket(); ctx.stroke();
        ctx.strokeStyle = RAIL;
        ctx.lineWidth = 8;
        pocket(); ctx.stroke();
      }
      // Posts — solid round colliders sitting just outside each mouth edge.
      for (const p of f.posts) {
        ctx.fillStyle = COL.post;
        ctx.beginPath(); ctx.arc(p.x, p.y, f.POST_R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = RAIL;
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(p.x, p.y, f.POST_R - 1, 0, Math.PI * 2); ctx.stroke();
      }
    }

    _drawTokens(active) {
      const ctx = this.ctx;
      for (const t of this.world.tokens) {
        const isRed = t.team === 'red';
        const isActive = active && active.team === t.team && active.idx === t.idx;
        // Shadow.
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath(); ctx.ellipse(t.x + 3, t.y + 5, t.r, t.r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
        // Disc.
        const g = ctx.createRadialGradient(t.x - t.r * 0.4, t.y - t.r * 0.4, t.r * 0.2, t.x, t.y, t.r);
        g.addColorStop(0, isRed ? '#ff6a5e' : '#6aa8f2');
        g.addColorStop(1, isRed ? COL.redDeep : COL.blueDeep);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); ctx.fill();
        // Rim.
        ctx.lineWidth = 4;
        ctx.strokeStyle = isRed ? '#ffd2cc' : '#cfe2fb';
        ctx.beginPath(); ctx.arc(t.x, t.y, t.r - 2, 0, Math.PI * 2); ctx.stroke();
        // Number.
        ctx.fillStyle = '#fff';
        ctx.font = '900 ' + Math.round(t.r * 1.15) + 'px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(t.idx + 1), t.x, t.y + 1);
        // Active highlight ring (pulsing).
        if (isActive) {
          const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 140);
          ctx.strokeStyle = COL.aim;
          ctx.lineWidth = 4 + pulse * 3;
          ctx.beginPath(); ctx.arc(t.x, t.y, t.r + 8 + pulse * 4, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    // Rotate the ball's orientation matrix by rolling it `ang` radians about the
    // in-plane axis (ax, ay, 0) — Rodrigues' formula, left-multiplied.
    _rollBall(ax, ay, ang) {
      const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
      const R = [
        t * ax * ax + c, t * ax * ay, s * ay,
        t * ax * ay, t * ay * ay + c, -s * ax,
        -s * ay, s * ax, c,
      ];
      const M = this._ballRot, O = new Array(9);
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          O[row * 3 + col] = R[row * 3] * M[col] + R[row * 3 + 1] * M[3 + col] + R[row * 3 + 2] * M[6 + col];
        }
      }
      this._ballRot = O;
    }

    _drawBall() {
      const ctx = this.ctx, b = this.world.ball, r = b.r;
      // Advance the ball's spin from how far it moved since last frame. Rolling
      // without slipping => angle = distance / radius, about an axis ⟂ to travel.
      const prev = this._ballPrev;
      if (prev) {
        const dx = b.x - prev.x, dy = b.y - prev.y;
        const dist = Math.hypot(dx, dy);
        // Skip teleports (kickoff / goal resets) so it doesn't spin wildly.
        // Angle is negated because the canvas Y axis points down (otherwise the
        // ball appears to roll backwards relative to its travel).
        if (dist > 0.01 && dist < r * 4) this._rollBall(dy / dist, -dx / dist, -dist / r);
      }
      this._ballPrev = { x: b.x, y: b.y };

      // Drop shadow + white body.
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(b.x + 2, b.y + 4, r, r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.ball;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();

      // Black pentagons + connecting seams rolling on the front hemisphere,
      // clipped to the ball.
      const M = this._ballRot;
      ctx.save();
      ctx.beginPath(); ctx.arc(b.x, b.y, r - 0.5, 0, Math.PI * 2); ctx.clip();

      // 1) Fill the front-facing black pentagon panels.
      ctx.fillStyle = COL.ballDark;
      for (let i = 0; i < BALL_GEO.pentFaces.length; i++) {
        const pent = BALL_GEO.pentFaces[i], c = pent.c;
        const Zc = M[6] * c[0] + M[7] * c[1] + M[8] * c[2];
        if (Zc <= 0.10) continue;                      // only front-facing faces
        ctx.globalAlpha = Math.min(1, (Zc - 0.10) / 0.22);
        ctx.beginPath();
        for (let k = 0; k < pent.verts.length; k++) {
          const w = pent.verts[k];
          const X = M[0] * w[0] + M[1] * w[1] + M[2] * w[2];
          const Y = M[3] * w[0] + M[4] * w[1] + M[5] * w[2];
          if (k === 0) ctx.moveTo(b.x + X * r, b.y + Y * r);
          else ctx.lineTo(b.x + X * r, b.y + Y * r);
        }
        ctx.closePath(); ctx.fill();
      }

      // 2) Faint seams along every panel edge (front hemisphere only), so the
      //    hexagons read as real stitched panels.
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = r * 0.055;
      ctx.lineCap = 'round';
      for (let i = 0; i < BALL_GEO.seams.length; i++) {
        const v0 = BALL_GEO.seams[i][0], v1 = BALL_GEO.seams[i][1];
        const Z0 = M[6] * v0[0] + M[7] * v0[1] + M[8] * v0[2];
        const Z1 = M[6] * v1[0] + M[7] * v1[1] + M[8] * v1[2];
        if (Z0 < 0.04 || Z1 < 0.04) continue;          // keep to the near side
        ctx.globalAlpha = Math.min(1, (Math.min(Z0, Z1)) / 0.22) * 0.5;
        const X0 = M[0] * v0[0] + M[1] * v0[1] + M[2] * v0[2], Y0 = M[3] * v0[0] + M[4] * v0[1] + M[5] * v0[2];
        const X1 = M[0] * v1[0] + M[1] * v1[1] + M[2] * v1[2], Y1 = M[3] * v1[0] + M[4] * v1[1] + M[5] * v1[2];
        ctx.beginPath();
        ctx.moveTo(b.x + X0 * r, b.y + Y0 * r);
        ctx.lineTo(b.x + X1 * r, b.y + Y1 * r);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // Spherical shading (soft top-left highlight → shaded rim) for depth.
      const sh = ctx.createRadialGradient(b.x - r * 0.32, b.y - r * 0.36, r * 0.1, b.x, b.y, r);
      sh.addColorStop(0, 'rgba(255,255,255,0.35)');
      sh.addColorStop(0.55, 'rgba(255,255,255,0)');
      sh.addColorStop(1, 'rgba(0,0,0,0.20)');
      ctx.fillStyle = sh;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();

      // Rim.
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.arc(b.x, b.y, r - 1, 0, Math.PI * 2); ctx.stroke();
    }

    // aim = { team, idx, dx, dy }  where (dx,dy) is the PULL vector (|v|<=1 = power).
    _drawAim(aim) {
      const t = this.world.tokenAt(aim.team, aim.idx);
      if (!t) return;
      const power = Math.min(1, Math.hypot(aim.dx || 0, aim.dy || 0));
      if (power < 0.02) return;
      const ctx = this.ctx;
      const lx = -(aim.dx / power), ly = -(aim.dy / power); // unit launch dir
      const ang = Math.atan2(ly, lx);
      // Strength is signalled by COLOUR only — the bar's size is constant.
      const col = power > 0.7 ? '#ff5a4d' : power > 0.4 ? '#ffb03a' : COL.aim;
      // Pull band drawn back behind the token (opposite the launch) — shows the drag.
      const pullLen = 18 + power * 90;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x - lx * pullLen, t.y - ly * pullLen);
      ctx.stroke();
      // Projected-aim bar: as WIDE as the puck; its length GROWS with power up
      // to ~3 puck lengths, and its colour also signals strength.
      const diameter = t.r * 2;
      const barLen = diameter * (0.5 + power * 2.5);  // ~0.5 → 3 puck lengths
      const halfW = t.r;           // as wide as the token
      const gap = t.r + 3;
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(ang);
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = col;
      // Flat where it exits the token, rounded ONLY at the far tip.
      const x0 = gap;
      const capCenter = gap + barLen - halfW;
      ctx.beginPath();
      ctx.moveTo(x0, -halfW);
      ctx.lineTo(capCenter, -halfW);
      ctx.arc(capCenter, 0, halfW, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(x0, halfW);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // Single soft sightline down the middle, fading at both ends so it reads as an
      // integrated aim guide rather than a hard-painted stripe. Stays inside the bar.
      const lineStart = x0 + halfW * 0.35;
      const lineEnd = gap + barLen - halfW * 0.85;
      const grad = ctx.createLinearGradient(lineStart, 0, lineEnd, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.18, 'rgba(255,255,255,0.5)');
      grad.addColorStop(0.82, 'rgba(255,255,255,0.5)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(1.5, halfW * 0.14);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(lineStart, 0);
      ctx.lineTo(lineEnd, 0);
      ctx.stroke();
      ctx.restore();
    }

    // ---- Particles (goal + respawn puffs) ----
    spawnBurst(x, y, color, n) {
      n = n || 20;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 130 + Math.random() * 470;
        this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.7 + Math.random() * 0.7, age: 0, color, r: 3 + Math.random() * 5 });
      }
    }
    _updateParticles(dt) {
      for (const p of this.particles) {
        p.age += dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.94; p.vy *= 0.94;
      }
      this.particles = this.particles.filter((p) => p.age < p.life);
    }
    _drawParticles() {
      const ctx = this.ctx;
      for (const p of this.particles) {
        ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  window.SlingSoccerRender = { Renderer };
})();
