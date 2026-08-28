'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Bomb Brawl — server-side lobby + match-meta state machine.
//
// Like Maze Chomp / Soccer Head, the live game (arena, movement, bombs,
// flames, power-ups, sudden death, CPU AI) runs on the HOST browser for the
// lowest possible input latency (player -> server -> host is a single relay
// hop). This module does NOT simulate the game. It owns:
//   • the lobby: 2–4 players (no teams), Add-CPU bots, and the four config
//     knobs (rounds to win, round length, power-ups on/off, CPU difficulty).
//   • a CACHE of match meta (round, game points, who is alive, clock, arena
//     seed, per-player power stats, plus an optional board snapshot) that the
//     host pushes as rounds run, so reconnecting phones and a refreshed host
//     can be restored to the right screen.
//
// Seat order is meaningful: seat 0 = top-left, 1 = top-right, 2 = bottom-left,
// 3 = bottom-right. The host can drag-reorder the roster in the lobby to
// choose who spawns where; the order locks when the match starts.
//
// The transport layer (./index.js) owns socket events + broadcasting.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

const MAX_NAME_LEN = 20;

const MIN_ROUND_SEC = 60;
const MAX_ROUND_SEC = 180;
const DEFAULT_ROUND_SEC = 120;

const MIN_ROUNDS_TO_WIN = 1;
const MAX_ROUNDS_TO_WIN = 7;
const DEFAULT_ROUNDS_TO_WIN = 3;

const BOT_DIFFICULTIES = ['easy', 'normal', 'hard'];
const DEFAULT_BOT_DIFFICULTY = 'normal';

