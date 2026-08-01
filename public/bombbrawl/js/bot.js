/* Bomb Brawl — CPU bomber AI (runs on the host, alongside the engine).
 *
 * Each CPU keeps a simple loop: build a danger map of every pending blast,
 * run away if it is standing in one, otherwise walk toward something worth
 * blowing up. It will only ever drop a bomb when it can prove an escape route
 * exists, which is what stops CPUs from suiciding on their own fuses.
 *
 * Difficulty tunes how often it re-thinks, how much slack it leaves itself,
 * how often it deliberately blunders, and how eager it is to hunt.
 */
(function (global) {
  'use strict';

  const BB = global.BombBrawl;
  const TILE = BB.TILE;
  const W = BB.W, H = BB.H;
  const FUSE_SEC = BB.FUSE_SEC;
  const FLAME_SEC = BB.FLAME_SEC;
  const SD_STEP_SEC = BB.SD_STEP_SEC;
  const SD_TELEGRAPH_SEC = BB.SD_TELEGRAPH_SEC;
  const SD_LOOKAHEAD = 5;   // upcoming spiral cells treated as already doomed

  const LEVELS = {
    easy: { interval: 0.34, react: 0.30, mistake: 0.26, aggression: 0.20, margin: 0.55, hunt: 5 },
    normal: { interval: 0.18, react: 0.14, mistake: 0.10, aggression: 0.50, margin: 0.35, hunt: 8 },
    hard: { interval: 0.09, react: 0.05, mistake: 0.02, aggression: 0.85, margin: 0.22, hunt: 99 },
  };

  const STEP = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  function key(r, c) { return r * W + c; }

  /** Cells a bomb would cover right now, stopping at the first hard/soft tile. */
  function blastCells(world, b) {
    const out = [[b.r, b.c]];
    for (let d = 0; d < STEP.length; d++) {
      for (let n = 1; n <= b.fire; n++) {
        const r = b.r + STEP[d][0] * n;
        const c = b.c + STEP[d][1] * n;
        const t = world.at(r, c);
        if (t === TILE.HARD) break;
        out.push([r, c]);
        if (t === TILE.SOFT) break;
      }
    }
    return out;
  }

  /**
   * danger[r*W+c] = seconds until that cell becomes lethal (0 = lethal now).
   * Chain reactions are resolved by relaxing each bomb's timer a few passes.
   */
  function dangerMap(world) {
    const danger = new Float32Array(W * H).fill(Infinity);
    const bombs = world.bombs;
    if (bombs.length) {
      const times = bombs.map(function (b) { return Math.max(0, b.fuse); });
      const cellsFor = bombs.map(function (b) { return blastCells(world, b); });
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < bombs.length; i++) {
          for (let j = 0; j < bombs.length; j++) {
            if (i === j) continue;
            const cs = cellsFor[i];
            for (let k = 0; k < cs.length; k++) {
              if (cs[k][0] === bombs[j].r && cs[k][1] === bombs[j].c) {
                if (times[i] < times[j]) times[j] = times[i];
                break;
              }
            }
          }
        }
      }
      for (let i = 0; i < bombs.length; i++) {
        const cs = cellsFor[i];
        for (let k = 0; k < cs.length; k++) {
          const idx = key(cs[k][0], cs[k][1]);
          if (times[i] < danger[idx]) danger[idx] = times[i];
        }
      }
    }
    world.flames.forEach(function (f) { danger[key(f.r, f.c)] = 0; });
    if (world.suddenDeath) foldSuddenDeath(world, danger);
    return danger;
  }

  /**
   * A falling block is every bit as lethal as a blast, so it belongs in the
   * same map. Telegraphed blocks land when their warning expires; on top of
   * that we look a few cells further down the spiral, because a bot that only
   * reacts to the warning has half a second to get clear and will happily walk
   * into the crush before then.
   */
  function foldSuddenDeath(world, danger) {
    const pend = world.sdPending;
    for (let i = 0; i < pend.length; i++) {
      const idx = key(pend[i].r, pend[i].c);
      const t = Math.max(0, pend[i].t);
      if (t < danger[idx]) danger[idx] = t;
    }
    // The spiral advances one cell every SD_STEP_SEC and each cell lands a
    // telegraph later; cells that are already wall are skipped without
    // costing a step, exactly like the engine does.
    const base = Math.max(0, world.sdTimer);
    let n = 0;
    for (let i = world.sdIndex; i < world.sdOrder.length && n < SD_LOOKAHEAD; i++) {
      const cell = world.sdOrder[i];
      if (world.at(cell[0], cell[1]) === TILE.HARD) continue;
      const idx = key(cell[0], cell[1]);
      const impact = base + n * SD_STEP_SEC + SD_TELEGRAPH_SEC;
      if (impact < danger[idx]) danger[idx] = impact;
      n++;
    }
  }

  /** Walkable for path-finding: open floor with no bomb parked on it. */
  function open(world, r, c) {
    if (world.at(r, c) !== TILE.FLOOR) return false;
    return !world.bombAt(r, c);
  }

  /** Copy of `danger` with a hypothetical bomb at (r, c) folded in. */
  function withBomb(world, danger, r, c, fire) {
    const after = danger.slice();
    // A bomb dropped inside a live blast is chain-detonated early, so it goes
    // off with whatever time that cell already has — not a fresh full fuse.
    const t = Math.min(FUSE_SEC, danger[key(r, c)]);
    const cs = blastCells(world, { r: r, c: c, fire: fire });
    for (let i = 0; i < cs.length; i++) {
      const idx = key(cs[i][0], cs[i][1]);
      if (t < after[idx]) after[idx] = t;
    }
    // The new bomb can also chain any bomb it covers, pulling that blast
    // forward too. One relaxation pass is enough for the shapes we generate.
    const bombs = world.bombs;
    for (let i = 0; i < bombs.length; i++) {
      const bk = key(bombs[i].r, bombs[i].c);
      if (after[bk] >= Math.max(0, bombs[i].fuse)) continue;
      const bc = blastCells(world, bombs[i]);
      for (let j = 0; j < bc.length; j++) {
        const idx = key(bc[j][0], bc[j][1]);
        if (after[bk] < after[idx]) after[idx] = after[bk];
      }
    }
    return after;
  }

  /**
   * BFS from a tile. Returns { dist, from } where `from` records the previous
   * cell so a first step can be recovered. `canEnter(k, dist)` decides whether
   * a candidate cell may be walked through, which is how danger awareness is
   * injected: the goal search refuses any pending blast, while the escape
   * search allows crossing one it can clear before the fuse runs out.
   */
  function flood(world, sr, sc, canEnter) {
    const dist = new Int16Array(W * H).fill(-1);
    const from = new Int16Array(W * H).fill(-1);
    const q = [key(sr, sc)];
    dist[q[0]] = 0;
    let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      const r = (cur / W) | 0, c = cur % W;
      for (let d = 0; d < STEP.length; d++) {
        const nr = r + STEP[d][0], nc = c + STEP[d][1];
        if (nr < 0 || nc < 0 || nr >= H || nc >= W) continue;
        const nk = key(nr, nc);
        if (dist[nk] !== -1) continue;
        if (!open(world, nr, nc)) continue;
        const nd = dist[cur] + 1;
        if (canEnter && !canEnter(nk, nd)) continue;
        dist[nk] = nd;
        from[nk] = cur;
        q.push(nk);
      }
    }
    return { dist: dist, from: from };
  }

  /** Field that will never route the bot through a cell that is going to blow. */
  function safeField(world, sr, sc, danger) {
    return flood(world, sr, sc, function (k) { return danger[k] === Infinity; });
  }

  /**
   * Field for running away: a cell may be crossed only if we would be standing
   * on it before its blast lands (plus a difficulty-scaled safety margin).
   */
  function escapeField(world, sr, sc, danger, speed, margin) {
    return flood(world, sr, sc, function (k, d) {
      return danger[k] === Infinity || danger[k] > d / speed + margin;
    });
  }

  /** Recover the direction of the first step along the path to `target`. */
  function firstStep(field, sr, sc, target) {
    let cur = target;
    const start = key(sr, sc);
    if (cur === start) return null;
    while (field.from[cur] !== -1 && field.from[cur] !== start) cur = field.from[cur];
    if (field.from[cur] !== start) return null;
    const r = (cur / W) | 0, c = cur % W;
    return [c - sc, r - sr];
  }

  // ------------------------------------------------------------------- Bot

  function Bot(id, difficulty) {
    this.id = id;
    this.level = LEVELS[difficulty] || LEVELS.normal;
    this.timer = Math.random() * this.level.interval;
    this.move = [0, 0];
    this.blunder = 0;
  }

  Bot.prototype.setDifficulty = function (difficulty) {
    this.level = LEVELS[difficulty] || LEVELS.normal;
  };

  Bot.prototype.update = function (world, dt) {
    const p = world.playerById(this.id);
    if (!p || !p.alive) return;
    this.timer -= dt;
    if (this.blunder > 0) {
      this.blunder -= dt;
      // Abandon the blunder the moment the tile underfoot turns lethal —
      // wandering is meant to look careless, not to be a death sentence.
      if (world.bombs.length || world.flames.size || world.suddenDeath) {
        const d = dangerMap(world);
        if (d[key(Math.floor(p.y), Math.floor(p.x))] !== Infinity) {
          this.blunder = 0;
          this.timer = 0;
        }
      }
    }
    if (this.blunder > 0 || this.timer > 0) {
      world.setInput(this.id, this.move[0], this.move[1]);
      return;
    }
    this.timer = this.level.interval;
    this._think(world, p);
    world.setInput(this.id, this.move[0], this.move[1]);
  };

  Bot.prototype._think = function (world, p) {
    const lv = this.level;
    const sr = Math.floor(p.y), sc = Math.floor(p.x);
    const danger = dangerMap(world);
    const speed = world.speedOf(p);

    // Occasionally just do something silly, so easier CPUs feel beatable — but
    // never while standing in a blast, and never *into* one, or "beatable"
    // turns into "suicidal".
    const here = danger[key(sr, sc)];
    if (here === Infinity && Math.random() < lv.mistake) {
      const d = STEP[(Math.random() * 4) | 0];
      const nr = sr + d[0], nc = sc + d[1];
      if (danger[key(nr, nc)] === Infinity) {
        this.move = [d[1], d[0]];
        this.blunder = lv.interval * 2;
        return;
      }
    }

    // 1. Standing somewhere that is about to explode? Get out.
    if (here !== Infinity) {
      if (this._flee(world, danger, sr, sc, speed)) return;
      // Cornered — at least stop walking deeper into the blast.
      this.move = [0, 0];
      return;
    }

    const field = safeField(world, sr, sc, danger);

    // 2. Worth dropping a bomb here? Only if an escape provably exists.
    if (this._shouldBomb(world, p, sr, sc, danger, speed)) {
      world.requestBomb(this.id);
      // Immediately plan the retreat so it doesn't linger on its own fuse.
      const after = withBomb(world, danger, sr, sc, p.fire);
      if (this._flee(world, after, sr, sc, speed)) return;
    }

    // 3. Nothing urgent — go get something (never routing through a blast).
    const goal = this._pickGoal(world, p, field, danger, sr, sc);
    if (goal !== null) {
      const step = firstStep(field, sr, sc, goal);
      if (step) { this.move = step; return; }
    }
    this.move = [0, 0];
  };

  /**
   * Walk toward the nearest genuinely-safe tile. Tries the difficulty's margin
   * first, then a desperate no-margin pass, so a bot only freezes when it is
   * truly trapped. Returns true if a retreat step was chosen.
   */
  Bot.prototype._flee = function (world, danger, sr, sc, speed) {
    const margins = [this.level.margin, 0];
    for (let i = 0; i < margins.length; i++) {
      const field = escapeField(world, sr, sc, danger, speed, margins[i]);
      const escape = this._findSafe(world, field, danger, sr, sc, speed);
      if (escape === null) continue;
      const step = firstStep(field, sr, sc, escape);
      if (step) { this.move = step; return true; }
    }
    return false;
  };

  /**
   * Nearest reachable tile that is outside every pending blast. "Not blowing up
   * for a while yet" is deliberately NOT good enough — otherwise a bot standing
   * on its own fresh bomb decides it is already safe and never moves.
   */
  Bot.prototype._findSafe = function (world, field, danger, sr, sc, speed) {
    let best = null, bestD = Infinity;
    for (let r = 1; r < H - 1; r++) {
      for (let c = 1; c < W - 1; c++) {
        const k = key(r, c);
        const d = field.dist[k];
        if (d <= 0) continue;
        if (danger[k] !== Infinity) continue;
        // Don't stop somewhere a flame is still burning through.
        if (world.flameAt(r, c) && d / speed < FLAME_SEC) continue;
        if (d < bestD) { bestD = d; best = k; }
      }
    }
    return best;
  };

  Bot.prototype._shouldBomb = function (world, p, sr, sc, danger, speed) {
    if (p.bombsOut >= p.bombs) return false;
    if (world.at(sr, sc) !== TILE.FLOOR || world.bombAt(sr, sc)) return false;

    // Would this bomb actually accomplish anything?
    let value = 0;
    for (let d = 0; d < STEP.length; d++) {
      for (let n = 1; n <= p.fire; n++) {
        const r = sr + STEP[d][0] * n, c = sc + STEP[d][1] * n;
        const t = world.at(r, c);
        if (t === TILE.HARD) break;
        if (t === TILE.SOFT) { value += 1; break; }
        const other = world.alivePlayers().find(function (q) {
          return q.id !== p.id && Math.floor(q.y) === r && Math.floor(q.x) === c;
        });
        if (other) value += 4;
      }
    }
    if (value <= 0) return false;
    if (value < 4 && Math.random() > 0.75 + this.level.aggression * 0.2) return false;

    // Prove an escape exists once the bomb is down.
    const after = withBomb(world, danger, sr, sc, p.fire);
    const field = escapeField(world, sr, sc, after, speed, this.level.margin);
    return this._findSafe(world, field, after, sr, sc, speed) !== null;
  };

  /** Prefer power-ups, then crates to open up, then hunt a rival. */
  Bot.prototype._pickGoal = function (world, p, field, danger, sr, sc) {
    let best = null, bestScore = -Infinity;

    function consider(r, c, weight) {
      const k = key(r, c);
      const d = field.dist[k];
      if (d < 0) return;
      if (danger[k] !== Infinity) return;
      const score = weight - d;
      if (score > bestScore) { bestScore = score; best = k; }
    }

    world.items.forEach(function (it) { consider(it.r, it.c, 26); });

    // Crates: stand next to one (you can't walk onto it).
    for (let r = 1; r < H - 1; r++) {
      for (let c = 1; c < W - 1; c++) {
        if (world.at(r, c) !== TILE.SOFT) continue;
        for (let d = 0; d < STEP.length; d++) {
          consider(r + STEP[d][0], c + STEP[d][1], 14);
        }
      }
    }

    // Hunt: walk toward the nearest rival once the arena has opened up.
    const hunt = this.level.hunt;
    const foes = world.alivePlayers();
    for (let i = 0; i < foes.length; i++) {
      const q = foes[i];
      if (q.id === p.id) continue;
      const qr = Math.floor(q.y), qc = Math.floor(q.x);
      const dd = Math.abs(qr - sr) + Math.abs(qc - sc);
      if (dd > hunt) continue;
      for (let d = 0; d < STEP.length; d++) {
        consider(qr + STEP[d][0], qc + STEP[d][1], 10 + this.level.aggression * 22);
      }
    }
    return best;
  };

  global.BombBrawlBot = {
    Bot: Bot,
    LEVELS: LEVELS,
    dangerMap: dangerMap,
    blastCells: blastCells,
    withBomb: withBomb,
    safeField: safeField,
    escapeField: escapeField,
  };
})(typeof window !== 'undefined' ? window : globalThis);
