'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Maze Chomp — server-side lobby + match-meta state machine.
//
// Like Soccer Head / Sling Soccer, the live game (maze, movement, ghost AI,
// scoring) runs on the HOST browser for the lowest possible input latency
// (player -> server -> host is a single relay hop). This module does NOT
// simulate the game. It owns:
//   • the lobby: 2–4 players (no teams), Add-CPU bots, rounds-to-win + round
//     length config.
//   • a CACHE of match meta (round, per-player round score, game points, who is
//     alive, clock, chosen maze, plus an optional board snapshot) that the host
//     pushes as rounds run, so reconnecting phones and a refreshed host can be
//     restored to the right screen.
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

const MIN_ROUND_SEC = 30;
const MAX_ROUND_SEC = 120;
const DEFAULT_ROUND_SEC = 60;

const MIN_ROUNDS_TO_WIN = 1;
const MAX_ROUNDS_TO_WIN = 7;
const DEFAULT_ROUNDS_TO_WIN = 3;

// Distinct chomper body colours assigned by seat. Chosen to read clearly
// against the four ghost colours (red / pink / cyan / orange).
const PLAYER_COLORS = ['#FFE100', '#3DDC84', '#A96BFF', '#34C6FF'];

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.roundLengthSec = DEFAULT_ROUND_SEC;
    this.roundsToWin = DEFAULT_ROUNDS_TO_WIN;
    this._orderSeq = 0;
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.match = this._freshMatch();
  }

  _freshMatch() {
    return {
      round: 1,
      mazeIndex: 0,
      clockMs: this.roundLengthSec * 1000,
      live: false,        // true only while controls are active (host:play)
      paused: false,      // true while the host has the game paused
      scores: {},         // playerId -> current-round score
      gamePoints: {},     // playerId -> rounds won so far
      alive: {},          // playerId -> bool (alive this round)
      winnerIds: [],       // final: id(s) that reached roundsToWin
      awards: [],          // final: computed award cards (host-pushed)
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
  * Add a CPU/bot chomper to fill an open slot. The bot has no socket; the host
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
   * corner, so this lets the host arrange the roster before starting.
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

  canStart() {
    if (this.phase !== PHASES.LOBBY) return false;
    return this.players.size >= MIN_PLAYERS && this.players.size <= MAX_PLAYERS;
  }

  // ---------------- Match lifecycle (meta only) ----------------

  /**
   * Ordered roster the host uses to spawn chompers. Ordered by join time so a
   * player keeps the same seat/colour/corner across reconnects.
   */
  getRoster() {
    const sorted = Array.from(this.players.values()).sort((a, b) => a.order - b.order);
    return sorted.map((p, seat) => ({
      id: p.id,
      name: p.name,
      seat,
      color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
      connected: p.connected,
      isBot: !!p.isBot,
    }));
  }

  startMatch() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    this.phase = PHASES.PLAYING;
    this.match = this._freshMatch();
    const roster = this.getRoster();
    for (const r of roster) {
      this.match.scores[r.id] = 0;
      this.match.gamePoints[r.id] = 0;
      this.match.alive[r.id] = true;
    }
    return { ok: true, roster };
  }

  // Host pushes live meta as rounds run. These keep the cache fresh.
  setLive(live) { this.match.live = !!live; }
  setPaused(on) { this.match.paused = !!on; }
  setRound(round, mazeIndex) {
    if (Number.isFinite(round)) this.match.round = round | 0;
    if (Number.isFinite(mazeIndex)) this.match.mazeIndex = mazeIndex | 0;
  }
  setClock(ms) {
    if (Number.isFinite(ms)) this.match.clockMs = Math.max(0, Math.round(ms));
  }
  setScores(scores) {
    if (scores && typeof scores === 'object') {
      for (const id of Object.keys(scores)) {
        if (this.players.has(id) && Number.isFinite(scores[id])) this.match.scores[id] = scores[id] | 0;
      }
    }
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
  setBoard(board) { this.match.board = board || null; }

  endMatch({ winnerIds, gamePoints, awards } = {}) {
    this.phase = PHASES.FINAL;
    this.match.live = false;
    if (gamePoints) this.setGamePoints(gamePoints);
    this.match.winnerIds = Array.isArray(winnerIds) ? winnerIds.filter((id) => this.players.has(id)) : [];
    this.match.awards = Array.isArray(awards) ? awards : [];
  }

  reset(keepConfig) {
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this._orderSeq = 0;
    if (!keepConfig) {
      this.roundLengthSec = DEFAULT_ROUND_SEC;
      this.roundsToWin = DEFAULT_ROUNDS_TO_WIN;
    }
    this.match = this._freshMatch();
  }

  // ---------------- Public payloads ----------------

  getLobby() {
    const sorted = Array.from(this.players.values()).sort((a, b) => a.order - b.order);
    const players = sorted.map((p, seat) => ({
      id: p.id,
      name: p.name,
      seat,
      color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
      connected: p.connected,
      isBot: !!p.isBot,
    }));
    return {
      phase: this.phase,
      capacity: this.capacity(),
      minPlayers: MIN_PLAYERS,
      roundLengthSec: this.roundLengthSec,
      roundsToWin: this.roundsToWin,
      players,
      total: this.players.size,
      canStart: this.canStart(),
    };
  }

  getMatchMeta() {
    return {
      roundLengthSec: this.roundLengthSec,
      roundsToWin: this.roundsToWin,
      roster: this.getRoster(),
      round: this.match.round,
      mazeIndex: this.match.mazeIndex,
      clockMs: this.match.clockMs,
      live: this.match.live,
      paused: this.match.paused,
      scores: this.match.scores,
      gamePoints: this.match.gamePoints,
      alive: this.match.alive,
      winnerIds: this.match.winnerIds,
      awards: this.match.awards,
      board: this.match.board,
    };
  }
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
  PLAYER_COLORS,
};