// Bomber colours assigned by seat. Seat index also picks the spawn corner, so
// a colour always means the same corner: red = top-left, blue = top-right,
// green = bottom-left, yellow = bottom-right.
const PLAYER_COLORS = ['#FF4D4D', '#3DA5FF', '#3DDC84', '#FFD23F'];
const CORNER_NAMES = ['Top-left', 'Top-right', 'Bottom-left', 'Bottom-right'];

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.roundLengthSec = DEFAULT_ROUND_SEC;
    this.roundsToWin = DEFAULT_ROUNDS_TO_WIN;
    this.powerUps = true;
    this.botDifficulty = DEFAULT_BOT_DIFFICULTY;
    this._orderSeq = 0;
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.match = this._freshMatch();
  }

  _freshMatch() {
    return {
      round: 1,
      seed: 0,            // arena seed for the current round (host-generated)
      clockMs: this.roundLengthSec * 1000,
      live: false,        // true only while controls are active (host:play)
      paused: false,      // true while the host has the game paused
      suddenDeath: false, // true once the closing walls have started
      gamePoints: {},     // playerId -> rounds won so far
      alive: {},          // playerId -> bool (alive this round)
      hud: {},            // playerId -> { bombs, fire, speed, kick }
      winnerIds: [],      // final: id(s) that reached roundsToWin
      board: null,        // optional host-pushed snapshot for host-refresh
    };
  }

  capacity() { return MAX_PLAYERS; }

  // ---------------- Names / players ----------------

  sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    let n = raw.replace(/[^\p{L}\p{N} '._-]/gu, '').trim().replace(/\s+/g, ' ');
    if (n.length > MAX_NAME_LEN) n = n.slice(0, MAX_NAME_LEN);
    return n;
  }

  nameIsTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  addPlayer({ playerId, name, socketId }) {
    if (!playerId || typeof playerId !== 'string') {
      return { ok: false, reason: 'bad-player-id' };
    }
    if (this.players.has(playerId)) {
      return this.reconnectPlayer({ playerId, socketId });
    }
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, reason: 'round-in-progress' };
    }
    if (this.players.size >= this.capacity()) {
      return { ok: false, reason: 'game-full' };
    }
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) {
      return { ok: false, reason: 'name-taken', name: clean };
    }
    const player = makePlayer(playerId, clean, socketId);
    player.order = this._orderSeq++;
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  /**
   * Add a CPU/bot bomber to fill an open slot. The bot has no socket; the host
   * drives its inputs locally during a round. Lets 1 human play a real match.
   */
  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size >= this.capacity()) return { ok: false, reason: 'game-full' };
    let n = 1;
    while (this.players.has('bot-' + n)) n++;
    let name = 'CPU';
    if (this.nameIsTaken(name)) { let k = 2; while (this.nameIsTaken('CPU ' + k)) k++; name = 'CPU ' + k; }
    const bot = makePlayer('bot-' + n, name, null);
    bot.isBot = true;
    bot.order = this._orderSeq++;
    this.players.set(bot.id, bot);
    return { ok: true, player: bot };
  }

  reconnectPlayer({ playerId, socketId }) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    p.socketId = socketId;
    p.connected = true;
    return { ok: true, player: p };
  }

  markDisconnected(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) {
        p.connected = false;
        return p;
      }
    }
    return null;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  /**
   * Reorder a player to sit just before `beforeId` (or at the end if null/
   * unknown), renumbering everyone's `order`. Order = seat = colour = spawn
   * corner, so this is how the host chooses who starts in which corner.
   */
  reorderPlayer(playerId, beforeId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    const list = Array.from(this.players.values())
      .filter((q) => q.id !== playerId)
      .sort((a, b) => a.order - b.order);
    let idx = beforeId ? list.findIndex((q) => q.id === beforeId) : -1;
    if (idx < 0) idx = list.length;
    list.splice(idx, 0, p);
    list.forEach((q, i) => { q.order = i; });
    return { ok: true };
  }

  // ---------------- Lobby config ----------------

  setRoundLength(sec) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const n = Math.round(Number(sec));
    if (!Number.isFinite(n)) return { ok: false, reason: 'bad-duration' };
    this.roundLengthSec = Math.min(MAX_ROUND_SEC, Math.max(MIN_ROUND_SEC, n));
    this.match.clockMs = this.roundLengthSec * 1000;
    return { ok: true };
  }

  setRoundsToWin(n) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return { ok: false, reason: 'bad-rounds' };
    this.roundsToWin = Math.min(MAX_ROUNDS_TO_WIN, Math.max(MIN_ROUNDS_TO_WIN, v));
    return { ok: true };
  }

  setPowerUps(on) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    this.powerUps = !!on;
    return { ok: true };
  }

  setBotDifficulty(level) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (BOT_DIFFICULTIES.indexOf(level) < 0) return { ok: false, reason: 'bad-difficulty' };
    this.botDifficulty = level;
    return { ok: true };
  }

  canStart() {
    if (this.phase !== PHASES.LOBBY) return false;
    return this.players.size >= MIN_PLAYERS && this.players.size <= MAX_PLAYERS;
  }

  // ---------------- Match lifecycle (meta only) ----------------

  /**
   * Ordered roster the host uses to spawn bombers. `seat` is the spawn corner
   * index (0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right) and
   * also picks the bomber colour, so a player keeps the same corner + colour
   * across reconnects and across every round of the match.
   */
  getRoster() {
    const sorted = Array.from(this.players.values()).sort((a, b) => a.order - b.order);
    return sorted.map((p, seat) => publicPlayer(p, seat));
  }

  startMatch() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    this.phase = PHASES.PLAYING;
    this.match = this._freshMatch();
    const roster = this.getRoster();
    for (const r of roster) {
      this.match.gamePoints[r.id] = 0;
      this.match.alive[r.id] = true;
      this.match.hud[r.id] = { bombs: 1, fire: 1, speed: 0, kick: false };
    }
    return { ok: true, roster };
  }

  // Host pushes live meta as rounds run. These keep the cache fresh.
  setLive(live) { this.match.live = !!live; }
  setPaused(on) { this.match.paused = !!on; }
  setSuddenDeath(on) { this.match.suddenDeath = !!on; }
  setRound(round, seed) {
    if (Number.isFinite(round)) this.match.round = round | 0;
    if (Number.isFinite(seed)) this.match.seed = seed >>> 0;
  }
  setClock(ms) {
    if (Number.isFinite(ms)) this.match.clockMs = Math.max(0, Math.round(ms));
  }
  setGamePoints(gp) {
    if (gp && typeof gp === 'object') {
      for (const id of Object.keys(gp)) {
        if (this.players.has(id) && Number.isFinite(gp[id])) this.match.gamePoints[id] = gp[id] | 0;
      }
    }
  }
  setAlive(alive) {
    if (alive && typeof alive === 'object') {
      for (const id of Object.keys(alive)) {
        if (this.players.has(id)) this.match.alive[id] = !!alive[id];
      }
    }
  }
  setHud(id, hud) {
    if (!this.players.has(id) || !hud || typeof hud !== 'object') return null;
    const clean = {
      bombs: clampInt(hud.bombs, 0, 99, 1),
      fire: clampInt(hud.fire, 1, 99, 1),
      speed: clampInt(hud.speed, 0, 9, 0),
      kick: !!hud.kick,
      out: clampInt(hud.out, 0, 99, 0),
    };
    this.match.hud[id] = clean;
    return clean;
  }
  setBoard(board) { this.match.board = board || null; }

  endMatch({ winnerIds, gamePoints } = {}) {
    this.phase = PHASES.FINAL;
    this.match.live = false;
    this.match.suddenDeath = false;
    if (gamePoints) this.setGamePoints(gamePoints);
    this.match.winnerIds = Array.isArray(winnerIds) ? winnerIds.filter((id) => this.players.has(id)) : [];
  }

  reset(keepConfig) {
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this._orderSeq = 0;
    if (!keepConfig) {
      this.roundLengthSec = DEFAULT_ROUND_SEC;
      this.roundsToWin = DEFAULT_ROUNDS_TO_WIN;
      this.powerUps = true;
      this.botDifficulty = DEFAULT_BOT_DIFFICULTY;
    }
    this.match = this._freshMatch();
  }

  // ---------------- Public payloads ----------------

  getConfig() {
    return {
      roundLengthSec: this.roundLengthSec,
      roundsToWin: this.roundsToWin,
      powerUps: this.powerUps,
      botDifficulty: this.botDifficulty,
    };
  }

  getLobby() {
    return Object.assign(this.getConfig(), {
      phase: this.phase,
      capacity: this.capacity(),
      minPlayers: MIN_PLAYERS,
      players: this.getRoster(),
      total: this.players.size,
      canStart: this.canStart(),
    });
  }

  getMatchMeta() {
    return Object.assign(this.getConfig(), {
      roster: this.getRoster(),
      round: this.match.round,
      seed: this.match.seed,
      clockMs: this.match.clockMs,
      live: this.match.live,
      paused: this.match.paused,
      suddenDeath: this.match.suddenDeath,
      gamePoints: this.match.gamePoints,
      alive: this.match.alive,
      hud: this.match.hud,
      winnerIds: this.match.winnerIds,
      board: this.match.board,
    });
  }
}

function publicPlayer(p, seat) {
  return {
    id: p.id,
    name: p.name,
    seat,
    color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
    corner: CORNER_NAMES[seat % CORNER_NAMES.length],
    connected: p.connected,
    isBot: !!p.isBot,
  };
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function makePlayer(id, name, socketId) {
  return {
    id,
    name,
    socketId,
    connected: true,
    joinedAt: Date.now(),
    order: 0,
    isBot: false,
  };
}

module.exports = {
  Game,
  PHASES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MIN_ROUND_SEC,
  MAX_ROUND_SEC,
  DEFAULT_ROUND_SEC,
  MIN_ROUNDS_TO_WIN,
  MAX_ROUNDS_TO_WIN,
  DEFAULT_ROUNDS_TO_WIN,
  BOT_DIFFICULTIES,
  DEFAULT_BOT_DIFFICULTY,
  PLAYER_COLORS,
  CORNER_NAMES,
};
