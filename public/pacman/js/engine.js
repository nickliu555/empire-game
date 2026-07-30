/* Pac-Man Royale — game engine (runs on the HOST browser; also loadable
 * in Node via a window/global shim for the headless test).
 *
 * Tile-based world: positions are in TILE units (floats); a tile centre is an
 * integer coordinate. Movers only change direction at tile centres. The engine
 * keeps its OWN clock (world.now, seconds) so all timers are deterministic and
 * unit-testable — it never reads Date.now()/performance.now().
 */
(function (global) {
  'use strict';

  // Direction indices: 0=up 1=down 2=left 3=right (mirrors the player relay).
  const DIRS = [ { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 } ];
  const REVERSE = [1, 0, 3, 2];

  // ---- Tunables (tiles/sec, seconds, points) ----
  const PAC_SPEED = 4.2;
  const PAC_POWER_SPEED = 5.25;   // 25% faster than normal
  const GHOST_SPEED = 4.0;
  const GHOST_FRIGHT_SPEED = 2.4;
  const GHOST_EYES_SPEED = 9;

  const POWER_SEC = 6;           // big + fast + can-eat window
  const POWER_FLASH_SEC = 2;     // flash during the last 2s
  const FRIGHT_SEC = 6;          // ghosts frightened window (== power)

  const SCATTER_SEC = 7;
  const CHASE_SEC = 20;

  const PELLET_PTS = 10;
  const POWER_PTS = 50;
  const FRUIT_PTS = 100;
  const GHOST_BASE_PTS = 100;    // ×2 per ghost in one fright window
  const EAT_PLAYER_PTS = 200;

  const PEN_RELEASE = [0, 3, 6, 9];   // per-ghost release delay (s)
  const EYES_RESPAWN_SEC = 3;         // an eaten ghost waits this long in the pen
                                      // before heading back out (breather after a kill)

  // Power pellets spawn at random spots (classic Battle-Royale style): keep a
  // steady number on the map, respawning shortly after one is eaten.
  const POWER_TARGET = 4;             // active power pellets on the map at once
  const POWER_RESPAWN_MIN = 3;        // seconds after one is eaten
  const POWER_RESPAWN_MAX = 6;

  const DEATH_ANIM_SEC = 1.6;         // dying Pac-Man plays this before vanishing

  const FRUIT_FIRST_SEC = 12;
  const FRUIT_GAP_MIN = 14;
  const FRUIT_GAP_MAX = 24;
  const FRUIT_LIFE_SEC = 9;

  const COLLIDE_DIST = 0.85;     // tile distance for entity overlap
  const KNOCK_SEC = 0.35;        // input-lockout after an equal-size bump

  const GHOST_NAMES = ['Blinky', 'Pinky', 'Inky', 'Clyde'];
  const GHOST_COLORS = ['#FF3B30', '#FF9ED8', '#37E1FF', '#FFB852'];

  function wrapCol(c, w) { return ((c % w) + w) % w; }
  function frac(v) { const f = v - Math.round(v); return Math.abs(f); }
  function atCenter(m) { return frac(m.x) < 1e-6 && frac(m.y) < 1e-6; }

  class World {
    constructor(opts) {
      opts = opts || {};
      this.mazes = opts.mazes || (global.PacmanMazes || null);
      this.parse = opts.parse || (this.mazes && this.mazes.parse) || null;
      this.rng = opts.rng || Math.random;
      this.frozen = true;
      // While settleFreeze is set, step() advances the clock (so a death
      // animation keeps playing) but freezes ALL movement/collisions — used to
      // guarantee a round has a winner: once the 2nd-to-last Pac-Man dies the
      // whole board freezes so the last one can't also die.
      this.settleFreeze = false;
      this.now = 0;
      // Cosmetic clock for the renderer (aura pulse, flashes, pellet pulse). It
      // advances with `now` normally but FREEZES during settleFreeze, so the
      // powered aura/flash stay frozen while the final death animation plays.
      this.animClock = 0;
      this.roster = [];
      this.players = [];
      this.ghosts = [];
      this.byId = new Map();
      this.board = null;
      this.mazeIndex = 0;
      this.fruit = null;
      this.nextFruitAt = FRUIT_FIRST_SEC;
      this.fruitIdx = 0;
      this.scatter = true;
      this.scatterTimer = SCATTER_SEC;
      this.frightUntil = 0;      // world.now when the global fright ends (0=none)
      this.ghostChain = 0;       // ghosts eaten in the current fright window
    }

    setRoster(roster) { this.roster = roster || []; }

    /** Build a fresh round on the given maze. Resets scores? No — scores are
     *  owned by the host; the engine only resets positions/pellets/ghosts. */
    reset(mazeIndex) {
      const defs = this.mazes;
      if (!defs || !this.parse) throw new Error('PacmanMazes not available');
      this.mazeIndex = ((mazeIndex | 0) % defs.length + defs.length) % defs.length;
      this.board = this.parse(defs[this.mazeIndex]);
      this.settleFreeze = false;
      // Fresh mutable pellet sets.
      this.board.pellets = new Set(this.board.pellets);
      this.board.powerPellets = new Set(this.board.powerPellets);
      // The maze's fixed 'o' tiles become ordinary pellets; power pellets are
      // spawned at random spots instead and respawn as they're eaten.
      for (const key of this.board.powerPellets) this.board.pellets.add(key);
      this.board.powerPellets = new Set();
      // Snapshot every pellet-eligible tile so the board can be REFILLED when it
      // gets fully cleared (the round keeps going for its full length instead of
      // ending early).
      this._allPellets = new Set(this.board.pellets);
      this.powerRespawns = [];
      // Cache open path tiles (excluding the ghost house) for fallback spawns.
      this._openTiles = [];
      for (let r = 0; r < this.board.h; r++) for (let c = 0; c < this.board.w; c++) {
        if (this.board.tiles[r][c] === 1 && !this._inHouse(r, c)) this._openTiles.push(r + ',' + c);
      }
      // Precompute door metadata (top/bottom entrances) and a BFS flow field to
      // the pen doors so eaten ghosts (eyes) can ALWAYS path home — greedy
      // Euclidean can get stuck in the braided mazes.
      this._computeDoorMeta();
      this._computeEyesField();
      this.now = 0;
      this.animClock = 0;
      this.scatter = true;
      this.scatterTimer = SCATTER_SEC;
      this.frightUntil = 0;
      this.ghostChain = 0;
      this.fruit = null;
      this.fruitIdx = 0;
      this.nextFruitAt = FRUIT_FIRST_SEC;

      // Players → Pac-Men at the four corner spawns (by seat).
      this.players = [];
      this.byId = new Map();
      const spawns = this.board.playerSpawns;
      this.roster.forEach((r, i) => {
        const sp = spawns[i % spawns.length];
        const p = {
          id: r.id, name: r.name, color: r.color, seat: r.seat,
          isBot: !!r.isBot, connected: r.connected !== false,
          x: sp[1], y: sp[0], dirIdx: 2, desired: -1, facing: 2,
          alive: true, powered: false, poweredEnd: 0, knockUntil: 0,
          spawn: [sp[0], sp[1]],
          mouth: 0,
        };
        this.players.push(p);
        this.byId.set(p.id, p);
      });

      // Seed the map with random power pellets.
      for (let i = 0; i < POWER_TARGET; i++) this._spawnPowerPellet();

      // Four ghosts in the pen.
      this.ghosts = [];
      const gs = this.board.ghostSpawns;
      for (let i = 0; i < 4; i++) {
        const sp = gs[i % gs.length];
        this.ghosts.push({
          idx: i, name: GHOST_NAMES[i], color: GHOST_COLORS[i],
          x: sp[1], y: sp[0], dirIdx: 0,
          state: 'pen',                 // pen | leaving | active | frightened | eyes
          releaseAt: PEN_RELEASE[i] || 0,
          home: sp,
        });
      }
    }

    // ---- Input ----
    setDesiredDir(id, dirIdx) {
      const p = this.byId.get(id);
      if (!p || !p.alive) return;
      if (dirIdx < 0 || dirIdx > 3) return;
      p.desired = dirIdx;
    }
    clearInputs(id) { const p = this.byId.get(id); if (p) p.desired = -1; }

    // ---- Queries ----
    aliveCount() { let n = 0; for (const p of this.players) if (p.alive) n++; return n; }
    pelletsLeft() { return this.board ? this.board.pellets.size + this.board.powerPellets.size : 0; }
    // True while any just-killed Pac-Man is still playing its death animation.
    anyDying() { for (const p of this.players) if (!p.alive && p.dying != null && (this.now - p.dying) < DEATH_ANIM_SEC) return true; return false; }

    _inHouse(r, c) {
      const b = this.board; if (!b || !b.door) return false;
      const dr = b.door[0], dc = b.door[1];
      return r >= dr && r <= dr + 3 && c >= dc - 2 && c <= dc + 2;
    }
    // Classify every pen door as a top or bottom entrance and precompute, for
    // each, the tile just OUTSIDE the pen plus the directions to step in/out.
    // `board.door` (the top door) stays the reference for pen bounds.
    _computeDoorMeta() {
      const b = this.board;
      const doors = (b.doors && b.doors.length) ? b.doors : (b.door ? [b.door] : []);
      let topRow = Infinity;
      for (const d of doors) if (d[0] < topRow) topRow = d[0];
      b.doorMeta = doors.map(function (d) {
        const isTop = d[0] === topRow;
        return {
          r: d[0], c: d[1], isTop: isTop,
          outsideR: isTop ? d[0] - 1 : d[0] + 1, // tile just outside the pen
          enterDir: isTop ? 1 : 0,               // step INTO the pen (down/up)
          exitDir: isTop ? 0 : 1,                // step OUT of the pen (up/down)
        };
      });
    }
    // BFS distance field to the tile just outside EACH pen door (multi-source),
    // over all ghost-walkable tiles (doors passable, tunnels wrap). Eyes follow
    // it home and naturally head for whichever door is nearest.
    _computeEyesField() {
      const b = this.board;
      const W = b.w, H = b.h;
      const dist = [];
      for (let r = 0; r < H; r++) dist.push(new Array(W).fill(Infinity));
      const q = [];
      let head = 0;
      const metas = (b.doorMeta && b.doorMeta.length) ? b.doorMeta : [{ outsideR: b.door[0] - 1, c: b.door[1] }];
      for (const dm of metas) {
        const sr = dm.outsideR, sc = dm.c;
        if (sr >= 0 && sr < H && sc >= 0 && sc < W && dist[sr][sc] === Infinity) {
          dist[sr][sc] = 0; q.push([sr, sc]);
        }
      }
      while (head < q.length) {
        const [r, c] = q[head++]; const d = dist[r][c];
        for (const dv of DIRS) {
          const nr = r + dv.y; if (nr < 0 || nr >= H) continue;
          const nc = wrapCol(c + dv.x, W);
          if (b.tiles[nr][nc] === 0) continue; // wall blocks; door (2) is walkable
          if (dist[nr][nc] > d + 1) { dist[nr][nc] = d + 1; q.push([nr, nc]); }
        }
      }
      b.eyesDist = dist;
    }
    // Pick the neighbour with the smallest distance-to-home (may reverse) so
    // returning eyes make monotonic progress and never get stuck.
    _eyesDir(g) {
      const b = this.board, field = b.eyesDist;
      const cx = g.x, cy = g.y;
      let best = -1, bestD = Infinity;
      for (const idx of [0, 1, 2, 3]) {
        const dv = DIRS[idx];
        const nr = cy + dv.y; if (nr < 0 || nr >= b.h) continue;
        const nc = wrapCol(cx + dv.x, b.w);
        if (b.tiles[nr][nc] === 0) continue;
        const d = field[nr][nc];
        if (d < bestD) { bestD = d; best = idx; }
      }
      g.dirIdx = best >= 0 ? best : REVERSE[g.dirIdx];
    }
    // The pen door a ghost LEAVES through — the one nearest its home row, so the
    // 2×2 pen splits evenly (top-row ghosts take the top door, bottom-row the
    // bottom door). Keeps ghost pressure balanced across the map's halves.
    _exitDoor(g) {
      const metas = this.board.doorMeta;
      if (!metas || !metas.length) return { r: this.board.door[0], c: this.board.door[1], isTop: true, outsideR: this.board.door[0] - 1, enterDir: 1, exitDir: 0 };
      let best = metas[0], bd = Infinity;
      for (const dm of metas) { const d = Math.abs(g.home[0] - dm.r); if (d < bd) { bd = d; best = dm; } }
      return best;
    }
    // The pen door a returning ghost (eyes) heads for — the one nearest its
    // current row, so it re-enters from whichever side is closer.
    _nearestDoorMeta(r) {
      const metas = this.board.doorMeta;
      if (!metas || !metas.length) return { r: this.board.door[0], c: this.board.door[1], isTop: true, outsideR: this.board.door[0] - 1, enterDir: 1, exitDir: 0 };
      let best = metas[0], bd = Infinity;
      for (const dm of metas) { const d = Math.abs(r - dm.outsideR); if (d < bd) { bd = d; best = dm; } }
      return best;
    }
    // Spawn one power pellet at a random remaining pellet tile (fallback: any
    // open tile outside the house).
    _spawnPowerPellet() {
      const b = this.board; if (!b) return;
      const pool = [];
      for (const key of b.pellets) if (!b.powerPellets.has(key)) pool.push(key);
      let key = null;
      if (pool.length) key = pool[(this.rng() * pool.length) | 0];
      else if (this._openTiles && this._openTiles.length) {
        for (let tries = 0; tries < 30 && !key; tries++) {
          const k = this._openTiles[(this.rng() * this._openTiles.length) | 0];
          if (!b.powerPellets.has(k)) key = k;
        }
      }
      if (!key) return;
      b.pellets.delete(key);
      b.powerPellets.add(key);
    }
    _updatePowers() {
      if (!this.powerRespawns || !this.powerRespawns.length) return;
      const still = [];
      for (const t of this.powerRespawns) { if (this.now >= t) this._spawnPowerPellet(); else still.push(t); }
      this.powerRespawns = still;
    }
    // Re-populate every pellet tile that isn't currently holding a power pellet.
    refillPellets() {
      if (!this._allPellets) return;
      for (const key of this._allPellets) if (!this.board.powerPellets.has(key)) this.board.pellets.add(key);
    }

    passable(r, c, opts) {
      const b = this.board;
      if (r < 0 || r >= b.h) return false;
      const cc = wrapCol(c, b.w);
      const t = b.tiles[r][cc];
      if (t === 0) return false;           // WALL
      if (t === 2) return !!(opts && opts.door); // DOOR
      return true;
    }

    // ---- Main step ----
    step(dt) {
      const ev = { pellets: 0, powerEaten: [], ghostsEaten: [], playerKills: [], deaths: [], fruitEaten: false, fruitBy: null, boardCleared: false };
      if (this.frozen || !this.board) return ev;
      this.now += dt;
      // Death-settle: advance the clock only (keeps the dying animation running)
      // while everything else stays frozen so no further deaths can occur.
      if (this.settleFreeze) return ev;
      this.animClock += dt;

      this._updateScatter(dt);
      this._updateFright();
      this._updateFruit();
      this._updatePowers();

      for (const p of this.players) this._movePac(p, dt);
      for (const g of this.ghosts) this._moveGhost(g, dt);

      this._collisions(ev, dt);
      // Board fully cleared → refill so the round runs its full length rather
      // than ending the moment the maze is empty.
      if (this.board.pellets.size === 0) { this.refillPellets(); ev.boardCleared = true; }
      return ev;
    }

    _updateScatter(dt) {
      // Scatter/chase alternation pauses while any fright is active (classic).
      if (this.frightUntil > this.now) return;
      this.scatterTimer -= dt;
      if (this.scatterTimer <= 0) {
        this.scatter = !this.scatter;
        this.scatterTimer = this.scatter ? SCATTER_SEC : CHASE_SEC;
      }
    }
    _updateFright() {
      if (this.frightUntil && this.now >= this.frightUntil) {
        this.frightUntil = 0;
        this.ghostChain = 0;
        for (const g of this.ghosts) if (g.state === 'frightened') g.state = 'active';
      }
      // Fright is applied ONLY to the ghosts that are on the maze at the instant a
      // power pellet is eaten (see _startFright). Ghosts that spawn or respawn
      // AFTER that are NOT retroactively frightened — they come out normal and can
      // hunt (and kill) a powered player, classic Pac-Man Battle-Royale style.
      // Expire per-pac power.
      for (const p of this.players) {
        if (p.powered && this.now >= p.poweredEnd) p.powered = false;
      }
    }
    _updateFruit() {
      if (this.fruit) {
        if (this.now >= this.fruit.until) { this.fruit = null; this.nextFruitAt = this.now + FRUIT_GAP_MIN; }
        return;
      }
      if (this.now >= this.nextFruitAt) {
        const spots = this.board.fruitSpawns;
        if (spots && spots.length) {
          const sp = spots[this.fruitIdx % spots.length];
          this.fruitIdx++;
          this.fruit = { r: sp[0], c: sp[1], until: this.now + FRUIT_LIFE_SEC };
        }
      }
    }

    // ---- Pac movement ----
    _movePac(p, dt) {
      if (!p.alive) return;
      p.mouth = (p.mouth + dt * 10) % (Math.PI * 2);
      let dist = (p.powered ? PAC_POWER_SPEED : PAC_SPEED) * dt;
      const knocked = this.now < p.knockUntil;
      while (dist > 1e-9) {
        if (atCenter(p)) {
          p.x = Math.round(p.x); p.y = Math.round(p.y);
          const cx = p.x, cy = p.y;
          const canGo = (idx) => { const d = DIRS[idx]; return this.passable(cy + d.y, cx + d.x, { door: false }); };
          if (!knocked && p.desired >= 0 && canGo(p.desired)) p.dirIdx = p.desired;
          else if (p.dirIdx >= 0 && canGo(p.dirIdx)) { /* keep */ }
          else { p.dirIdx = -1; }
          // Keep facing the last direction actually travelled — a Pac-Man that
          // runs into a wall stays pointing that way instead of snapping around.
          if (p.dirIdx >= 0) p.facing = p.dirIdx;
          if (p.dirIdx < 0) break;
        }
        dist = this._advance(p, dist);
      }
    }

    // ---- Ghost movement ----
    _moveGhost(g, dt) {
      let speed = GHOST_SPEED;
      if (g.state === 'eyes') speed = GHOST_EYES_SPEED;
      else if (g.state === 'frightened') speed = GHOST_FRIGHT_SPEED;
      else if (g.state === 'pen') {
        if (this.now >= g.releaseAt) g.state = 'leaving';
        else return; // wait in the pen
      }
      let dist = speed * dt;
      while (dist > 1e-9) {
        if (atCenter(g)) {
          g.x = Math.round(g.x); g.y = Math.round(g.y);
          this._chooseGhostDir(g);
          if (g.dirIdx < 0) break;
        }
        dist = this._advance(g, dist);
      }
    }

    _chooseGhostDir(g) {
      const cx = g.x, cy = g.y;
      const b = this.board;
      if (g.state === 'leaving') {
        const dm = this._exitDoor(g);
        if (cx !== dm.c) { g.dirIdx = cx < dm.c ? 3 : 2; return; }
        // Head out through the door: up for a top door, down for a bottom one.
        const outside = dm.isTop ? (cy <= dm.outsideR) : (cy >= dm.outsideR);
        if (!outside) { g.dirIdx = dm.exitDir; return; }
        // Now clear of the pen → roam. A ghost ALWAYS comes out in its normal
        // (non-frightened) state, even if a power window is still live: it wasn't
        // on the maze when the pellet was eaten, so it isn't vulnerable — it can
        // hunt (and kill) the powered player (classic Battle-Royale rule).
        g.state = 'active';
      }
      if (g.state === 'eyes') {
        const dm = this._nearestDoorMeta(cy);
        // Aligned with a door column and level with (or past) its outer tile →
        // step into the pen toward the home row, then respawn there.
        const atCol = (cx === dm.c);
        const pastOutside = dm.isTop ? (cy >= dm.outsideR) : (cy <= dm.outsideR);
        if (atCol && pastOutside) {
          const reachedHome = dm.isTop ? (cy >= g.home[0]) : (cy <= g.home[0]);
          if (!reachedHome) { g.dirIdx = dm.enterDir; return; } // through the door
          // Arrived home → respawn.
          g.state = 'pen'; g.releaseAt = this.now + EYES_RESPAWN_SEC; g.dirIdx = 0; return;
        }
        // Follow the precomputed flow field home (always reaches a door).
        this._eyesDir(g);
        return;
      }
      if (g.state === 'frightened') { this._fleeDir(g); return; }
      // Active: personality target.
      const tgt = this._ghostTarget(g);
      this._greedyDir(g, tgt.r, tgt.c, { door: false });
    }

    _ghostTarget(g) {
      const b = this.board;
      // Scatter → home corners.
      const corners = [ [1, b.w - 2], [1, 1], [b.h - 2, b.w - 2], [b.h - 2, 1] ];
      if (this.scatter) { const c = corners[g.idx]; return { r: c[0], c: c[1] }; }
      const pac = this._nearestPac(g);
      if (!pac) { const c = corners[g.idx]; return { r: c[0], c: c[1] }; }
      const pr = Math.round(pac.y), pc = Math.round(pac.x);
      const pd = pac.dirIdx >= 0 ? DIRS[pac.dirIdx] : { x: 0, y: 0 };
      if (g.idx === 0) return { r: pr, c: pc };                       // Blinky
      if (g.idx === 1) return { r: pr + pd.y * 4, c: pc + pd.x * 4 }; // Pinky
      if (g.idx === 2) {                                             // Inky
        const ar = pr + pd.y * 2, ac = pc + pd.x * 2;
        const blinky = this.ghosts[0];
        const br = Math.round(blinky.y), bc = Math.round(blinky.x);
        return { r: 2 * ar - br, c: 2 * ac - bc };
      }
      // Clyde: chase if far, scatter to corner if close.
      const d2 = (g.y - pr) * (g.y - pr) + (g.x - pc) * (g.x - pc);
      if (d2 > 64) return { r: pr, c: pc };
      const c = corners[3]; return { r: c[0], c: c[1] };
    }

    _nearestPac(g) {
      let best = null, bd = Infinity;
      for (const p of this.players) {
        if (!p.alive) continue;
        const d = (p.y - g.y) * (p.y - g.y) + (p.x - g.x) * (p.x - g.x);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }

    _greedyDir(g, tr, tc, opts) {
      const cx = g.x, cy = g.y;
      const rev = REVERSE[g.dirIdx];
      let best = -1, bestDist = Infinity;
      for (const idx of [0, 2, 1, 3]) { // pref up,left,down,right
        if (idx === rev) continue;
        const d = DIRS[idx];
        if (!this.passable(cy + d.y, cx + d.x, opts)) continue;
        const nr = cy + d.y, nc = cx + d.x;
        const dist = (nr - tr) * (nr - tr) + (nc - tc) * (nc - tc);
        if (dist < bestDist) { bestDist = dist; best = idx; }
      }
      if (best < 0) { const d = DIRS[rev]; best = this.passable(cy + d.y, cx + d.x, opts) ? rev : -1; }
      g.dirIdx = best;
    }
    _randomDir(g) {
      const cx = g.x, cy = g.y;
      const rev = REVERSE[g.dirIdx];
      const opts2 = { door: false };
      const choices = [];
      for (const idx of [0, 1, 2, 3]) {
        if (idx === rev) continue;
        const d = DIRS[idx];
        if (this.passable(cy + d.y, cx + d.x, opts2)) choices.push(idx);
      }
      if (!choices.length) { const d = DIRS[rev]; g.dirIdx = this.passable(cy + d.y, cx + d.x, opts2) ? rev : -1; return; }
      g.dirIdx = choices[(this.rng() * choices.length) | 0];
    }
    // Frightened: actively flee. Among the non-reverse open exits, step toward the
    // one that gets FARTHEST from the nearest powered player (the only thing that
    // can eat a blue ghost). Column distance accounts for the wrap tunnels. Falls
    // back to a random turn when nobody is currently powered.
    _fleeDir(g) {
      const powered = [];
      for (const p of this.players) if (p.alive && p.powered) powered.push(p);
      if (!powered.length) { this._randomDir(g); return; }
      const W = this.board.w;
      const cx = g.x, cy = g.y;
      const rev = REVERSE[g.dirIdx];
      let best = -1, bestScore = -Infinity;
      for (const idx of [0, 1, 2, 3]) {
        if (idx === rev) continue;
        const d = DIRS[idx];
        const nr = cy + d.y, nc = cx + d.x;
        if (!this.passable(nr, nc, { door: false })) continue;
        // Squared distance from this candidate tile to the CLOSEST powered pac.
        let nearest = Infinity;
        for (const p of powered) {
          let ex = nc - p.x;
          if (ex > W / 2) ex -= W; else if (ex < -W / 2) ex += W; // shortest way round the tunnel
          const ey = nr - p.y;
          const dd = ex * ex + ey * ey;
          if (dd < nearest) nearest = dd;
        }
        if (nearest > bestScore) { bestScore = nearest; best = idx; }
      }
      if (best < 0) { const d = DIRS[rev]; best = this.passable(cy + d.y, cx + d.x, { door: false }) ? rev : -1; }
      g.dirIdx = best;
    }

    // Advance a mover toward the next tile centre; returns leftover distance.
    _advance(m, dist) {
      const d = DIRS[m.dirIdx];
      let dtc; // distance to next centre along dir
      if (d.x > 0) dtc = (Math.floor(m.x + 1e-9) + 1) - m.x;
      else if (d.x < 0) dtc = m.x - (Math.ceil(m.x - 1e-9) - 1);
      else if (d.y > 0) dtc = (Math.floor(m.y + 1e-9) + 1) - m.y;
      else dtc = m.y - (Math.ceil(m.y - 1e-9) - 1);
      if (dtc < 1e-9) dtc = 1;
      const move = Math.min(dist, dtc);
      m.x += d.x * move; m.y += d.y * move;
      // Horizontal wrap on tunnel rows.
      const b = this.board;
      if (m.x < -0.5) m.x += b.w;
      else if (m.x > b.w - 0.5) m.x -= b.w;
      return dist - move;
    }

    // ---- Collisions / scoring ----
    _collisions(ev, dt) {
      const b = this.board;
      // Pellets / power / fruit.
      for (const p of this.players) {
        if (!p.alive) continue;
        const r = Math.round(p.y), c = wrapCol(Math.round(p.x), b.w);
        const key = r + ',' + c;
        if (b.pellets.has(key)) { b.pellets.delete(key); p._scoreDelta = (p._scoreDelta || 0) + PELLET_PTS; ev.pellets++; }
        else if (b.powerPellets.has(key)) {
          b.powerPellets.delete(key);
          p._scoreDelta = (p._scoreDelta || 0) + POWER_PTS;
          if (!p.powered) {
            // Only a NON-powered player powers up (and re-scares the ghosts).
            p.powered = true; p.poweredEnd = this.now + POWER_SEC;
            ev.powerEaten.push(p.id);
            this._startFright();
          } else {
            // Already powered: the pellet is simply consumed for points — it does
            // NOT extend the power timer or re-trigger the ghost fright.
            ev.pellets++;
          }
          // Schedule a replacement power pellet elsewhere on the map.
          this.powerRespawns.push(this.now + POWER_RESPAWN_MIN + this.rng() * (POWER_RESPAWN_MAX - POWER_RESPAWN_MIN));
        }
        if (this.fruit && this.fruit.r === r && this.fruit.c === c) {
          p._scoreDelta = (p._scoreDelta || 0) + FRUIT_PTS;
          this.fruit = null; this.nextFruitAt = this.now + FRUIT_GAP_MIN + this.rng() * (FRUIT_GAP_MAX - FRUIT_GAP_MIN);
          ev.fruitEaten = true;
          ev.fruitBy = p.id;
        }
      }
      // Pac vs ghost.
      for (const p of this.players) {
        if (!p.alive) continue;
        for (const g of this.ghosts) {
          if (g.state === 'eyes' || g.state === 'pen' || g.state === 'leaving') continue;
          const dx = p.x - g.x, dy = p.y - g.y;
          if (dx * dx + dy * dy > COLLIDE_DIST * COLLIDE_DIST) continue;
          if (g.state === 'frightened') {
            // Only a POWERED player can eat a frightened ghost. Any other player
            // passes harmlessly through it (can't eat, doesn't die).
            if (p.powered) {
              const pts = GHOST_BASE_PTS * Math.pow(2, Math.min(this.ghostChain, 3));
              this.ghostChain++;
              p._scoreDelta = (p._scoreDelta || 0) + pts;
              g.state = 'eyes';
              ev.ghostsEaten.push({ by: p.id, pts });
            }
          } else {
            // A NORMAL (non-frightened) ghost kills ANY player it touches. Being
            // powered is NOT invincibility — it only lets you eat the blue ghosts
            // your pellet caught, so a freshly-spawned normal ghost can hunt you
            // down even mid-power.
            p.alive = false; p.dirIdx = -1; p.dying = this.now;
            ev.deaths.push(p.id);
            break;
          }
        }
      }
      // Pac vs pac.
      for (let i = 0; i < this.players.length; i++) {
        const a = this.players[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < this.players.length; j++) {
          const bb = this.players[j];
          if (!bb.alive) continue;
          const dx = a.x - bb.x, dy = a.y - bb.y;
          if (dx * dx + dy * dy > COLLIDE_DIST * COLLIDE_DIST) continue;
          if (a.powered && !bb.powered) { this._eatPlayer(a, bb, ev); }
          else if (bb.powered && !a.powered) { this._eatPlayer(bb, a, ev); }
          else { this._knock(a, bb); }
        }
      }
      // Commit score deltas.
      for (const p of this.players) {
        if (p._scoreDelta) { p.score = (p.score || 0) + p._scoreDelta; p._scoreDelta = 0; }
      }
    }

    _startFright() {
      this.frightUntil = this.now + FRIGHT_SEC;
      this.ghostChain = 0;
      for (const g of this.ghosts) {
        if (g.state === 'active') { g.state = 'frightened'; g.dirIdx = REVERSE[g.dirIdx]; }
        else if (g.state === 'frightened') { /* refresh timer only */ }
      }
    }
    _eatPlayer(winner, loser, ev) {
      loser.alive = false; loser.dirIdx = -1; loser.dying = this.now;
      winner._scoreDelta = (winner._scoreDelta || 0) + EAT_PLAYER_PTS;
      ev.playerKills.push({ killer: winner.id, victim: loser.id });
      ev.deaths.push(loser.id);
    }
    _knock(a, bb) {
      // Equal size: both reverse + input-locked briefly so they separate.
      if (a.dirIdx >= 0) a.dirIdx = REVERSE[a.dirIdx];
      if (bb.dirIdx >= 0) bb.dirIdx = REVERSE[bb.dirIdx];
      a.knockUntil = this.now + KNOCK_SEC;
      bb.knockUntil = this.now + KNOCK_SEC;
    }

    // Snapshot of per-pac round scores (host owns the authoritative tally).
    scores() { const o = {}; for (const p of this.players) o[p.id] = p.score || 0; return o; }
  }

  const api = {
    World, DIRS, REVERSE,
    POWER_SEC, POWER_FLASH_SEC, FRIGHT_SEC, DEATH_ANIM_SEC,
    PELLET_PTS, POWER_PTS, FRUIT_PTS, GHOST_BASE_PTS, EAT_PLAYER_PTS,
    GHOST_NAMES, GHOST_COLORS,
  };
  global.Pacman = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
