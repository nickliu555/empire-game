(function () {
  'use strict';

  // Puck Ball host renderer — draws the whole stadium fitted to the canvas
  // (no camera follow: everyone watches the same TV).

  var COLORS = {
    grass: '#4E7A3A',
    grassAlt: '#527F3D',
    line: 'rgba(255,255,255,0.72)',
    out: '#2F4A26',
    red: '#E43B3B',
    redDeep: '#8E1E1E',
    blue: '#2F7DE0',
    blueDeep: '#173F79',
    ball: '#FAFAF6',
    post: '#F2F2EA',
    rail: '#F4F9F5',
    net: 'rgba(255,255,255,0.30)',
  };

  function lerp(a, b, t) { return a + (b - a) * t; }

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.flash = 0;
    this.flashTeam = null;
    this.trail = [];
    this.particles = [];
    this.resize();
  }

  Renderer.prototype.setWorld = function (world) {
    this.world = world;
    this.trail.length = 0;
    this.particles.length = 0;
    this.resize();
  };

  Renderer.prototype.resize = function () {
    var c = this.canvas;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = c.clientWidth || 800;
    var h = c.clientHeight || 450;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cw = w;
    this.ch = h;
    this._fit();
  };

  Renderer.prototype._fit = function () {
    var S = this.world.stadium;
    var padX = 44;
    var padY = 30;
    var worldW = (S.outX + padX) * 2;
    var worldH = (S.outY + padY) * 2;
    this.scale = Math.min(this.cw / worldW, this.ch / worldH);
    this.ox = this.cw / 2;
    this.oy = this.ch / 2;
  };

  Renderer.prototype.goalFlash = function (team) {
    this.flash = 1;
    this.flashTeam = team;
  };

  // Particle splash for goals. Coordinates are world units, speeds per second.
  Renderer.prototype.spawnBurst = function (x, y, color, n) {
    n = n || 20;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 60 + Math.random() * 260;
      this.particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.7 + Math.random() * 0.7, age: 0,
        color: color, r: 1.6 + Math.random() * 3.2,
      });
    }
  };

  Renderer.prototype._updateParticles = function (dt) {
    var alive = [];
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      alive.push(p);
    }
    this.particles = alive;
  };

  Renderer.prototype._drawParticles = function (ctx) {
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype.render = function (alpha, dt) {
    var ctx = this.ctx;
    var S = this.world.stadium;
    if (typeof alpha !== 'number') alpha = 1;
    if (typeof dt !== 'number' || !(dt > 0)) dt = 1 / 60;
    this._fit();

    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.fillStyle = COLORS.out;
    ctx.fillRect(0, 0, this.cw, this.ch);

    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);

    this._drawPitch(ctx, S);
    this._drawGoals(ctx, S);

    var ball = this.world.ball;
    var bx = lerp(ball.px, ball.x, alpha);
    var by = lerp(ball.py, ball.y, alpha);
    this._drawTrail(ctx, bx, by, ball);

    var players = this.world.players;
    for (var i = 0; i < players.length; i++) {
      this._drawPlayer(ctx, players[i], alpha);
    }
    this._drawBall(ctx, bx, by);

    if (this.particles.length) {
      this._updateParticles(dt);
      this._drawParticles(ctx);
    }

    ctx.restore();

    if (this.flash > 0) {
      var col = this.flashTeam === 'red' ? '228,59,59' : '47,125,224';
      ctx.fillStyle = 'rgba(' + col + ',' + (this.flash * 0.34) + ')';
      ctx.fillRect(0, 0, this.cw, this.ch);
      this.flash = Math.max(0, this.flash - 0.03);
    }
  };

  Renderer.prototype._drawPitch = function (ctx, S) {
    var stripes = 10;
    var stripeW = (S.halfW * 2) / stripes;
    ctx.fillStyle = COLORS.grass;
    ctx.fillRect(-S.halfW, -S.halfH, S.halfW * 2, S.halfH * 2);
    ctx.fillStyle = COLORS.grassAlt;
    for (var i = 0; i < stripes; i += 2) {
      ctx.fillRect(-S.halfW + i * stripeW, -S.halfH, stripeW, S.halfH * 2);
    }

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = COLORS.line;
    ctx.strokeRect(-S.halfW, -S.halfH, S.halfW * 2, S.halfH * 2);

    ctx.beginPath();
    ctx.moveTo(0, -S.halfH);
    ctx.lineTo(0, S.halfH);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, S.circle, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.line;
    ctx.fill();

    // Six-yard boxes.
    var boxW = S.halfW * 0.16;
    var boxH = S.goalHalf * 1.9;
    ctx.strokeRect(-S.halfW, -boxH, boxW, boxH * 2);
    ctx.strokeRect(S.halfW - boxW, -boxH, boxW, boxH * 2);
  };

  Renderer.prototype._drawGoals = function (ctx, S) {
    var d = S.netDepth;
    for (var side = -1; side <= 1; side += 2) {
      var line = side * S.halfW;
      var outer = side * (S.halfW + d);
      var x0 = Math.min(line, outer);
      var tint = side < 0 ? '228,59,59' : '47,125,224';

      // Netting inside the pocket, washed in the defending team's colour.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, -S.goalHalf, d, S.goalHalf * 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.fillRect(x0, -S.goalHalf, d, S.goalHalf * 2);
      ctx.fillStyle = 'rgba(' + tint + ',0.22)';
      ctx.fillRect(x0, -S.goalHalf, d, S.goalHalf * 2);
      ctx.strokeStyle = COLORS.net;
      ctx.lineWidth = 1;
      for (var gx = x0; gx <= x0 + d; gx += 7) {
        ctx.beginPath(); ctx.moveTo(gx, -S.goalHalf); ctx.lineTo(gx, S.goalHalf); ctx.stroke();
      }
      for (var gy = -S.goalHalf; gy <= S.goalHalf; gy += 7) {
        ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0 + d, gy); ctx.stroke();
      }
      ctx.restore();

      // Goal line (the scoring line) — a pitch marking, not part of the frame,
      // so it stays lighter than the rail around the posts.
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(line, -S.goalHalf);
      ctx.lineTo(line, S.goalHalf);
      ctx.stroke();

      // Rail around the outer walls of the pocket, so the goal box is framed
      // the same way as the field border.
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(line, -S.goalHalf);
      ctx.lineTo(outer, -S.goalHalf);
      ctx.lineTo(outer, S.goalHalf);
      ctx.lineTo(line, S.goalHalf);
      ctx.strokeStyle = 'rgba(0,0,0,0.38)';
      ctx.lineWidth = 7.5;
      ctx.stroke();
      ctx.strokeStyle = COLORS.rail;
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    for (var i = 0; i < S.posts.length; i++) {
      var p = S.posts[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.post;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.rail;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, p.r - 1), 0, Math.PI * 2);
      ctx.stroke();
    }
  };

  Renderer.prototype._drawTrail = function (ctx, bx, by, ball) {
    var speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed > 1.2) this.trail.push({ x: bx, y: by });
    while (this.trail.length > 14) this.trail.shift();
    if (speed < 0.4 && this.trail.length) this.trail.shift();
    for (var i = 0; i < this.trail.length; i++) {
      var t = (i + 1) / this.trail.length;
      ctx.beginPath();
      ctx.arc(this.trail[i].x, this.trail[i].y, ball.r * 0.75 * t, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.16 * t) + ')';
      ctx.fill();
    }
  };

  Renderer.prototype._drawPlayer = function (ctx, p, alpha) {
    var x = lerp(p.px, p.x, alpha);
    var y = lerp(p.py, p.y, alpha);
    var fill = p.team === 'red' ? COLORS.red : COLORS.blue;
    var edge = p.team === 'red' ? COLORS.redDeep : COLORS.blueDeep;

    ctx.globalAlpha = p.connected ? 1 : 0.45;

    ctx.beginPath();
    ctx.arc(x, y + 3, p.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.inKick ? '#FFFFFF' : edge;
    ctx.stroke();

    if (p.kickFlash > 0) {
      ctx.beginPath();
      ctx.arc(x, y, p.r + 4 + (8 - p.kickFlash), 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,' + (p.kickFlash / 10) + ')';
      ctx.stroke();
    }

    // Name plate under the disc — kept short so a full roster stays readable.
    var label = p.name.length > 12 ? p.name.slice(0, 11) + '…' : p.name;
    ctx.font = '700 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var w = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    var rx = x - w / 2 - 5;
    var ry = y + p.r + 4;
    var rw = w + 10;
    var rh = 16;
    var rr = 5;
    ctx.moveTo(rx + rr, ry);
    ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, rr);
    ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, rr);
    ctx.arcTo(rx, ry + rh, rx, ry, rr);
    ctx.arcTo(rx, ry, rx + rw, ry, rr);
    ctx.fill();
    ctx.fillStyle = p.connected ? '#fff' : 'rgba(255,255,255,0.75)';
    ctx.fillText(label, x, ry + 2);

    if (p.emote && p.emote.until > Date.now()) {
      ctx.font = '22px Inter, system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(p.emote.e, x, y - p.r - 6);
    }

    ctx.globalAlpha = 1;
  };

  Renderer.prototype._drawBall = function (ctx, bx, by) {
    var r = this.world.ball.r;
    ctx.beginPath();
    ctx.arc(bx, by + 3, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.ball;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(bx, by, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fill();
  };

  window.PuckBallRender = { Renderer: Renderer, COLORS: COLORS };
}());
