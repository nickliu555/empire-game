'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Puck Ball — server-side lobby + match-meta state machine.
//
// Like Soccer Head, the live match (disc physics, ball, scoring) is simulated
// on the HOST browser so controller input travels player -> server -> host in a
// single relay hop. This module owns:
//   • the lobby: players (1v1 up to 4v4), team assignment, CPU bots
//     and the time limit
//   • a CACHE of match meta (scores, clock, paused) pushed by the host, so
//     reconnecting phones and a refreshed host land on the right screen
//
// The transport layer (./index.js) owns socket events + broadcasting.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINAL: 'FINAL',
};

const MAX_PER_TEAM = 4;
const CAPACITY = MAX_PER_TEAM * 2;

const MAX_NAME_LEN = 20;

const MIN_TIME_LIMIT_SEC = 60;
const MAX_TIME_LIMIT_SEC = 600;
const DEFAULT_TIME_LIMIT_SEC = 180;

const TEAMS = ['red', 'blue'];

// Pitch tier is chosen from the larger team's size, HaxBall style: bigger teams
// get a bigger stadium. Mirrors STADIUM_TIERS in public/puckball/js/engine.js.
const TIERS = ['small', 'classic', 'big', 'huge'];
function tierForTeamSize(n) {
  const i = Math.min(TIERS.length, Math.max(1, n | 0)) - 1;
  return TIERS[i];
}

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.timeLimitSec = DEFAULT_TIME_LIMIT_SEC;
    // Monotonic counter giving each player an `order` for stable, reorderable
    // seat ordering within a team.
    this._orderSeq = 0;
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.match = this._freshMatch();
  }

  _freshMatch() {
    return {
      redScore: 0,
      blueScore: 0,
      clockMs: this.timeLimitSec * 1000,
      live: false, // true only while controls are active (host:play)
      paused: false,
      winner: null, // 'red' | 'blue' | null (null = draw)
    };
  }

  capacity() { return CAPACITY; }
  perTeam() { return MAX_PER_TEAM; }

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

  teamCount(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
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
    if (this.players.size >= CAPACITY) {
      return { ok: false, reason: 'game-full' };
    }
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) {
      return { ok: false, reason: 'name-taken', name: clean };
    }
    const team = this.teamCount('red') <= this.teamCount('blue') ? 'red' : 'blue';
    const player = makePlayer(playerId, clean, socketId, team);
    player.order = this._orderSeq++;
    this.players.set(playerId, player);
    return { ok: true, player };
  }

  /**
   * Add a CPU player to fill a slot. Bots have no socket; the host drives their
   * inputs locally through the same input path as a phone.
   */
  addBot() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (this.players.size >= CAPACITY) return { ok: false, reason: 'game-full' };
    const team = this.teamCount('red') <= this.teamCount('blue') ? 'red' : 'blue';
    let n = 1;
    while (this.players.has('bot-' + n)) n++;
    let name = 'CPU';
    if (this.nameIsTaken(name)) { let k = 2; while (this.nameIsTaken('CPU ' + k)) k++; name = 'CPU ' + k; }
    const bot = makePlayer('bot-' + n, name, null, team);
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

  // ---------------- Lobby config ----------------

  setTimeLimit(sec) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    const v = Math.round(Number(sec));
    if (!Number.isFinite(v)) return { ok: false, reason: 'bad-time-limit' };
    this.timeLimitSec = Math.min(MAX_TIME_LIMIT_SEC, Math.max(MIN_TIME_LIMIT_SEC, v));
    this.match.clockMs = this.timeLimitSec * 1000;
    return { ok: true };
  }

  assignTeam(playerId, team, beforeId) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    if (!TEAMS.includes(team)) return { ok: false, reason: 'bad-team' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (p.team !== team && this.teamCount(team) >= MAX_PER_TEAM) {
      return { ok: false, reason: 'team-full' };
    }
    p.team = team;
    // Reorder within the target team: drop `p` just before `beforeId`, or at the
    // end if none/unknown, then renumber so seats stay stable.
    const inTeam = Array.from(this.players.values())
      .filter((q) => q.team === team && q.id !== playerId)
      .sort((a, b) => a.order - b.order);
    let idx = beforeId ? inTeam.findIndex((q) => q.id === beforeId) : -1;
    if (idx < 0) idx = inTeam.length;
    inTeam.splice(idx, 0, p);
    inTeam.forEach((q, i) => { q.order = i; });
    return { ok: true };
  }

  canStart() {
    if (this.phase !== PHASES.LOBBY) return false;
    const red = this.teamCount('red');
    const blue = this.teamCount('blue');
    return red >= 1 && blue >= 1 && red <= MAX_PER_TEAM && blue <= MAX_PER_TEAM;
  }

  /** Pitch size tier, from the larger side. */
  tier() {
    return tierForTeamSize(Math.max(this.teamCount('red'), this.teamCount('blue')));
  }

  // ---------------- Match lifecycle (meta only) ----------------

  getRoster() {
    const bySeat = { red: [], blue: [] };
    const sorted = Array.from(this.players.values()).sort((a, b) => a.order - b.order);
    for (const p of sorted) {
      const team = p.team === 'blue' ? 'blue' : 'red';
      bySeat[team].push(p);
    }
    const roster = [];
    for (const team of TEAMS) {
      bySeat[team].forEach((p, seat) => {
        roster.push({ id: p.id, name: p.name, team, seat, connected: p.connected, isBot: !!p.isBot });
      });
    }
    return roster;
  }

  startMatch() {
    if (!this.canStart()) return { ok: false, reason: 'cannot-start' };
    this.phase = PHASES.PLAYING;
    // Tier is locked in for the whole match — it must not change if a phone drops.
    this.lockedTier = this.tier();
    this.match = this._freshMatch();
    this.match.kickoffTeam = Math.random() < 0.5 ? 'red' : 'blue';
    return { ok: true, roster: this.getRoster(), tier: this.lockedTier, kickoffTeam: this.match.kickoffTeam };
  }

  setLive(live) { this.match.live = !!live; }
  setClock(ms) {
    if (Number.isFinite(ms)) this.match.clockMs = Math.max(0, Math.round(ms));
  }
  setScore(redScore, blueScore) {
    if (Number.isFinite(redScore)) this.match.redScore = redScore | 0;
    if (Number.isFinite(blueScore)) this.match.blueScore = blueScore | 0;
  }
  setPaused(on) { this.match.paused = !!on; }
  endMatch({ winner, redScore, blueScore } = {}) {
    this.phase = PHASES.FINAL;
    this.match.live = false;
    this.match.paused = false;
    if (Number.isFinite(redScore)) this.match.redScore = redScore | 0;
    if (Number.isFinite(blueScore)) this.match.blueScore = blueScore | 0;
    this.match.winner = winner === 'red' || winner === 'blue' ? winner : null;
  }

  reset(keepConfig) {
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this._orderSeq = 0;
    this.lockedTier = null;
    if (!keepConfig) {
      this.timeLimitSec = DEFAULT_TIME_LIMIT_SEC;
    }
    this.match = this._freshMatch();
  }

  // ---------------- Public payloads ----------------

  getLobby() {
    const red = [];
    const blue = [];
    const sorted = Array.from(this.players.values()).sort((a, b) => a.order - b.order);
    for (const p of sorted) {
      (p.team === 'blue' ? blue : red).push({ id: p.id, name: p.name, connected: p.connected, isBot: !!p.isBot });
    }
    return {
      phase: this.phase,
      capacity: CAPACITY,
      perTeam: MAX_PER_TEAM,
      timeLimitSec: this.timeLimitSec,
      tier: this.tier(),
      teams: { red, blue },
      total: this.players.size,
      canStart: this.canStart(),
    };
  }

  getMatchMeta() {
    return {
      timeLimitSec: this.timeLimitSec,
      tier: this.lockedTier || this.tier(),
      roster: this.getRoster(),
      redScore: this.match.redScore,
      blueScore: this.match.blueScore,
      clockMs: this.match.clockMs,
      paused: this.match.paused,
      live: this.match.live,
      winner: this.match.winner,
      kickoffTeam: this.match.kickoffTeam,
    };
  }
}

function makePlayer(id, name, socketId, team) {
  return {
    id,
    name,
    socketId,
    connected: true,
    joinedAt: Date.now(),
    order: 0,
    team: team === 'blue' ? 'blue' : 'red',
    isBot: false,
  };
}

module.exports = {
  Game,
  PHASES,
  TEAMS,
  TIERS,
  tierForTeamSize,
  CAPACITY,
  MAX_PER_TEAM,
  MIN_TIME_LIMIT_SEC,
  MAX_TIME_LIMIT_SEC,
  DEFAULT_TIME_LIMIT_SEC,
};
