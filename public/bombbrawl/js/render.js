/* Bomb Brawl — host canvas renderer.
 *
 * Purely presentational: it never mutates the world. The host feeds it engine
 * events (`onEvent`) so it can spawn particles, rings, floating labels, screen
 * shake and hit-stop, then calls `render(dtReal)` once per animation frame.
 *
 * Everything is drawn in tile units and scaled by a single letterboxed tile
 * size, so the arena stays crisp and centred at any window size.
 */
(function (global) {
  'use strict';

  const BB = global.BombBrawl;
  const TILE = BB.TILE;
  const POW = BB.POW;
  const DYING_SEC = BB.DYING_SEC;
  const FUSE_SEC = BB.FUSE_SEC;

  const BG_TOP = '#1B1640';
  const BG_BOT = '#0C0920';
  const FLOOR_A = '#2C2A5A';
  const FLOOR_B = '#262450';
  const FLOOR_LINE = 'rgba(255,255,255,0.045)';
  const HARD_TOP = '#5A6478';
  const HARD_FRONT = '#39414f';
  const HARD_RIM = '#8695ab';
  const SOFT_TOP = '#B0653A';
  const SOFT_FRONT = '#7B4325';
  const SOFT_RIM = '#D98A54';

  const ITEM_STYLE = {};
  ITEM_STYLE[POW.BOMB] = { bg: '#3A3660', ring: '#E4E8FF', label: '+1 BOMB' };
  ITEM_STYLE[POW.FIRE] = { bg: '#4A2410', ring: '#FF7A18', label: '+1 FIRE' };
  ITEM_STYLE[POW.SPEED] = { bg: '#0F3A26', ring: '#3DDC84', label: '+1 SPEED' };
  ITEM_STYLE[POW.KICK] = { bg: '#463612', ring: '#FFD23F', label: 'KICK!' };

  const MAX_PARTICLES = 460;
  const SHAKE_CAP = 0.55;          // tiles
  const HITSTOP_SEC = 0.06;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOut(t) { return 1 - (1 - t) * (1 - t); }

  /** Blend a hex colour toward white (amt > 0) or black (amt < 0). */
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (amt >= 0) { r = lerp(r, 255, amt); g = lerp(g, 255, amt); b = lerp(b, 255, amt); }
    else { r = lerp(r, 0, -amt); g = lerp(g, 0, -amt); b = lerp(b, 0, -amt); }
    return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
  }
  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

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

  // ---------------------------------------------------------------- Renderer

  function Renderer(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.dpr = Math.max(1, Math.min(3, global.devicePixelRatio || 1));
    this.t = 0;
    this.particles = [];
    this.rings = [];
    this.labels = [];
    this.shake = 0;
    this.hitStop = 0;
    this.flash = 0;
    this.reduced = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.cssW = 1; this.cssH = 1;
    this.resize();
  }

  Renderer.prototype.setWorld = function (world) { this.world = world; };

  Renderer.prototype.clearFx = function () {
    this.particles.length = 0;
    this.rings.length = 0;
    this.labels.length = 0;
    this.shake = 0;
    this.hitStop = 0;
    this.flash = 0;
  };

  Renderer.prototype.resize = function () {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.dpr = Math.max(1, Math.min(3, global.devicePixelRatio || 1));
    c.width = Math.floor(w * this.dpr);
    c.height = Math.floor(h * this.dpr);
    this.cssW = w; this.cssH = h;
  };

  Renderer.prototype._metrics = function () {
    const w = this.world;
    const ts = Math.floor(Math.min(this.cssW / w.W, (this.cssH - 6) / w.H));
    const gw = ts * w.W, gh = ts * w.H;
    return {
      ts: ts,
      ox: Math.floor((this.cssW - gw) / 2),
      oy: Math.floor((this.cssH - gh) / 2),
      gw: gw, gh: gh,
    };
  };

  // ------------------------------------------------------------------ Effects

  Renderer.prototype._spawn = function (n, fn) {
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= MAX_PARTICLES) return;
      this.particles.push(fn(i));
    }
  };

  Renderer.prototype.addShake = function (mag) {
    if (this.reduced) return;
    this.shake = Math.min(SHAKE_CAP, this.shake + mag);
  };

  Renderer.prototype.addRing = function (x, y, r0, r1, color, life, width) {
    this.rings.push({ x: x, y: y, r0: r0, r1: r1, color: color, t: 0, max: life || 0.45, w: width || 0.09 });
  };

  Renderer.prototype.addLabel = function (x, y, text, color) {
    this.labels.push({ x: x, y: y, text: text, color: color || '#fff', t: 0, max: 1.1 });
  };

  /** Feed one engine event. */
  Renderer.prototype.onEvent = function (ev) {
    const cx = ev.c + 0.5, cy = ev.r + 0.5;
    const dense = this.reduced ? 0.35 : 1;
    switch (ev.type) {
      case 'bomb':
        this.addRing(cx, cy, 0.1, 0.55, 'rgba(255,255,255,0.45)', 0.3, 0.05);
        break;
      case 'explode': {
        const cells = ev.cells.length;
        this.addShake(clamp(0.10 + cells * 0.012, 0.10, 0.34));
        this.flash = Math.max(this.flash, this.reduced ? 0 : 0.22);
        this.addRing(cx, cy, 0.2, 1.5 + ev.fire * 0.25, 'rgba(255,210,63,0.75)', 0.4, 0.14);
        for (let i = 0; i < ev.cells.length; i++) {
          const q = ev.cells[i];
          this._spawn(Math.round(3 * dense), () => {
            const a = Math.random() * Math.PI * 2;
            const sp = 1.4 + Math.random() * 3.0;
            return {
              kind: 'spark', x: q.c + 0.5, y: q.r + 0.5,
              vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.0,
              g: 5.2, t: 0, max: 0.3 + Math.random() * 0.35,
              size: 0.05 + Math.random() * 0.07,
              color: Math.random() < 0.45 ? '#FFF3C4' : '#FF7A18',
            };
          });
          this._spawn(Math.round(1 * dense), () => ({
            kind: 'smoke', x: q.c + 0.5 + (Math.random() - 0.5) * 0.5,
            y: q.r + 0.5 + (Math.random() - 0.5) * 0.5,
            vx: (Math.random() - 0.5) * 0.5, vy: -0.5 - Math.random() * 0.6,
            g: -0.25, t: 0, max: 0.6 + Math.random() * 0.5,
            size: 0.18 + Math.random() * 0.2, color: '#2a2646',
          }));
        }
        break;
      }
      case 'crate':
        // Wood chips tumbling out of a destroyed crate.
        this._spawn(Math.round(10 * dense), () => {
          const a = Math.random() * Math.PI * 2;
          const sp = 1.2 + Math.random() * 2.6;
          return {
            kind: 'chip', x: cx, y: cy,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.6,
            g: 8.5, t: 0, max: 0.5 + Math.random() * 0.4,
            size: 0.07 + Math.random() * 0.08,
            rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 16,
            color: Math.random() < 0.5 ? SOFT_TOP : SOFT_RIM,
          };
        });
        break;
      case 'pickup':
        this.addRing(cx, cy, 0.15, 0.85, rgba(ev.color, 0.8), 0.45, 0.08);
        this.addLabel(cx, cy - 0.35, ev.label, ev.color);
        this._spawn(Math.round(8 * dense), () => {
          const a = Math.random() * Math.PI * 2;
          return {
            kind: 'spark', x: cx, y: cy,
            vx: Math.cos(a) * 1.8, vy: Math.sin(a) * 1.8 - 0.8,
            g: 3.5, t: 0, max: 0.35 + Math.random() * 0.2,
            size: 0.05, color: ev.color,
          };
        });
        break;
      case 'itemBurned':
        this._spawn(Math.round(5 * dense), () => ({
          kind: 'smoke', x: cx, y: cy,
          vx: (Math.random() - 0.5) * 0.8, vy: -0.9 - Math.random() * 0.5,
          g: -0.2, t: 0, max: 0.5, size: 0.14, color: '#3b3560',
        }));
        break;
      case 'kick':
        this.addRing(cx, cy, 0.1, 0.5, 'rgba(255,255,255,0.4)', 0.25, 0.05);
        break;
      case 'death':
        this.hitStop = this.reduced ? 0 : HITSTOP_SEC;
        this.addShake(0.3);
        this.flash = Math.max(this.flash, this.reduced ? 0 : 0.3);
        this.addRing(cx, cy, 0.2, 1.6, rgba(ev.color, 0.85), 0.6, 0.12);
        this._spawn(Math.round(20 * dense), () => {
          const a = Math.random() * Math.PI * 2;
          const sp = 1.0 + Math.random() * 3.2;
          return {
            kind: 'soot', x: cx, y: cy,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.4,
            g: 4.5, t: 0, max: 0.6 + Math.random() * 0.5,
            size: 0.09 + Math.random() * 0.12,
            color: Math.random() < 0.35 ? ev.color : '#241f42',
          };
        });
        break;
      case 'itemDrop': {
        // The loot a fallen bomber leaves behind needs to read from across the
        // room, so it lands with its own ring in the item's colour.
        const st = ITEM_STYLE[ev.kind] || ITEM_STYLE[POW.BOMB];
        this.addRing(cx, cy, 0.15, 1.3, rgba(st.ring, 0.9), 0.55, 0.09);
        break;
      }
      case 'sdLand':
        this.addShake(0.16);
        this._spawn(Math.round(9 * dense), () => {
          const a = Math.random() * Math.PI * 2;
          return {
            kind: 'smoke', x: cx, y: cy,
            vx: Math.cos(a) * 2.2, vy: Math.sin(a) * 1.1 - 0.2,
            g: 1.2, t: 0, max: 0.45 + Math.random() * 0.3,
            size: 0.13 + Math.random() * 0.14, color: '#6b7488',
          };
        });
        this.addRing(cx, cy, 0.2, 1.1, 'rgba(140,150,170,0.6)', 0.35, 0.1);
        break;
      case 'suddenDeath':
        this.flash = Math.max(this.flash, this.reduced ? 0 : 0.35);
        this.addShake(0.28);
        break;
      default: break;
    }
  };

  Renderer.prototype._stepFx = function (dt) {
    this.t += dt;
    this.shake *= Math.pow(0.0016, dt);
    if (this.shake < 0.004) this.shake = 0;
    this.flash = Math.max(0, this.flash - dt * 1.9);

    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.t += dt;
      if (p.t >= p.max) { ps.splice(i, 1); continue; }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.spin) p.rot += p.spin * dt;
      if (p.kind === 'chip' || p.kind === 'soot') { p.vx *= Math.pow(0.25, dt); }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].t += dt;
      if (this.rings[i].t >= this.rings[i].max) this.rings.splice(i, 1);
    }
    for (let i = this.labels.length - 1; i >= 0; i--) {
      this.labels[i].t += dt;
      if (this.labels[i].t >= this.labels[i].max) this.labels.splice(i, 1);
    }
  };

  // ------------------------------------------------------------------- Render

  Renderer.prototype.render = function (dt) {
    dt = clamp(dt || 0, 0, 0.05);
    this._stepFx(dt);

    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const bg = ctx.createLinearGradient(0, 0, 0, this.cssH);
    bg.addColorStop(0, BG_TOP);
    bg.addColorStop(1, BG_BOT);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    const m = this._metrics();
    const ts = m.ts;
    let sx = 0, sy = 0;
    if (this.shake > 0) {
      sx = (Math.random() * 2 - 1) * this.shake * ts;
      sy = (Math.random() * 2 - 1) * this.shake * ts;
    }
    ctx.translate(m.ox + sx, m.oy + sy);

    this._drawFloor(ctx, ts, m);
    this._drawItems(ctx, ts);
    this._drawBlocks(ctx, ts);
    this._drawBombs(ctx, ts);
    this._drawPlayers(ctx, ts);
    this._drawFlames(ctx, ts);
    this._drawSuddenDeath(ctx, ts);
    this._drawParticles(ctx, ts);
    this._drawRings(ctx, ts);
    this._drawLabels(ctx, ts);
    this._drawNameTags(ctx, ts);

    ctx.restore();

    if (this.flash > 0) {
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = 'rgba(255,255,255,' + (this.flash * 0.5).toFixed(3) + ')';
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      ctx.restore();
    }
  };

  Renderer.prototype._drawFloor = function (ctx, ts, m) {
    const w = this.world;
    for (let r = 0; r < w.H; r++) {
      for (let c = 0; c < w.W; c++) {
        ctx.fillStyle = ((r + c) & 1) ? FLOOR_A : FLOOR_B;
        ctx.fillRect(c * ts, r * ts, ts, ts);
      }
    }
    // Faint grid so the tile lattice reads from across the room.
    ctx.strokeStyle = FLOOR_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < w.W; c++) { ctx.moveTo(c * ts + 0.5, 0); ctx.lineTo(c * ts + 0.5, m.gh); }
    for (let r = 1; r < w.H; r++) { ctx.moveTo(0, r * ts + 0.5); ctx.lineTo(m.gw, r * ts + 0.5); }
    ctx.stroke();

    // Vignette to push focus into the middle of the arena.
    const g = ctx.createRadialGradient(m.gw / 2, m.gh / 2, m.gh * 0.25, m.gw / 2, m.gh / 2, m.gh * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, m.gw, m.gh);
  };

  /** One extruded block: dark front face + lit top face + rim highlight. */
  Renderer.prototype._block = function (ctx, x, y, ts, top, front, rim, scale) {
    const lip = Math.max(3, Math.round(ts * 0.20));
    let w = ts, h = ts, ox = 0, oy = 0;
    if (scale && scale !== 1) {
      w = ts * scale; h = ts * scale;
      ox = (ts - w) / 2; oy = (ts - h) / 2;
    }
    const bx = x + ox, by = y + oy;
    const rad = Math.max(2, ts * 0.12);

    ctx.fillStyle = front;
    roundRect(ctx, bx + 1, by + 1, w - 2, h - 2, rad);
    ctx.fill();

    ctx.fillStyle = top;
    roundRect(ctx, bx + 1, by + 1, w - 2, h - 2 - lip, rad);
    ctx.fill();

    ctx.strokeStyle = rim;
    ctx.lineWidth = Math.max(1, ts * 0.035);
    roundRect(ctx, bx + 1.5, by + 1.5, w - 3, h - 3 - lip, rad);
    ctx.stroke();
  };

  Renderer.prototype._drawBlocks = function (ctx, ts) {
    const w = this.world;
    for (let r = 0; r < w.H; r++) {
      for (let c = 0; c < w.W; c++) {
        const t = w.grid[r][c];
        if (t === TILE.FLOOR) continue;
        const x = c * ts, y = r * ts;
        if (t === TILE.HARD) {
          this._block(ctx, x, y, ts, HARD_TOP, HARD_FRONT, HARD_RIM, 1);
          // Riveted steel: two small studs on the top face.
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          const rr = Math.max(1, ts * 0.045);
          ctx.beginPath(); ctx.arc(x + ts * 0.26, y + ts * 0.26, rr, 0, 6.2832); ctx.fill();
          ctx.beginPath(); ctx.arc(x + ts * 0.74, y + ts * 0.26, rr, 0, 6.2832); ctx.fill();
        } else {
          this._block(ctx, x, y, ts, SOFT_TOP, SOFT_FRONT, SOFT_RIM, 1);
          // Plank seams + corner braces so crates read as breakable.
          ctx.strokeStyle = 'rgba(0,0,0,0.24)';
          ctx.lineWidth = Math.max(1, ts * 0.03);
          ctx.beginPath();
          ctx.moveTo(x + ts * 0.14, y + ts * 0.40); ctx.lineTo(x + ts * 0.86, y + ts * 0.40);
          ctx.moveTo(x + ts * 0.5, y + ts * 0.14); ctx.lineTo(x + ts * 0.5, y + ts * 0.72);
          ctx.stroke();
        }
      }
    }
  };

  Renderer.prototype._drawItems = function (ctx, ts) {
    const self = this;
    this.world.items.forEach(function (it) {
      const style = ITEM_STYLE[it.type] || ITEM_STYLE[POW.BOMB];
      const bob = self.reduced ? 0 : Math.sin(self.t * 3.4 + it.r + it.c) * ts * 0.07;
      const x = it.c * ts + ts / 2;
      const y = it.r * ts + ts / 2 + bob;
      const rad = ts * 0.34;

      // Contact shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.ellipse(x, it.r * ts + ts * 0.82, rad * 0.72, rad * 0.26, 0, 0, 6.2832);
      ctx.fill();

      const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.4, rad * 0.1, x, y, rad);
      g.addColorStop(0, shade(style.ring, 0.35));
      g.addColorStop(0.55, style.bg);
      g.addColorStop(1, shade(style.bg, -0.35));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.2832); ctx.fill();

      ctx.strokeStyle = style.ring;
      ctx.lineWidth = Math.max(2, ts * 0.055);
      ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.2832); ctx.stroke();

      self._itemIcon(ctx, it.type, x, y, ts, style.ring);

      // Sheen sweep so power-ups catch the eye on a big screen.
      if (!self.reduced) {
        const ph = (self.t * 0.9 + (it.r * 3 + it.c) * 0.17) % 1;
        if (ph < 0.28) {
          const a = Math.sin((ph / 0.28) * Math.PI) * 0.4;
          ctx.save();
          ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.2832); ctx.clip();
          ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
          const sxp = x - rad + ph / 0.28 * rad * 2.4;
          ctx.beginPath();
          ctx.moveTo(sxp, y - rad); ctx.lineTo(sxp + rad * 0.4, y - rad);
          ctx.lineTo(sxp - rad * 0.2, y + rad); ctx.lineTo(sxp - rad * 0.6, y + rad);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
    });
  };

  Renderer.prototype._itemIcon = function (ctx, type, x, y, ts, color) {
    const s = ts * 0.20;
    ctx.save();
    ctx.translate(x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (type === POW.BOMB) {
      ctx.fillStyle = '#12102a';
      ctx.beginPath(); ctx.arc(0, s * 0.18, s * 0.78, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, ts * 0.05);
      ctx.beginPath();
      ctx.moveTo(s * 0.2, -s * 0.5);
      ctx.quadraticCurveTo(s * 0.9, -s * 1.1, s * 0.5, -s * 1.4);
      ctx.stroke();
    } else if (type === POW.FIRE) {
      ctx.fillStyle = '#FFD23F';
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.15);
      ctx.quadraticCurveTo(s * 0.95, -s * 0.1, s * 0.5, s * 0.7);
      ctx.quadraticCurveTo(0, s * 1.25, -s * 0.5, s * 0.7);
      ctx.quadraticCurveTo(-s * 0.95, -s * 0.1, 0, -s * 1.15);
      ctx.fill();
      ctx.fillStyle = '#FF7A18';
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.25);
      ctx.quadraticCurveTo(s * 0.45, s * 0.25, 0, s * 0.85);
      ctx.quadraticCurveTo(-s * 0.45, s * 0.25, 0, -s * 0.25);
      ctx.fill();
    } else if (type === POW.SPEED) {
      ctx.strokeStyle = '#0F3A26';
      ctx.fillStyle = '#EAFFF3';
      ctx.lineWidth = Math.max(2, ts * 0.03);
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(-s * 0.75 + i * s * 0.62, -s * 0.85);
        ctx.lineTo(-s * 0.1 + i * s * 0.62, 0);
        ctx.lineTo(-s * 0.75 + i * s * 0.62, s * 0.85);
        ctx.stroke();
      }
    } else {
      // Kick: a boot silhouette.
      ctx.fillStyle = '#2B2110';
      ctx.beginPath();
      ctx.moveTo(-s * 0.55, -s * 0.9);
      ctx.lineTo(s * 0.05, -s * 0.9);
      ctx.lineTo(s * 0.05, s * 0.1);
      ctx.lineTo(s * 1.0, s * 0.35);
      ctx.lineTo(s * 1.0, s * 0.9);
      ctx.lineTo(-s * 0.55, s * 0.9);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  };

  Renderer.prototype._drawBombs = function (ctx, ts) {
    const bombs = this.world.bombs;
    for (let i = 0; i < bombs.length; i++) {
      const b = bombs[i];
      const burned = clamp(1 - b.fuse / FUSE_SEC, 0, 1);
      // The pulse speeds up as the fuse runs down, so urgency is readable.
      const rate = 6 + burned * 22;
      const pulse = this.reduced ? 1 : 1 + 0.12 * Math.sin(this.t * rate);
      const x = b.x * ts, y = b.y * ts;
      const rad = ts * 0.36 * pulse;

      // Motion trail behind a kicked bomb.
      if (b.vx || b.vy) {
        for (let k = 1; k <= 3; k++) {
          ctx.fillStyle = 'rgba(20,16,45,' + (0.16 / k).toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(x - b.vx * ts * 0.22 * k, y - b.vy * ts * 0.22 * k, rad * (1 - k * 0.12), 0, 6.2832);
          ctx.fill();
        }
      }

      ctx.fillStyle = 'rgba(0,0,0,0.36)';
      ctx.beginPath();
      ctx.ellipse(x, y + ts * 0.3, rad * 0.85, rad * 0.3, 0, 0, 6.2832);
      ctx.fill();

      // Body reddens over the last stretch of the fuse.
      const hot = clamp((burned - 0.76) / 0.24, 0, 1);
      const base = hot > 0 ? shade('#FF3B30', -0.55 + hot * 0.35) : '#14112c';
      const g = ctx.createRadialGradient(x - rad * 0.35, y - rad * 0.45, rad * 0.12, x, y, rad);
      g.addColorStop(0, shade(base, 0.45));
      g.addColorStop(0.5, base);
      g.addColorStop(1, shade(base, -0.5));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.2832); ctx.fill();

      // Owner tint ring so you can see whose bomb it is.
      ctx.strokeStyle = rgba(b.color, 0.85);
      ctx.lineWidth = Math.max(2, ts * 0.045);
      ctx.beginPath(); ctx.arc(x, y, rad * 0.98, 0, 6.2832); ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.ellipse(x - rad * 0.34, y - rad * 0.4, rad * 0.24, rad * 0.16, -0.6, 0, 6.2832);
      ctx.fill();

      // Fuse + spark.
      const fx = x + rad * 0.42, fy = y - rad * 0.78;
      ctx.strokeStyle = '#8a7a5c';
      ctx.lineWidth = Math.max(2, ts * 0.045);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + rad * 0.18, y - rad * 0.82);
      ctx.quadraticCurveTo(fx + rad * 0.5, fy - rad * 0.4, fx, fy - rad * 0.5);
      ctx.stroke();
      const sparkR = ts * (0.07 + 0.05 * Math.abs(Math.sin(this.t * (12 + burned * 30))));
      const sg = ctx.createRadialGradient(fx, fy - rad * 0.5, 0, fx, fy - rad * 0.5, sparkR * 2.2);
      sg.addColorStop(0, '#ffffff');
      sg.addColorStop(0.4, '#FFD23F');
      sg.addColorStop(1, 'rgba(255,122,24,0)');
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(fx, fy - rad * 0.5, sparkR * 2.2, 0, 6.2832); ctx.fill();
    }
  };

  Renderer.prototype._drawFlames = function (ctx, ts) {
    const self = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.world.flames.forEach(function (f) {
      const age = f.max - f.t;
      const grow = clamp(age / 0.09, 0, 1);           // arms shoot outward
      const fade = clamp(f.t / (f.max * 0.55), 0, 1);  // then burn away
      const x = f.c * ts, y = f.r * ts;
      const cx = x + ts / 2, cy = y + ts / 2;

      let hw = ts * 0.46, hh = ts * 0.46;
      if (f.type === 'arm') {
        if (f.axis === 'h') { hw = ts * 0.5 * grow + ts * 0.02; hh = ts * 0.40; }
        else { hh = ts * 0.5 * grow + ts * 0.02; hw = ts * 0.40; }
      } else {
        hw *= (0.6 + 0.4 * grow); hh *= (0.6 + 0.4 * grow);
      }

      ctx.globalAlpha = 0.35 + 0.65 * fade;
      // Glow spill onto neighbouring tiles.
      const gg = ctx.createRadialGradient(cx, cy, 0, cx, cy, ts * 1.0);
      gg.addColorStop(0, 'rgba(255,170,40,0.42)');
      gg.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(cx, cy, ts * 1.0, 0, 6.2832); ctx.fill();

      // Layered core: orange shell -> yellow -> white centre.
      const rad = Math.min(hw, hh) * 0.7;
      ctx.fillStyle = '#FF5A0A';
      roundRect(ctx, cx - hw, cy - hh, hw * 2, hh * 2, rad);
      ctx.fill();
      ctx.fillStyle = '#FFC12E';
      roundRect(ctx, cx - hw * 0.72, cy - hh * 0.72, hw * 1.44, hh * 1.44, rad * 0.8);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,240,' + (0.55 + 0.45 * fade).toFixed(3) + ')';
      roundRect(ctx, cx - hw * 0.4, cy - hh * 0.4, hw * 0.8, hh * 0.8, rad * 0.6);
      ctx.fill();

      // Flicker at the tip of each arm.
      if (f.cap && !self.reduced) {
        const fl = 0.5 + 0.5 * Math.sin(self.t * 26 + f.r * 2 + f.c * 3);
        ctx.globalAlpha = (0.3 + 0.4 * fl) * fade;
        ctx.fillStyle = '#FFF6D0';
        ctx.beginPath(); ctx.arc(cx, cy, ts * 0.2 * (0.7 + fl * 0.5), 0, 6.2832); ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  Renderer.prototype._drawSuddenDeath = function (ctx, ts) {
    const w = this.world;
    if (!w.suddenDeath) return;
    for (let i = 0; i < w.sdPending.length; i++) {
      const p = w.sdPending[i];
      const k = clamp(1 - p.t / p.max, 0, 1);          // 0 -> warn, 1 -> impact
      const x = p.c * ts, y = p.r * ts;

      // Flashing danger outline while the block falls.
      const blink = this.reduced ? 0.7 : (0.35 + 0.65 * Math.abs(Math.sin(this.t * 18)));
      ctx.strokeStyle = 'rgba(255,59,48,' + (blink * (0.5 + k * 0.5)).toFixed(3) + ')';
      ctx.lineWidth = Math.max(2, ts * 0.09);
      roundRect(ctx, x + ts * 0.08, y + ts * 0.08, ts * 0.84, ts * 0.84, ts * 0.12);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,59,48,' + (0.10 + k * 0.22).toFixed(3) + ')';
      ctx.fill();

      // The block itself slams in from above, overshooting then squashing.
      const drop = (1 - easeOut(k)) * ts * 2.2;
      const scale = lerp(1.5, 1.0, easeOut(k));
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.65 * k;
      ctx.translate(0, -drop);
      this._block(ctx, x, y, ts, HARD_TOP, HARD_FRONT, HARD_RIM, scale);
      ctx.restore();
    }
  };

  Renderer.prototype._drawPlayers = function (ctx, ts) {
    const ps = this.world.players;
    // Draw back-to-front so lower bombers overlap higher ones correctly.
    const order = ps.slice().sort(function (a, b) { return a.y - b.y; });
    for (let i = 0; i < order.length; i++) this._drawBomber(ctx, order[i], ts);
  };

  Renderer.prototype._drawBomber = function (ctx, p, ts) {
    const dying = !p.alive;
    const dt = dying ? clamp(p.dyingT / DYING_SEC, 0, 1) : 0;
    if (dying && dt >= 1) return;   // fully gone

    const x = p.x * ts, y = p.y * ts;
    const bodyR = ts * 0.34;

    // Walk cycle: squash/stretch + a small hop, driven by distance walked.
    const ph = p.walk * 7.5;
    const moving = p.moving && !dying;
    const bounce = moving && !this.reduced ? Math.abs(Math.sin(ph)) * ts * 0.09 : 0;
    const squash = moving && !this.reduced ? 1 + Math.sin(ph * 2) * 0.07 : 1;
    const breathe = !moving && !this.reduced ? 1 + Math.sin(this.t * 2.6) * 0.03 : 1;

    ctx.save();
    ctx.translate(x, y - bounce);
    if (dying) {
      // Spin out, shrink and fade.
      ctx.globalAlpha = 1 - easeOut(dt);
      ctx.rotate(dt * 5.0);
      const s = 1 - easeOut(dt) * 0.75;
      ctx.scale(s, s);
    }

    // Contact shadow (stays on the ground, so undo the hop).
    ctx.save();
    ctx.translate(0, bounce);
    ctx.fillStyle = 'rgba(0,0,0,0.36)';
    ctx.beginPath();
    ctx.ellipse(0, ts * 0.30, bodyR * 0.82, bodyR * 0.28, 0, 0, 6.2832);
    ctx.fill();
    ctx.restore();

    const sx = squash * breathe;
    const sy = (2 - squash) * breathe;

    // Feet.
    ctx.fillStyle = shade(p.color, -0.55);
    const footSwing = moving && !this.reduced ? Math.sin(ph) * bodyR * 0.28 : 0;
    ctx.beginPath();
    ctx.ellipse(-bodyR * 0.36, bodyR * 0.78 + footSwing, bodyR * 0.30, bodyR * 0.20, 0, 0, 6.2832);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(bodyR * 0.36, bodyR * 0.78 - footSwing, bodyR * 0.30, bodyR * 0.20, 0, 0, 6.2832);
    ctx.fill();

    // Body.
    ctx.save();
    ctx.scale(sx, sy);
    const bg = ctx.createLinearGradient(0, -bodyR, 0, bodyR);
    bg.addColorStop(0, shade(p.color, 0.28));
    bg.addColorStop(0.55, p.color);
    bg.addColorStop(1, shade(p.color, -0.35));
    ctx.fillStyle = bg;
    roundRect(ctx, -bodyR * 0.82, -bodyR * 0.55, bodyR * 1.64, bodyR * 1.42, bodyR * 0.55);
    ctx.fill();
    ctx.strokeStyle = shade(p.color, -0.55);
    ctx.lineWidth = Math.max(1.5, ts * 0.028);
    roundRect(ctx, -bodyR * 0.82, -bodyR * 0.55, bodyR * 1.64, bodyR * 1.42, bodyR * 0.55);
    ctx.stroke();

    // Helmet dome with a specular highlight.
    const hg = ctx.createLinearGradient(0, -bodyR * 1.15, 0, -bodyR * 0.1);
    hg.addColorStop(0, shade(p.color, 0.55));
    hg.addColorStop(1, shade(p.color, -0.1));
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(0, -bodyR * 0.5, bodyR * 0.72, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.beginPath();
    ctx.ellipse(-bodyR * 0.26, -bodyR * 0.78, bodyR * 0.20, bodyR * 0.12, -0.5, 0, 6.2832);
    ctx.fill();

    // Visor + eyes, tracking the facing direction.
    const look = p.dir === 2 ? -1 : (p.dir === 3 ? 1 : 0);
    const lookY = p.dir === 0 ? -0.35 : (p.dir === 1 ? 0.2 : 0);
    ctx.fillStyle = '#14112c';
    roundRect(ctx, -bodyR * 0.6, -bodyR * 0.42, bodyR * 1.2, bodyR * 0.52, bodyR * 0.22);
    ctx.fill();
    if (p.dir !== 0) {
      ctx.fillStyle = '#ffffff';
      const ex = bodyR * 0.24 + look * bodyR * 0.1;
      const ey = -bodyR * 0.17 + lookY * bodyR * 0.08;
      ctx.beginPath(); ctx.arc(-ex, ey, bodyR * 0.11, 0, 6.2832); ctx.fill();
      ctx.beginPath(); ctx.arc(ex, ey, bodyR * 0.11, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  };

  Renderer.prototype._drawNameTags = function (ctx, ts) {
    const ps = this.world.players;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = Math.max(9, Math.round(ts * 0.28));
    ctx.font = '800 ' + fs + 'px Inter, system-ui, sans-serif';
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p.alive) continue;
      const label = p.name.length > 9 ? p.name.slice(0, 8) + '…' : p.name;
      const wpx = ctx.measureText(label).width + fs * 1.0;
      const x = p.x * ts, y = p.y * ts - ts * 0.82;
      ctx.fillStyle = 'rgba(10,8,26,0.72)';
      roundRect(ctx, x - wpx / 2, y - fs * 0.75, wpx, fs * 1.5, fs * 0.75);
      ctx.fill();
      ctx.strokeStyle = rgba(p.color, 0.9);
      ctx.lineWidth = Math.max(1.5, ts * 0.025);
      roundRect(ctx, x - wpx / 2, y - fs * 0.75, wpx, fs * 1.5, fs * 0.75);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x, y + 1);
    }
  };

  Renderer.prototype._drawParticles = function (ctx, ts) {
    const ps = this.particles;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const k = 1 - p.t / p.max;
      const x = p.x * ts, y = p.y * ts;
      ctx.globalAlpha = p.kind === 'smoke' ? k * 0.5 : k;
      ctx.fillStyle = p.color;
      if (p.kind === 'chip') {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rot || 0);
        const s = p.size * ts;
        ctx.fillRect(-s / 2, -s / 3, s, s * 0.66);
        ctx.restore();
      } else if (p.kind === 'smoke') {
        ctx.beginPath();
        ctx.arc(x, y, p.size * ts * (1.5 - k * 0.5), 0, 6.2832);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, p.size * ts * k, 0, 6.2832);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._drawRings = function (ctx, ts) {
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      const k = r.t / r.max;
      const rad = lerp(r.r0, r.r1, easeOut(k)) * ts;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, r.w * ts * (1 - k));
      ctx.beginPath();
      ctx.arc(r.x * ts, r.y * ts, rad, 0, 6.2832);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._drawLabels = function (ctx, ts) {
    const fs = Math.max(11, Math.round(ts * 0.34));
    ctx.font = '900 ' + fs + 'px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.labels.length; i++) {
      const l = this.labels[i];
      const k = l.t / l.max;
      const y = (l.y - easeOut(k) * 1.0) * ts;
      ctx.globalAlpha = 1 - k * k;
      ctx.lineWidth = Math.max(2, ts * 0.07);
      ctx.strokeStyle = 'rgba(10,8,26,0.85)';
      ctx.strokeText(l.text, l.x * ts, y);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, l.x * ts, y);
    }
    ctx.globalAlpha = 1;
  };

  global.BombBrawlRender = { Renderer: Renderer, shade: shade, rgba: rgba, roundRect: roundRect };
})(typeof window !== 'undefined' ? window : globalThis);
