/* Maze Chomp — host canvas renderer. Draws the maze, pellets, fruit,
 * chompers (with mouth animation, power growth + end-of-power flash) and ghosts
 * (frightened / eyes states), plus per-player name tags and reaction bubbles.
 * Purely presentational — never mutates the world.
 */
(function (global) {
  'use strict';

  const WALL_COLOR = '#2323c8';
  const WALL_EDGE = '#4d4dff';
  const DOOR_COLOR = '#ff9edd';
  const PELLET_COLOR = '#ffd9a0';
  const POWER_COLOR = '#ffd9a0';
  const BG = '#05051e';
  const FRIGHT_BLUE = '#2b2bff';
  const FRIGHT_WHITE = '#ffffff';

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.resize();
  }

  Renderer.prototype.resize = function () {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    c.width = Math.floor(w * this.dpr);
    c.height = Math.floor(h * this.dpr);
    this.cssW = w; this.cssH = h;
  };

  Renderer.prototype._metrics = function () {
    const b = this.world.board;
    const ts = Math.floor(Math.min(this.cssW / b.w, this.cssH / b.h));
    const gw = ts * b.w, gh = ts * b.h;
    const ox = Math.floor((this.cssW - gw) / 2);
    const oy = Math.floor((this.cssH - gh) / 2);
    return { ts, ox, oy, gw, gh };
  };

  Renderer.prototype.render = function () {
    const ctx = this.ctx, b = this.world.board;
    if (!b) return;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const m = this._metrics();
    ctx.translate(m.ox, m.oy);
    const ts = m.ts;

    this._drawMaze(ctx, b, ts);
    this._drawPellets(ctx, b, ts);
    this._drawFruit(ctx, ts);
    this._drawGhosts(ctx, ts);
    this._drawChompers(ctx, ts);

    ctx.restore();
  };

  Renderer.prototype._drawMaze = function (ctx, b, ts) {
    for (let r = 0; r < b.h; r++) {
      for (let c = 0; c < b.w; c++) {
        const t = b.tiles[r][c];
        const x = c * ts, y = r * ts;
        if (t === 0) {
          ctx.fillStyle = WALL_COLOR;
          roundRect(ctx, x + ts * 0.08, y + ts * 0.08, ts * 0.84, ts * 0.84, ts * 0.28);
          ctx.fill();
          ctx.strokeStyle = WALL_EDGE;
          ctx.lineWidth = Math.max(1, ts * 0.06);
          ctx.stroke();
        } else if (t === 2) {
          ctx.fillStyle = DOOR_COLOR;
          ctx.fillRect(x + ts * 0.1, y + ts * 0.42, ts * 0.8, ts * 0.16);
        }
      }
    }
  };

  Renderer.prototype._drawPellets = function (ctx, b, ts) {
    ctx.fillStyle = PELLET_COLOR;
    for (const key of b.pellets) {
      const [r, c] = key.split(',').map(Number);
      ctx.beginPath();
      ctx.arc(c * ts + ts / 2, r * ts + ts / 2, Math.max(1.5, ts * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }
    // Power pellets pulse.
    const ac = (this.world.animClock != null) ? this.world.animClock : this.world.now;
    const pulse = 0.72 + 0.28 * Math.sin(ac * 6);
    ctx.fillStyle = POWER_COLOR;
    for (const key of b.powerPellets) {
      const [r, c] = key.split(',').map(Number);
      ctx.beginPath();
      ctx.arc(c * ts + ts / 2, r * ts + ts / 2, ts * 0.28 * pulse, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  Renderer.prototype._drawFruit = function (ctx, ts) {
    const f = this.world.fruit;
    if (!f) return;
    const cx = f.c * ts + ts / 2, cy = f.r * ts + ts / 2;
    // Cherry: two red balls + stems.
    ctx.strokeStyle = '#5c8a2a';
    ctx.lineWidth = Math.max(1.5, ts * 0.07);
    ctx.beginPath();
    ctx.moveTo(cx + ts * 0.02, cy + ts * 0.05);
    ctx.quadraticCurveTo(cx + ts * 0.18, cy - ts * 0.28, cx - ts * 0.02, cy - ts * 0.34);
    ctx.moveTo(cx + ts * 0.02, cy + ts * 0.05);
    ctx.quadraticCurveTo(cx - ts * 0.14, cy - ts * 0.2, cx - ts * 0.24, cy - ts * 0.3);
    ctx.stroke();
    ctx.fillStyle = '#ff2f45';
    ctx.beginPath(); ctx.arc(cx - ts * 0.16, cy + ts * 0.18, ts * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + ts * 0.16, cy + ts * 0.14, ts * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.arc(cx - ts * 0.22, cy + ts * 0.11, ts * 0.05, 0, Math.PI * 2); ctx.fill();
  };

  Renderer.prototype._drawGhosts = function (ctx, ts) {
    const w = this.world;
    const ac = (w.animClock != null) ? w.animClock : w.now;
    const frightLeft = w.frightUntil - ac;
    for (const g of w.ghosts) {
      if (g.state === 'pen' && w.now < g.releaseAt) { /* still draw waiting */ }
      const cx = g.x * ts + ts / 2, cy = g.y * ts + ts / 2;
      const r = ts * 0.42;
      if (g.state === 'eyes') { this._ghostEyes(ctx, cx, cy, r, g.dirIdx); continue; }
      let body = g.color;
      const frightened = (g.state === 'frightened');
      if (frightened) {
        // Flash white/blue in the final ~2s.
        body = (frightLeft < 2 && Math.floor(ac * 6) % 2 === 0) ? FRIGHT_WHITE : FRIGHT_BLUE;
      }
      this._ghostBody(ctx, cx, cy, r, body);
      if (frightened) this._frightFace(ctx, cx, cy, r, body === FRIGHT_WHITE ? '#ff2f45' : '#ffffff');
      else this._ghostEyes(ctx, cx, cy, r, g.dirIdx);
    }
  };

  Renderer.prototype._ghostBody = function (ctx, cx, cy, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.1, r, Math.PI, 0);
    const feet = 4, top = cy - r * 0.1, bot = cy + r * 0.95;
    ctx.lineTo(cx + r, bot);
    for (let i = 0; i < feet; i++) {
      const x1 = cx + r - (2 * r) * ((i + 0.5) / feet);
      const x2 = cx + r - (2 * r) * ((i + 1) / feet);
      ctx.lineTo(x1, bot - r * 0.28);
      ctx.lineTo(x2, bot);
    }
    ctx.lineTo(cx - r, top);
    ctx.closePath();
    ctx.fill();
  };
  Renderer.prototype._ghostEyes = function (ctx, cx, cy, r, dirIdx) {
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    const d = dirs[dirIdx >= 0 ? dirIdx : 3];
    const ex = r * 0.36, ey = -r * 0.15, er = r * 0.3, pr = r * 0.15;
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx + s * ex, cy + ey, er, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2323c8';
      ctx.beginPath(); ctx.arc(cx + s * ex + d[0] * pr, cy + ey + d[1] * pr, pr, 0, Math.PI * 2); ctx.fill();
    }
  };
  Renderer.prototype._frightFace = function (ctx, cx, cy, r, color) {
    ctx.fillStyle = color;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + s * r * 0.32, cy - r * 0.15, r * 0.12, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath();
    const y = cy + r * 0.35, amp = r * 0.14; let first = true;
    for (let i = 0; i <= 6; i++) {
      const x = cx - r * 0.6 + (1.2 * r) * (i / 6);
      const yy = y + (i % 2 === 0 ? -amp : amp);
      if (first) { ctx.moveTo(x, yy); first = false; } else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  };

  Renderer.prototype._drawChompers = function (ctx, ts) {
    const w = this.world;
    const DEATH = (window.MazeChomp && window.MazeChomp.DEATH_ANIM_SEC) || 0.9;
    // Cosmetic clock — frozen during the death-settle so the powered aura/flash
    // freeze too; the death animation itself uses the master clock (w.now).
    const ac = (w.animClock != null) ? w.animClock : w.now;
    for (const p of w.players) {
      if (!p.alive) {
        // Death animation: the mouth opens until the chomper closes into nothing.
        if (p.dying != null) {
          const t = (w.now - p.dying) / DEATH;
          if (t >= 0 && t < 1) this._drawDyingChomper(ctx, p, ts, t);
        }
        continue;
      }
      const cx = p.x * ts + ts / 2, cy = p.y * ts + ts / 2;
      const r = ts * (p.powered ? 0.66 : 0.44);
      const face = (p.facing != null) ? p.facing : (p.dirIdx >= 0 ? p.dirIdx : 3);
      const ang = [Math.PI * 1.5, Math.PI * 0.5, Math.PI, 0][face];
      const open = 0.14 + 0.20 * Math.abs(Math.sin(p.mouth || 0));
      // End-of-power blink: only in the final POWER_FLASH_SEC, ramping up.
      let alpha = 1, ending = false;
      if (p.powered) {
        const flash = (window.MazeChomp && window.MazeChomp.POWER_FLASH_SEC) || 2;
        const remain = p.poweredEnd - ac;
        if (remain < flash) {
          ending = true;
          const rate = remain < 1 ? 14 : 8;
          alpha = (Math.floor(ac * rate) % 2 === 0) ? 1 : 0.18;
        }
      }
      // Unmistakable POWER aura (glow + smooth rings + orbiting sparkles).
      ctx.globalAlpha = alpha;
      if (p.powered) this._drawPowerAura(ctx, cx, cy, r, ts, ac, ending, p.color);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, ang + open * Math.PI, ang - open * Math.PI + Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      // Eye.
      ctx.fillStyle = '#1a1a2e';
      // Perpendicular to facing, but keep it on TOP when moving horizontally.
      let eyeAng = ang - Math.PI / 2;
      if (face === 2) eyeAng = -Math.PI / 2; // left: eye on top (matches right)
      ctx.beginPath();
      ctx.arc(cx + Math.cos(eyeAng) * r * 0.35, cy + Math.sin(eyeAng) * r * 0.35, Math.max(1.5, r * 0.13), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Name tag.
      this._nameTag(ctx, p, cx, cy - r - ts * 0.32, ts);
      // Reaction bubble.
      if (p.emote && (performance.now() < p.emote.until)) this._emote(ctx, p, cx, cy - r - ts * 0.9, ts);
    }
  };

  // Chomper death: the wedge opens wider until it closes into nothing,
  // with a small shrink + fade + a burst of sparks at the end.
  Renderer.prototype._drawDyingChomper = function (ctx, p, ts, t) {
    const cx = p.x * ts + ts / 2, cy = p.y * ts + ts / 2;
    const r = ts * 0.44 * (1 - t * 0.35);
    const face = (p.facing != null) ? p.facing : (p.dirIdx >= 0 ? p.dirIdx : 3);
    const ang = [Math.PI * 1.5, Math.PI * 0.5, Math.PI, 0][face];
    const open = 0.14 + t * 0.86; // mouth opens to a full circle → vanishes
    ctx.save();
    ctx.globalAlpha = 1 - t * 0.25;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, ang + open * Math.PI, ang - open * Math.PI + Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    // Sparks in the final third.
    if (t > 0.6) {
      const st = (t - 0.6) / 0.4;
      ctx.globalAlpha = (1 - st) * 0.9;
      ctx.fillStyle = p.color;
      const spread = ts * (0.5 + st * 1.1);
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8;
        const sx = cx + Math.cos(a) * spread, sy = cy + Math.sin(a) * spread;
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.5, ts * 0.09 * (1 - st)), 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  };

  // A loud but SMOOTH "I have the power pellet" aura: soft glow + gold ring +
  // a gently-pulsing outer ring + sparkles orbiting smoothly around the body.
  Renderer.prototype._drawPowerAura = function (ctx, cx, cy, r, ts, now, ending, color) {
    const col = color || '#FFE100';
    const pulse = 0.5 + 0.5 * Math.sin(now * 4);       // smooth, unhurried
    const baseAlpha = ctx.globalAlpha;                  // respect the blink
    ctx.save();
    ctx.shadowColor = ending ? '#FFFFFF' : col;
    ctx.shadowBlur = ts * (0.9 + 0.4 * pulse);
    // Soft radial glow tinted with the player's colour.
    const grd = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 1.95);
    grd.addColorStop(0, col + '4D');
    grd.addColorStop(1, col + '00');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.95, 0, Math.PI * 2); ctx.fill();
    // Bold ring in the player's colour hugging the body.
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(2, ts * 0.09);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.2, 0, Math.PI * 2); ctx.stroke();
    // Orbiting sparkles (smooth circular motion).
    ctx.globalAlpha = baseAlpha;
    ctx.fillStyle = '#FFFFFF';
    const dots = 6, rot = now * 1.3;
    for (let i = 0; i < dots; i++) {
      const a = rot + (Math.PI * 2 * i) / dots;
      const rad = r * (1.34 + 0.1 * Math.sin(now * 3 + i));
      const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      ctx.beginPath(); ctx.arc(x, y, ts * 0.075, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };

  Renderer.prototype._nameTag = function (ctx, p, cx, cy, ts) {
    const powered = !!p.powered;
    const label = p.name + (p.connected === false ? ' 💤' : '');
    ctx.font = '700 ' + Math.max(9, Math.floor(ts * 0.5)) + 'px Inter, sans-serif';
    const tw = ctx.measureText(label).width;
    const padX = ts * 0.24, h = ts * 0.7;
    ctx.fillStyle = powered ? p.color : 'rgba(0,0,0,0.55)';
    roundRect(ctx, cx - tw / 2 - padX, cy - h, tw + padX * 2, h, h / 2);
    ctx.fill();
    ctx.fillStyle = powered ? '#14142b' : p.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy - h / 2);
    ctx.textAlign = 'left';
  };

  Renderer.prototype._emote = function (ctx, p, cx, cy, ts) {
    const size = Math.max(16, Math.floor(ts * 1.1));
    ctx.font = size + 'px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    roundRect(ctx, cx - size * 0.7, cy - size * 0.85, size * 1.4, size * 1.3, size * 0.35);
    ctx.fill();
    ctx.fillText(p.emote.char, cx, cy - size * 0.18);
    ctx.textAlign = 'left';
  };

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

  global.MazeChompRender = { Renderer };
})(typeof window !== 'undefined' ? window : globalThis);
