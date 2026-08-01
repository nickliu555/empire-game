/* Bomb Brawl — grid engine (host-authoritative).
 *
 * Owns the arena, bombers, bombs, flames, power-ups and the sudden-death
 * spiral. Runs ONLY on the host browser, stepped at a fixed timestep from
 * host.js. Pure logic: no DOM, no canvas, no sockets — render.js draws it and
 * bot.js reads it.
 *
 * Coordinate system: tile units. A tile (r, c) covers x in [c, c+1] and y in
 * [r, r+1], so its centre is (c + 0.5, r + 0.5). Bombers are axis-aligned
 * boxes of half-size P_R centred on (x, y).
 *
 * Exposes window.BombBrawl = { World, TILE, POW, ... }.
 */
(function (global) {
  'use strict';

  // ---------------- Arena ----------------
  var W = 15;   // columns (odd, includes the border)
  var H = 13;   // rows    (odd, includes the border)

  var TILE = { FLOOR: 0, HARD: 1, SOFT: 2 };
  var POW = { BOMB: 1, FIRE: 2, SPEED: 3, KICK: 4 };
  var POW_NAME = { 1: 'BOMB', 2: 'FIRE', 3: 'SPEED', 4: 'KICK' };
  var POW_LABEL = { 1: '+1 BOMB', 2: '+1 FIRE', 3: '+1 SPEED', 4: 'KICK!' };

  // Share of eligible floor cells that get a crate.
  var SOFT_DENSITY = 0.80;
  // Chance a crate is hiding a power-up (when power-ups are enabled).
  var POWERUP_CHANCE = 0.32;
  // Relative weights for which power-up a crate hides.
  var POWERUP_WEIGHTS = [
    { type: POW.BOMB, w: 32 },
    { type: POW.FIRE, w: 32 },
    { type: POW.SPEED, w: 20 },
    { type: POW.KICK, w: 16 },
  ];

  // ---------------- Bombers ----------------
  var P_R = 0.38;             // half-size of a bomber's collision box
  var BASE_SPEED = 3.6;       // tiles/sec at speed tier 0
  var SPEED_STEP = 0.6;       // tiles/sec per Speed power-up
  var MAX_SPEED_TIER = 3;
  var MAX_BOMBS = 8;
  var MAX_FIRE = 8;
  var DEADZONE = 0.18;        // thumbstick magnitude below this = idle
  var DYING_SEC = 0.75;       // death animation length

  // ---------------- Bombs / flames ----------------
  var FUSE_SEC = 2.5;
  var FLAME_SEC = 0.5;
  var KICK_SPEED = 8.0;       // tiles/sec for a kicked bomb

  // ---------------- Sudden death ----------------
  var SD_STEP_SEC = 0.30;     // one block lands this often
  var SD_TELEGRAPH_SEC = 0.5; // warning outline shown this long before impact

  var DIRS = [
    { dx: 0, dy: -1 },  // 0 = up
    { dx: 0, dy: 1 },   // 1 = down
    { dx: -1, dy: 0 },  // 2 = left
    { dx: 1, dy: 0 },   // 3 = right
  ];

  var EPS = 1e-4;

  // Deterministic PRNG so a round's arena can be reproduced from its seed.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The four spawn corners, indexed by seat: 0 = top-left, 1 = top-right,
  // 2 = bottom-left, 3 = bottom-right. Each keeps an L-shaped safe pocket so
  // nobody starts walled in.
  var SPAWNS = [
    { r: 1, c: 1, safe: [[1, 1], [1, 2], [2, 1]] },
    { r: 1, c: W - 2, safe: [[1, W - 2], [1, W - 3], [2, W - 2]] },
    { r: H - 2, c: 1, safe: [[H - 2, 1], [H - 2, 2], [H - 3, 1]] },
    { r: H - 2, c: W - 2, safe: [[H - 2, W - 2], [H - 2, W - 3], [H - 3, W - 2]] },
  ];

  // Interior cells in an inward clockwise spiral — the order sudden-death
  // blocks land in. Every walkable cell is eventually covered, so a round can
  // never stall forever.
  function spiralCells() {
    var top = 1, left = 1, bottom = H - 2, right = W - 2;
    var out = [], r, c;
    while (top <= bottom && left <= right) {
      for (c = left; c <= right; c++) out.push([top, c]);
      top++;
      for (r = top; r <= bottom; r++) out.push([r, right]);
      right--;
      if (top <= bottom) {
        for (c = right; c >= left; c--) out.push([bottom, c]);
        bottom--;
      }
      if (left <= right) {
        for (r = bottom; r >= top; r--) out.push([r, left]);
        left++;
      }
    }
    return out;
  }

  function World(opts) {
    opts = opts || {};
    this.W = W;
    this.H = H;
    this.powerUps = opts.powerUps !== false;
    this.frozen = true;        // true during the countdown / pause
    this.seed = 0;
    this.grid = [];
    this.players = [];
    this.bombs = [];
    this.flames = new Map();   // key -> flame cell
    this.items = new Map();    // key -> { type, r, c, t }
    this.hidden = new Map();   // key -> power-up type buried under a crate
    this.suddenDeath = false;
    this.sdOrder = spiralCells();
    this.sdIndex = 0;
    this.sdTimer = 0;
    this.sdPending = [];       // telegraphed blocks about to land
    this.time = 0;
    this._rand = mulberry32(1); // runtime rolls (death drops) — reseeded on reset
    this._events = [];
  }

  World.prototype.key = function (r, c) { return r * W + c; };

  // ---------------- Arena generation ----------------

  /**
   * Build a fresh arena and place the roster in their seat corners.
   * @param {number} seed  arena seed (same seed = same crate layout)
   * @param {Array}  roster [{ id, name, seat, color, isBot }]
   */
  World.prototype.reset = function (seed, roster) {
    var rand = mulberry32(seed >>> 0);
    this.seed = seed >>> 0;
    this._rand = mulberry32(((seed >>> 0) ^ 0x9e3779b9) >>> 0);
    this.time = 0;
    this.bombs = [];
    this.flames = new Map();
    this.items = new Map();
    this.hidden = new Map();
    this.suddenDeath = false;
    this.sdIndex = 0;
    this.sdTimer = 0;
    this.sdPending = [];
    this._events = [];

    // Border + pillar lattice.
    var grid = [];
    var r, c;
    for (r = 0; r < H; r++) {
      var row = [];
      for (c = 0; c < W; c++) {
        var edge = (r === 0 || c === 0 || r === H - 1 || c === W - 1);
        var pillar = (r % 2 === 0 && c % 2 === 0);
        row.push(edge || pillar ? TILE.HARD : TILE.FLOOR);
      }
      grid.push(row);
    }
    this.grid = grid;

    // Spawn pockets stay clear of crates, for every corner (even unused ones,
    // so the arena looks symmetrical regardless of player count).
    var safe = new Set();
    for (var s = 0; s < SPAWNS.length; s++) {
      var cells = SPAWNS[s].safe;
      for (var i = 0; i < cells.length; i++) safe.add(this.key(cells[i][0], cells[i][1]));
    }

    var totalW = 0, wi;
    for (wi = 0; wi < POWERUP_WEIGHTS.length; wi++) totalW += POWERUP_WEIGHTS[wi].w;

    for (r = 1; r < H - 1; r++) {
      for (c = 1; c < W - 1; c++) {
        if (grid[r][c] !== TILE.FLOOR) continue;
        if (safe.has(this.key(r, c))) continue;
        if (rand() >= SOFT_DENSITY) continue;
        grid[r][c] = TILE.SOFT;
        if (this.powerUps && rand() < POWERUP_CHANCE) {
          var roll = rand() * totalW, acc = 0, type = POW.BOMB;
          for (wi = 0; wi < POWERUP_WEIGHTS.length; wi++) {
            acc += POWERUP_WEIGHTS[wi].w;
            if (roll < acc) { type = POWERUP_WEIGHTS[wi].type; break; }
          }
          this.hidden.set(this.key(r, c), type);
        }
      }
    }

    this.players = (roster || []).map(function (p) {
      var sp = SPAWNS[p.seat % SPAWNS.length];
      return {
        id: p.id,
        name: p.name,
        seat: p.seat,
        color: p.color,
        isBot: !!p.isBot,
        x: sp.c + 0.5,
        y: sp.r + 0.5,
        dir: p.seat === 2 || p.seat === 3 ? 0 : 1,
        alive: true,
        dyingT: 0,
        moving: false,
        walk: 0,
        bombs: 1,
        bombsOut: 0,
        fire: 1,
        speedTier: 0,
        kick: false,
        in: { x: 0, y: 0 },
        wantBomb: false,
        killedBy: null,
        diedAt: -1,       // sim seconds — lets a wipeout be decided on who fell last
      };
    });
    return this;
  };

  // ---------------- Queries ----------------

  World.prototype.at = function (r, c) {
    if (r < 0 || c < 0 || r >= H || c >= W) return TILE.HARD;
    return this.grid[r][c];
  };

  World.prototype.bombAt = function (r, c) {
    for (var i = 0; i < this.bombs.length; i++) {
      var b = this.bombs[i];
      if (b.r === r && b.c === c) return b;
    }
    return null;
  };

  World.prototype.flameAt = function (r, c) {
    return this.flames.get(this.key(r, c)) || null;
  };

  World.prototype.playerById = function (id) {
    for (var i = 0; i < this.players.length; i++) {
      if (this.players[i].id === id) return this.players[i];
    }
    return null;
  };

  World.prototype.alivePlayers = function () {
    return this.players.filter(function (p) { return p.alive; });
  };

  World.prototype.speedOf = function (p) {
    return BASE_SPEED + Math.min(MAX_SPEED_TIER, p.speedTier) * SPEED_STEP;
  };

  World.prototype.hudOf = function (p) {
    return { bombs: p.bombs, fire: p.fire, speed: p.speedTier, kick: !!p.kick, out: p.bombsOut };
  };

  // ---------------- Input ----------------

  World.prototype.setInput = function (id, x, y) {
    var p = this.playerById(id);
    if (!p || !p.alive) return;
    p.in.x = x;
    p.in.y = y;
  };

  World.prototype.clearInputs = function () {
    for (var i = 0; i < this.players.length; i++) {
      this.players[i].in.x = 0;
      this.players[i].in.y = 0;
      this.players[i].wantBomb = false;
    }
  };

  World.prototype.requestBomb = function (id) {
    var p = this.playerById(id);
    if (!p || !p.alive) return;
    p.wantBomb = true;
  };

  // ---------------- Simulation ----------------

  /**
   * Advance the world by dt seconds.
   * @returns {Array} events emitted this step (see host.js handleEvents)
   */
  World.prototype.step = function (dt) {
    this._events = [];
    if (this.frozen) return this._events;
    this.time += dt;

    var i;
    for (i = 0; i < this.players.length; i++) this._stepPlayer(this.players[i], dt);
    for (i = 0; i < this.players.length; i++) this._maybeDropBomb(this.players[i]);
    this._stepBombs(dt);
    this._stepFlames(dt);
    this._stepItems(dt);
    if (this.suddenDeath) this._stepSuddenDeath(dt);
    this._checkDeaths();

    return this._events;
  };

  World.prototype._emit = function (ev) { this._events.push(ev); };

  // ---- Movement ----

  World.prototype._stepPlayer = function (p, dt) {
    if (!p.alive) {
      if (p.dyingT < DYING_SEC) p.dyingT = Math.min(DYING_SEC, p.dyingT + dt);
      return;
    }
    var ix = p.in.x, iy = p.in.y;
    var mag = Math.sqrt(ix * ix + iy * iy);
    if (mag < DEADZONE) { p.moving = false; return; }

    // Axis-locked movement: the dominant stick axis wins, which keeps the
    // grid feel of the original while still accepting an analog stick.
    var dx = 0, dy = 0;
    if (Math.abs(ix) >= Math.abs(iy)) dx = ix > 0 ? 1 : -1;
    else dy = iy > 0 ? 1 : -1;

    var dist = this.speedOf(p) * dt;
    var moved = dx ? this._tryAxis(p, 'x', dx * dist) : this._tryAxis(p, 'y', dy * dist);

    // Walled off? Corridors are one tile wide, so a thumb a couple of degrees
    // past the diagonal picks the blocked axis and the bomber just grinds
    // against the wall — the classic "I'm pushing but I'm not moving". Take the
    // other half of a diagonal push instead, which is the lane the player can
    // actually see is open.
    if (moved < dist * 0.5) {
      var alt = dx ? iy : ix;
      if (Math.abs(alt) >= DEADZONE) {
        var sign = alt > 0 ? 1 : -1;
        var altMoved = dx ? this._tryAxis(p, 'y', sign * dist) : this._tryAxis(p, 'x', sign * dist);
        if (altMoved > 0) {
          if (dx) { dx = 0; dy = sign; } else { dy = 0; dx = sign; }
          moved = altMoved;
        }
      }
      if (moved < dist * 0.5) {
        if (dx) this._cornerAssist(p, 'x', dx, dist);
        else this._cornerAssist(p, 'y', dy, dist);
      }
    }
    p.dir = dy < 0 ? 0 : (dy > 0 ? 1 : (dx < 0 ? 2 : 3));
    p.moving = true;
    p.walk += Math.abs(moved);
  };

  /** Move along one axis with collision + kick handling. Returns distance moved. */
  World.prototype._tryAxis = function (p, axis, amt) {
    if (amt === 0) return 0;
    var sign = amt > 0 ? 1 : -1;
    var horiz = axis === 'x';
    var from = horiz ? p.x : p.y;
    var target = from + amt;
    var lead = target + sign * P_R;
    var cell = Math.floor(lead);
    var lo = Math.floor((horiz ? p.y : p.x) - P_R + EPS);
    var hi = Math.floor((horiz ? p.y : p.x) + P_R - EPS);

    var blocked = false;
    for (var q = lo; q <= hi; q++) {
      var r = horiz ? q : cell;
      var c = horiz ? cell : q;
      if (this._solidFor(p, r, c)) {
        blocked = true;
        this._tryKick(p, r, c, horiz ? sign : 0, horiz ? 0 : sign);
        break;
      }
    }
    if (blocked) {
      target = sign > 0 ? cell - P_R - EPS : cell + 1 + P_R + EPS;
      if ((sign > 0 && target < from) || (sign < 0 && target > from)) target = from;
    }
    if (horiz) p.x = target; else p.y = target;
    return Math.abs(target - from);
  };

  /**
   * Classic corner-cut: if you're pressing into a wall but the lane you're
   * *nearly* lined up with is open, slide sideways onto it instead of sticking.
   * Without this, grid games feel awful on an analog stick.
   */
  World.prototype._cornerAssist = function (p, axis, sign, dist) {
    var horiz = axis === 'x';
    var perp = horiz ? p.y : p.x;
    var lane = Math.floor(perp);
    var centre = lane + 0.5;
    var diff = centre - perp;
    if (Math.abs(diff) < 0.01) return;

    var ahead = Math.floor(horiz ? p.x : p.y) + sign;
    var r = horiz ? lane : ahead;
    var c = horiz ? ahead : lane;
    if (this._solidFor(p, r, c)) return;  // the lane is blocked too — no help

    var move = Math.min(dist, Math.abs(diff)) * (diff > 0 ? 1 : -1);
    if (horiz) p.y += move; else p.x += move;
  };

  World.prototype._solidFor = function (p, r, c) {
    var t = this.at(r, c);
    if (t === TILE.HARD || t === TILE.SOFT) return true;
    var b = this.bombAt(r, c);
    if (b && !b.pass.has(p.id)) return true;
    return false;
  };

  /** Walking into a bomb with the Kick power-up shoves it down the lane. */
  World.prototype._tryKick = function (p, r, c, sx, sy) {
    if (!p.kick) return;
    var b = this.bombAt(r, c);
    if (!b || b.vx || b.vy) return;
    if (this.at(r, c) !== TILE.FLOOR) return;
    if (!this._kickTargetFree(b, sx, sy)) return;
    b.vx = sx;
    b.vy = sy;
    this._emit({ type: 'kick', id: p.id, r: r, c: c });
  };

  World.prototype._kickTargetFree = function (b, sx, sy) {
    var r = b.r + sy, c = b.c + sx;
    if (this.at(r, c) !== TILE.FLOOR) return false;
    if (this.bombAt(r, c)) return false;
    return !this._playerOccupies(r, c, null);
  };

  World.prototype._playerOccupies = function (r, c, exceptId) {
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (!p.alive || p.id === exceptId) continue;
      if (p.x + P_R > c && p.x - P_R < c + 1 && p.y + P_R > r && p.y - P_R < r + 1) return true;
    }
    return false;
  };

  // ---- Bombs ----

  World.prototype._maybeDropBomb = function (p) {
    if (!p.wantBomb) return;
    p.wantBomb = false;
    if (!p.alive) return;
    if (p.bombsOut >= p.bombs) return;
    var r = Math.floor(p.y), c = Math.floor(p.x);
    if (this.at(r, c) !== TILE.FLOOR) return;
    if (this.bombAt(r, c)) return;
    var b = {
      owner: p.id,
      color: p.color,
      r: r, c: c,
      x: c + 0.5, y: r + 0.5,
      fuse: FUSE_SEC,
      fire: p.fire,
      vx: 0, vy: 0,
      pass: new Set([p.id]),
    };
    // Bombers walk through each other, so someone else can be standing on this
    // tile too. They get a pass as well, or they'd spawn inside a solid bomb
    // with every direction blocked — stuck there until it kills them.
    for (var i = 0; i < this.players.length; i++) {
      var q = this.players[i];
      if (!q.alive || q.id === p.id) continue;
      if (q.x + P_R > c && q.x - P_R < c + 1 && q.y + P_R > r && q.y - P_R < r + 1) b.pass.add(q.id);
    }
    this.bombs.push(b);
    p.bombsOut++;
    this._emit({ type: 'bomb', id: p.id, r: r, c: c });
  };

  World.prototype._stepBombs = function (dt) {
    var i, b;
    // Owners (and anyone else standing on a fresh bomb) may walk off it; once
    // clear, the bomb becomes solid to them too.
    for (i = 0; i < this.bombs.length; i++) {
      b = this.bombs[i];
      if (!b.pass.size) continue;
      var toClear = [];
      b.pass.forEach(function (id) {
        var p = this.playerById(id);
        if (!p || !p.alive) { toClear.push(id); return; }
        var overlap = p.x + P_R > b.c && p.x - P_R < b.c + 1 && p.y + P_R > b.r && p.y - P_R < b.r + 1;
        if (!overlap) toClear.push(id);
      }, this);
      for (var t = 0; t < toClear.length; t++) b.pass.delete(toClear[t]);
    }

    // Kicked bombs slide until something stops them.
    for (i = 0; i < this.bombs.length; i++) {
      b = this.bombs[i];
      if (!b.vx && !b.vy) continue;
      var step = KICK_SPEED * dt;
      b.x += b.vx * step;
      b.y += b.vy * step;
      var nr = Math.floor(b.y), nc = Math.floor(b.x);
      if (nr !== b.r || nc !== b.c) {
        if (this.at(nr, nc) !== TILE.FLOOR || this.bombAt(nr, nc) || this._playerOccupies(nr, nc, null)) {
          // Can't enter — settle back on the last clean tile.
          b.x = b.c + 0.5;
          b.y = b.r + 0.5;
          b.vx = 0; b.vy = 0;
          continue;
        }
        b.r = nr; b.c = nc;
        b.pass = new Set();
      }
      // Stop cleanly at the far side of the lane.
      var aheadR = b.r + b.vy, aheadC = b.c + b.vx;
      var stop = this.at(aheadR, aheadC) !== TILE.FLOOR || this.bombAt(aheadR, aheadC);
      var past = (b.vx > 0 && b.x >= b.c + 0.5) || (b.vx < 0 && b.x <= b.c + 0.5)
        || (b.vy > 0 && b.y >= b.r + 0.5) || (b.vy < 0 && b.y <= b.r + 0.5);
      if (stop && past) {
        b.x = b.c + 0.5; b.y = b.r + 0.5;
        b.vx = 0; b.vy = 0;
      }
    }

    // Fuses. Detonations are queued so chains resolve in one pass.
    var queue = [];
    for (i = 0; i < this.bombs.length; i++) {
      b = this.bombs[i];
      b.fuse -= dt;
      if (b.fuse <= 0 && !b.dead) queue.push(b);
    }
    while (queue.length) {
      var bomb = queue.shift();
      if (bomb.dead) continue;
      this._detonate(bomb, queue);
    }
    this.bombs = this.bombs.filter(function (x) { return !x.dead; });
  };

  World.prototype._detonate = function (b, queue) {
    b.dead = true;
    var owner = this.playerById(b.owner);
    if (owner) owner.bombsOut = Math.max(0, owner.bombsOut - 1);

    var cells = [{ r: b.r, c: b.c, dist: 0, axis: 'c', cap: false }];
    this._addFlame(b.r, b.c, { type: 'centre', axis: 'c', dist: 0, cap: false, color: b.color, owner: b.owner });

    for (var d = 0; d < 4; d++) {
      var dir = DIRS[d];
      var axis = dir.dx ? 'h' : 'v';
      for (var n = 1; n <= b.fire; n++) {
        var r = b.r + dir.dy * n;
        var c = b.c + dir.dx * n;
        var t = this.at(r, c);
        if (t === TILE.HARD) break;
        var cap = (n === b.fire);
        if (t === TILE.SOFT) {
          this.grid[r][c] = TILE.FLOOR;
          this._revealItem(r, c);
          this._emit({ type: 'crate', r: r, c: c });
          this._addFlame(r, c, { type: 'arm', axis: axis, dir: d, dist: n, cap: true, color: b.color, owner: b.owner });
          cells.push({ r: r, c: c, dist: n, axis: axis, cap: true });
          break;
        }
        // A bomb caught in the blast goes off immediately (chain reaction).
        var other = this.bombAt(r, c);
        if (other && !other.dead) { other.fuse = 0; queue.push(other); }
        this._addFlame(r, c, { type: 'arm', axis: axis, dir: d, dist: n, cap: cap, color: b.color, owner: b.owner });
        cells.push({ r: r, c: c, dist: n, axis: axis, cap: cap });
      }
    }
    this._emit({ type: 'explode', r: b.r, c: b.c, fire: b.fire, color: b.color, owner: b.owner, cells: cells });
  };

  World.prototype._addFlame = function (r, c, info) {
    var k = this.key(r, c);
    // A power-up sitting in the blast is destroyed — but NOT one this very
    // blast just uncovered (t === 0 until the next tick), otherwise the flame
    // that broke the crate would instantly burn the item it revealed.
    if (this.items.has(k)) {
      var it = this.items.get(k);
      if (it.t > 0) {
        this.items.delete(k);
        this._emit({ type: 'itemBurned', r: r, c: c, kind: it.type });
      }
    }
    var prev = this.flames.get(k);
    if (prev && prev.type === 'centre') { prev.t = FLAME_SEC; return; }
    this.flames.set(k, {
      r: r, c: c,
      type: info.type,
      axis: info.axis,
      dir: info.dir === undefined ? -1 : info.dir,
      dist: info.dist,
      cap: info.cap,
      color: info.color,
      owner: info.owner,
      t: FLAME_SEC,
      max: FLAME_SEC,
    });
  };

  World.prototype._stepFlames = function (dt) {
    var dead = [];
    this.flames.forEach(function (f, k) {
      f.t -= dt;
      if (f.t <= 0) dead.push(k);
    });
    for (var i = 0; i < dead.length; i++) {
      var f = this.flames.get(dead[i]);
      this.flames.delete(dead[i]);
      if (f) this._emit({ type: 'flameOut', r: f.r, c: f.c });
    }
  };

  // ---- Power-ups ----

  World.prototype._revealItem = function (r, c) {
    var k = this.key(r, c);
    if (!this.hidden.has(k)) return;
    var type = this.hidden.get(k);
    this.hidden.delete(k);
    this.items.set(k, { type: type, r: r, c: c, t: 0 });
  };

  World.prototype._stepItems = function (dt) {
    this.items.forEach(function (it) { it.t += dt; });
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (!p.alive) continue;
      var k = this.key(Math.floor(p.y), Math.floor(p.x));
      var it = this.items.get(k);
      if (!it) continue;
      this.items.delete(k);
      this._applyItem(p, it.type);
      this._emit({
        type: 'pickup', id: p.id, kind: it.type,
        name: POW_NAME[it.type], label: POW_LABEL[it.type],
        r: it.r, c: it.c, color: p.color,
      });
    }
  };

  World.prototype._applyItem = function (p, type) {
    if (type === POW.BOMB) p.bombs = Math.min(MAX_BOMBS, p.bombs + 1);
    else if (type === POW.FIRE) p.fire = Math.min(MAX_FIRE, p.fire + 1);
    else if (type === POW.SPEED) p.speedTier = Math.min(MAX_SPEED_TIER, p.speedTier + 1);
    else if (type === POW.KICK) p.kick = true;
  };

  // ---- Sudden death ----

  World.prototype.startSuddenDeath = function () {
    if (this.suddenDeath) return;
    this.suddenDeath = true;
    this.sdTimer = 0;
    this._emit({ type: 'suddenDeath' });
  };

  World.prototype._stepSuddenDeath = function (dt) {
    var i;
    // Telegraphed blocks land after their warning expires.
    for (i = this.sdPending.length - 1; i >= 0; i--) {
      var pend = this.sdPending[i];
      pend.t -= dt;
      if (pend.t > 0) continue;
      this.sdPending.splice(i, 1);
      this._landBlock(pend.r, pend.c);
    }
    this.sdTimer -= dt;
    if (this.sdTimer > 0) return;
    this.sdTimer += SD_STEP_SEC;
    if (this.sdIndex >= this.sdOrder.length) return;
    var cell = this.sdOrder[this.sdIndex++];
    // Skip cells that are already solid wall — no point warning about those.
    while (cell && this.at(cell[0], cell[1]) === TILE.HARD && this.sdIndex < this.sdOrder.length) {
      cell = this.sdOrder[this.sdIndex++];
    }
    if (!cell || this.at(cell[0], cell[1]) === TILE.HARD) return;
    this.sdPending.push({ r: cell[0], c: cell[1], t: SD_TELEGRAPH_SEC, max: SD_TELEGRAPH_SEC });
    this._emit({ type: 'sdWarn', r: cell[0], c: cell[1] });
  };

  World.prototype._landBlock = function (r, c) {
    this.grid[r][c] = TILE.HARD;
    var k = this.key(r, c);
    this.items.delete(k);
    this.hidden.delete(k);
    this.flames.delete(k);
    for (var i = this.bombs.length - 1; i >= 0; i--) {
      var b = this.bombs[i];
      if (b.r === r && b.c === c) {
        var owner = this.playerById(b.owner);
        if (owner) owner.bombsOut = Math.max(0, owner.bombsOut - 1);
        this.bombs.splice(i, 1);
      }
    }
    for (var j = 0; j < this.players.length; j++) {
      var p = this.players[j];
      if (!p.alive) continue;
      if (Math.floor(p.y) === r && Math.floor(p.x) === c) this._kill(p, 'sd');
    }
    this._emit({ type: 'sdLand', r: r, c: c });
  };

  // ---- Deaths ----

  World.prototype._checkDeaths = function () {
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (!p.alive) continue;
      var f = this.flameAt(Math.floor(p.y), Math.floor(p.x));
      if (f) this._kill(p, f.owner || null);
    }
  };

  World.prototype._kill = function (p, by) {
    if (!p.alive) return;
    p.alive = false;
    p.dyingT = 0;
    p.killedBy = by;
    p.diedAt = this.time;
    p.in.x = 0; p.in.y = 0;
    var r = Math.floor(p.y), c = Math.floor(p.x);
    this._emit({ type: 'death', id: p.id, by: by, r: r, c: c, color: p.color });
    this._dropDeathItem(r, c);
  };

  /**
   * A fallen bomber leaves a random power-up behind, so the cell where someone
   * died becomes a contested prize for whoever is still standing.
   */
  World.prototype._dropDeathItem = function (r, c) {
    if (!this.powerUps) return;
    // Nothing to stand on (a sudden-death block landed) or the tile is already
    // holding an item — skip rather than stack.
    if (this.at(r, c) !== TILE.FLOOR) return;
    var k = this.key(r, c);
    if (this.items.has(k)) return;
    var type = this._rollPowerUp();
    // t stays 0 so the blast that just killed them can't burn the drop.
    this.items.set(k, { type: type, r: r, c: c, t: 0 });
    this._emit({ type: 'itemDrop', r: r, c: c, kind: type });
  };

  World.prototype._rollPowerUp = function () {
    var total = 0, i;
    for (i = 0; i < POWERUP_WEIGHTS.length; i++) total += POWERUP_WEIGHTS[i].w;
    var roll = this._rand() * total, acc = 0;
    for (i = 0; i < POWERUP_WEIGHTS.length; i++) {
      acc += POWERUP_WEIGHTS[i].w;
      if (roll < acc) return POWERUP_WEIGHTS[i].type;
    }
    return POW.BOMB;
  };

  global.BombBrawl = {
    World: World,
    TILE: TILE,
    POW: POW,
    POW_NAME: POW_NAME,
    POW_LABEL: POW_LABEL,
    DIRS: DIRS,
    W: W,
    H: H,
    P_R: P_R,
    FUSE_SEC: FUSE_SEC,
    FLAME_SEC: FLAME_SEC,
    DYING_SEC: DYING_SEC,
    SD_STEP_SEC: SD_STEP_SEC,
    SD_TELEGRAPH_SEC: SD_TELEGRAPH_SEC,
    MAX_BOMBS: MAX_BOMBS,
    MAX_FIRE: MAX_FIRE,
    MAX_SPEED_TIER: MAX_SPEED_TIER,
    BASE_SPEED: BASE_SPEED,
    SPEED_STEP: SPEED_STEP,
    SPAWNS: SPAWNS,
    spiralCells: spiralCells,
    mulberry32: mulberry32,
  };
})(typeof window !== 'undefined' ? window : globalThis);
