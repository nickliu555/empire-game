'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Camo — single-room game state machine.
//
// Flow: LOBBY → INTRO → ROLE → CLUES → DISCUSS → VOTE → (GUESS) → REVEAL
//       → (loop) → FINAL
//
//   ROLE    : everyone privately sees the secret word — except the Chameleon,
//             whose phone only says they ARE the Chameleon.
//   CLUES   : one pass around a shuffled speaking order; each player says a
//             single word OUT LOUD, then taps Done.
//   DISCUSS : untimed, host-advanced.
//   VOTE    : everyone accuses someone else. Ends when all connected players
//             have voted, or when the host closes it.
//   GUESS   : only reached when the Chameleon is the SOLE top vote — they get
//             one shot at the secret word to escape anyway.
//   REVEAL  : identity, guess outcome and scores.
//
// SECRECY INVARIANT: `secretIndex` / `chameleonId` must never appear in a
// payload built for broadcast before GUESS/REVEAL. getRolePrivate() is the one
// and only accessor that can hand out the secret word, and the transport layer
// must send it to a single socket.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  INTRO: 'INTRO',
  ROLE: 'ROLE',
  CLUES: 'CLUES',
  DISCUSS: 'DISCUSS',
  VOTE: 'VOTE',
  GUESS: 'GUESS',
  REVEAL: 'REVEAL',
  FINAL: 'FINAL',
};

const MAX_NAME_LEN = 20;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const INTRO_DURATION_MS = 4000;
const INTRO_GO_HOLD_MS = 1100;
const ROLE_MAX_MS = 20 * 1000;
const REVEAL_AUTO_ADVANCE_MS = 12 * 1000;
const DEFAULT_TARGET = 5;

// Scoring
const POINTS_ESCAPE_VOTE = 2;   // Chameleon dodged the vote
const POINTS_ESCAPE_GUESS = 1;  // caught, but guessed the secret word
const POINTS_CATCH = 1;         // per player who voted for a Chameleon that failed

const { buildQueue, GRID_SIZE } = require('./topics');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    /** @type {Map<string, any>} */
    this.players = new Map();

    this.targetScore = DEFAULT_TARGET;
    this.autoAdvanceMs = 0;

    this.queue = [];
    this.roundIndex = 0;

    // Per-round state
    this.currentTopic = null;
    this.secretIndex = -1;
    this.chameleonId = null;
    this.order = [];
    this.turnIndex = 0;
    this.tally = [];
    this.accusedId = null;
    this.caught = false;
    this.caughtOnTie = false;
    this.guessIndex = -1;
    this.guessCorrect = false;
    this.lastRoundResult = null;

    // Spreads the Chameleon role evenly instead of drawing fresh each round.
    this.chameleonBag = [];
    this.lastChameleonId = null;

    this.winnerId = null;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
    this.revealEndsAt = 0;

    this._introTimer = null;
    this._roleTimer = null;
    this._revealTimer = null;

    this.onIntroEnd = null;
    this.onRoleEnd = null;
    this.onRevealEnd = null;
  }

  // ---------------- Lobby / players ----------------

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
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'lobby-closed' };
    if (!playerId || typeof playerId !== 'string') return { ok: false, reason: 'bad-player-id' };
    if (this.players.has(playerId)) return this.reconnectPlayer({ playerId, socketId });
    if (this.players.size >= MAX_PLAYERS) return { ok: false, reason: 'game-full', max: MAX_PLAYERS };
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) return { ok: false, reason: 'name-taken', name: clean };
    const player = {
      id: playerId,
      name: clean,
      socketId,
      score: 0,
      roleAckRound: -1,
      votedRound: -1,
      votedFor: null,
      joinedAt: Date.now(),
      connected: true,
    };
    this.players.set(playerId, player);
    return { ok: true, player };
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
      if (p.socketId === socketId) { p.connected = false; return p; }
    }
    return null;
  }

  // Kick is lobby-only: the speaking order and Chameleon draw are built from
  // the roster, so removing a player mid-round would corrupt the round.
  removePlayer(playerId) {
    if (this.phase !== PHASES.LOBBY) return null;
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  // Progress is measured against everyone who started the round, not just who
  // happens to be connected — a phone dropping off must not shrink the totals.
  rosterCount() {
    return this.players.size;
  }

  // ---------------- Round setup ----------------

  _drawTopic() {
    if (!this.queue.length) this.queue = buildQueue();
    return this.queue.shift();
  }

  _pickChameleon() {
    const roster = Array.from(this.players.values());
    if (!roster.length) return null;
    const pool = roster.map((p) => p.id);
    const poolSet = new Set(pool);
    this.chameleonBag = this.chameleonBag.filter((id) => poolSet.has(id));
    if (!this.chameleonBag.length) {
      this.chameleonBag = shuffle(pool);
      // Avoid the same player being Chameleon twice across a bag refill.
      if (pool.length > 1 && this.chameleonBag[0] === this.lastChameleonId) {
        this.chameleonBag.push(this.chameleonBag.shift());
      }
    }
    const id = this.chameleonBag.shift();
    this.lastChameleonId = id;
    return id;
  }

  // ---------------- Progression ----------------

  start({ targetScore, autoAdvance } = {}) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'already-started' };
    if (this.players.size < MIN_PLAYERS) return { ok: false, reason: 'not-enough-players', min: MIN_PLAYERS };
    const target = parseInt(targetScore, 10);
    this.targetScore = (target >= 1 && target <= 20) ? target : DEFAULT_TARGET;
    this.autoAdvanceMs = autoAdvance ? REVEAL_AUTO_ADVANCE_MS : 0;
    this.queue = buildQueue();
    this.roundIndex = 0;
    this.winnerId = null;
    this.chameleonBag = [];
    this.lastChameleonId = null;
    for (const p of this.players.values()) {
      p.score = 0;
      p.roleAckRound = -1;
      p.votedRound = -1;
      p.votedFor = null;
    }
    return this._enterIntro();
  }

  _clearTimers() {
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    if (this._roleTimer) { clearTimeout(this._roleTimer); this._roleTimer = null; }
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
  }

  _enterIntro() {
    this._clearTimers();
    this.phase = PHASES.INTRO;
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + INTRO_DURATION_MS;
    this._introTimer = setTimeout(() => {
      this._introTimer = null;
      this._endIntro();
    }, INTRO_DURATION_MS + INTRO_GO_HOLD_MS);
    return { ok: true, phase: PHASES.INTRO };
  }

  _endIntro() {
    if (this.phase !== PHASES.INTRO) return;
    this._clearTimers();
    this._enterRole();
    if (typeof this.onIntroEnd === 'function') { try { this.onIntroEnd(); } catch (_) {} }
  }

  _enterRole() {
    this._clearTimers();
    this.phase = PHASES.ROLE;
    this.roundIndex += 1;
    this.currentTopic = this._drawTopic();
    this.secretIndex = Math.floor(Math.random() * GRID_SIZE);
    this.chameleonId = this._pickChameleon();
    this.order = shuffle(Array.from(this.players.keys()));
    this.turnIndex = 0;
    this.tally = [];
    this.accusedId = null;
    this.caught = false;
    this.caughtOnTie = false;
    this.guessIndex = -1;
    this.guessCorrect = false;
    this.lastRoundResult = null;
    for (const p of this.players.values()) {
      p.roleAckRound = -1;
      p.votedRound = -1;
      p.votedFor = null;
    }
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + ROLE_MAX_MS;
    this._roleTimer = setTimeout(() => {
      this._roleTimer = null;
      this._endRole();
    }, ROLE_MAX_MS);
    return { ok: true, phase: PHASES.ROLE };
  }

  ackRole({ playerId }) {
    if (this.phase !== PHASES.ROLE) return { ok: false, reason: 'not-role-phase' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    p.roleAckRound = this.roundIndex;
    const acked = this.roleAckedCount();
    const total = this.rosterCount();
    if (total > 0 && acked >= total) {
      this._endRole();
      return { ok: true, acked, total, advanced: true };
    }
    return { ok: true, acked, total, advanced: false };
  }

  roleAckedCount() {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.roleAckRound === this.roundIndex) n++;
    }
    return n;
  }

  _endRole() {
    if (this.phase !== PHASES.ROLE) return;
    this._clearTimers();
    this.phase = PHASES.CLUES;
    if (typeof this.onRoleEnd === 'function') { try { this.onRoleEnd(); } catch (_) {} }
  }

  // ---------------- Clues ----------------

  currentSpeakerId() {
    if (this.phase !== PHASES.CLUES) return null;
    return this.order[this.turnIndex] || null;
  }

  clueDone({ playerId }) {
    if (this.phase !== PHASES.CLUES) return { ok: false, reason: 'not-clue-phase' };
    if (!playerId || playerId !== this.currentSpeakerId()) return { ok: false, reason: 'not-your-turn' };
    return this._advanceTurn();
  }

  skipTurn() {
    if (this.phase !== PHASES.CLUES) return { ok: false, reason: 'not-clue-phase' };
    return this._advanceTurn();
  }

  _advanceTurn() {
    this.turnIndex += 1;
    if (this.turnIndex >= this.order.length) {
      this.phase = PHASES.DISCUSS;
      return { ok: true, phase: PHASES.DISCUSS };
    }
    return { ok: true, phase: PHASES.CLUES, turnIndex: this.turnIndex };
  }

  // ---------------- Vote ----------------

  startVote() {
    if (this.phase !== PHASES.DISCUSS) return { ok: false, reason: 'not-discuss-phase' };
    this.phase = PHASES.VOTE;
    for (const p of this.players.values()) {
      p.votedRound = -1;
      p.votedFor = null;
    }
    return { ok: true, phase: PHASES.VOTE };
  }

  castVote({ playerId, targetId }) {
    if (this.phase !== PHASES.VOTE) return { ok: false, reason: 'not-vote-phase' };
    const voter = this.players.get(playerId);
    if (!voter) return { ok: false, reason: 'unknown-player' };
    if (!targetId || targetId === playerId) return { ok: false, reason: 'no-self-vote' };
    const target = this.players.get(targetId);
    if (!target) return { ok: false, reason: 'unknown-target' };
    voter.votedFor = targetId;
    voter.votedRound = this.roundIndex;
    const voted = this.votedCount();
    const total = this.rosterCount();
    if (total > 0 && voted >= total) {
      const res = this._closeVote();
      return { ok: true, voted, total, targetId, closed: true, phase: res.phase };
    }
    return { ok: true, voted, total, targetId, closed: false };
  }

  votedCount() {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.votedRound === this.roundIndex) n++;
    }
    return n;
  }

  closeVote() {
    if (this.phase !== PHASES.VOTE) return { ok: false, reason: 'not-vote-phase' };
    return this._closeVote();
  }

  _closeVote() {
    const counts = new Map();
    const voters = new Map();
    for (const p of this.players.values()) {
      if (p.votedRound !== this.roundIndex || !p.votedFor) continue;
      counts.set(p.votedFor, (counts.get(p.votedFor) || 0) + 1);
      if (!voters.has(p.votedFor)) voters.set(p.votedFor, []);
      voters.get(p.votedFor).push(p.id);
    }
    this.tally = Array.from(this.players.values())
      .map((p) => ({
        id: p.id,
        name: p.name,
        votes: counts.get(p.id) || 0,
        voters: (voters.get(p.id) || []).map((id) => this._nameOf(id)).filter(Boolean),
      }))
      .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    let max = 0;
    for (const row of this.tally) if (row.votes > max) max = row.votes;
    const tops = this.tally.filter((row) => row.votes === max && max > 0);
    // A tie the Chameleon shares still counts as cornered — the room got there.
    const chamTied = tops.length > 1 && tops.some((row) => row.id === this.chameleonId);
    this.accusedId = tops.length === 1 ? tops[0].id : (chamTied ? this.chameleonId : null);
    this.caught = !!this.accusedId && this.accusedId === this.chameleonId;
    this.caughtOnTie = this.caught && chamTied;

    // Caught → the Chameleon gets one shot at the word. Otherwise they escape.
    if (this.caught) {
      this.phase = PHASES.GUESS;
      return { ok: true, phase: PHASES.GUESS };
    }
    return this._scoreRound(-1);
  }

  // ---------------- Guess + scoring ----------------

  submitGuess({ playerId, wordIndex }) {
    if (this.phase !== PHASES.GUESS) return { ok: false, reason: 'not-guess-phase' };
    if (!playerId || playerId !== this.chameleonId) return { ok: false, reason: 'not-chameleon' };
    const idx = parseInt(wordIndex, 10);
    if (!(idx >= 0 && idx < GRID_SIZE)) return { ok: false, reason: 'bad-index' };
    return this._scoreRound(idx);
  }

  skipGuess() {
    if (this.phase !== PHASES.GUESS) return { ok: false, reason: 'not-guess-phase' };
    return this._scoreRound(-1);
  }

  _scoreRound(guessIndex) {
    const cham = this.chameleonId ? this.players.get(this.chameleonId) : null;
    this.guessIndex = typeof guessIndex === 'number' ? guessIndex : -1;
    this.guessCorrect = this.caught && this.guessIndex === this.secretIndex;

    const scorers = [];
    let outcome;
    if (!this.caught) {
      outcome = 'escaped-vote';
      if (cham) { cham.score += POINTS_ESCAPE_VOTE; scorers.push({ playerId: cham.id, points: POINTS_ESCAPE_VOTE }); }
    } else if (this.guessCorrect) {
      outcome = 'escaped-guess';
      if (cham) { cham.score += POINTS_ESCAPE_GUESS; scorers.push({ playerId: cham.id, points: POINTS_ESCAPE_GUESS }); }
    } else {
      outcome = 'caught';
      for (const p of this.players.values()) {
        if (p.votedRound === this.roundIndex && p.votedFor === this.chameleonId) {
          p.score += POINTS_CATCH;
          scorers.push({ playerId: p.id, points: POINTS_CATCH });
        }
      }
    }

    this.winnerId = this._computeWinner();

    this.lastRoundResult = {
      roundIndex: this.roundIndex,
      outcome,
      topic: this.currentTopic ? this.currentTopic.topic : '',
      words: this.currentTopic ? this.currentTopic.words : [],
      secretIndex: this.secretIndex,
      secretWord: this._secretWord(),
      chameleonId: this.chameleonId,
      chameleonName: this._nameOf(this.chameleonId),
      accusedId: this.accusedId,
      accusedName: this._nameOf(this.accusedId),
      caught: this.caught,
      caughtOnTie: this.caughtOnTie,
      guessIndex: this.guessIndex,
      guessWord: this._wordAt(this.guessIndex),
      guessCorrect: this.guessCorrect,
      tally: this.tally,
      scorers,
      winnerId: this.winnerId,
    };

    this.phase = PHASES.REVEAL;
    this._clearTimers();
    if (this.autoAdvanceMs > 0 && !this.winnerId) {
      this.revealEndsAt = Date.now() + this.autoAdvanceMs;
      this._revealTimer = setTimeout(() => {
        this._revealTimer = null;
        this.revealEndsAt = 0;
        if (typeof this.onRevealEnd === 'function') { try { this.onRevealEnd(); } catch (_) {} }
      }, this.autoAdvanceMs);
    } else {
      this.revealEndsAt = 0;
    }
    return { ok: true, phase: PHASES.REVEAL };
  }

  _computeWinner() {
    const players = Array.from(this.players.values());
    if (!players.length) return null;
    let maxScore = -Infinity;
    for (const p of players) if (p.score > maxScore) maxScore = p.score;
    if (maxScore < this.targetScore) return null;
    const leaders = players.filter((p) => p.score === maxScore);
    if (leaders.length !== 1) return null; // tie → nobody wins yet
    return leaders[0].id;
  }

  advanceReveal() {
    if (this.phase !== PHASES.REVEAL) return { ok: false, reason: 'not-reveal' };
    this._clearTimers();
    this.revealEndsAt = 0;
    if (this.winnerId) {
      this.phase = PHASES.FINAL;
      return { ok: true, phase: PHASES.FINAL };
    }
    this._enterRole();
    return { ok: true, phase: PHASES.ROLE };
  }

  // Generic host "Next" dispatcher — each host view's button maps onto it.
  advance() {
    if (this.phase === PHASES.INTRO) { this._endIntro(); return { ok: true, phase: PHASES.ROLE }; }
    if (this.phase === PHASES.ROLE) { this._endRole(); return { ok: true, phase: PHASES.CLUES }; }
    if (this.phase === PHASES.CLUES) return this.skipTurn();
    if (this.phase === PHASES.DISCUSS) return this.startVote();
    if (this.phase === PHASES.VOTE) return this.closeVote();
    if (this.phase === PHASES.GUESS) return this.skipGuess();
    if (this.phase === PHASES.REVEAL) return this.advanceReveal();
    return { ok: false, reason: 'cannot-advance' };
  }

  // ---------------- Views / serialization ----------------

  _nameOf(pid) {
    if (!pid) return null;
    const p = this.players.get(pid);
    return p ? p.name : null;
  }

  _wordAt(idx) {
    if (!this.currentTopic || !(idx >= 0)) return null;
    return this.currentTopic.words[idx] || null;
  }

  _secretWord() {
    return this._wordAt(this.secretIndex);
  }

  // The grid itself is public all game — only WHICH word is secret is hidden.
  getGridPublic() {
    return {
      topic: this.currentTopic ? this.currentTopic.topic : '',
      words: this.currentTopic ? this.currentTopic.words.slice() : [],
    };
  }

  getLobbyPlayers() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id, name: p.name, connected: p.connected,
    }));
  }

  getIntroPublic() {
    return {
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      durationMs: INTRO_DURATION_MS,
      target: this.targetScore,
    };
  }

  getRolePublic() {
    return {
      round: this.roundIndex,
      grid: this.getGridPublic(),
      acked: this.roleAckedCount(),
      total: this.rosterCount(),
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      target: this.targetScore,
    };
  }

  getCluesPublic() {
    const currentId = this.currentSpeakerId();
    return {
      round: this.roundIndex,
      grid: this.getGridPublic(),
      order: this.order.map((id) => {
        const p = this.players.get(id);
        return { id, name: p ? p.name : '?', connected: p ? p.connected : false };
      }),
      turnIndex: this.turnIndex,
      currentId,
      currentName: this._nameOf(currentId),
      target: this.targetScore,
    };
  }

  getDiscussPublic() {
    return {
      round: this.roundIndex,
      grid: this.getGridPublic(),
      order: this.order.map((id) => {
        const p = this.players.get(id);
        return { id, name: p ? p.name : '?', connected: p ? p.connected : false };
      }),
      target: this.targetScore,
    };
  }

  getVotePublic() {
    return {
      round: this.roundIndex,
      grid: this.getGridPublic(),
      players: this.getLobbyPlayers(),
      voted: this.votedCount(),
      total: this.rosterCount(),
      target: this.targetScore,
    };
  }

  // Entering GUESS already tells the room who the Chameleon is, so the
  // identity is public from here on.
  getGuessPublic() {
    return {
      round: this.roundIndex,
      grid: this.getGridPublic(),
      tally: this.tally,
      accusedId: this.accusedId,
      accusedName: this._nameOf(this.accusedId),
      caughtOnTie: this.caughtOnTie,
      chameleonId: this.chameleonId,
      chameleonName: this._nameOf(this.chameleonId),
      target: this.targetScore,
    };
  }

  getRevealPublic() {
    const r = this.lastRoundResult;
    return {
      round: this.roundIndex,
      grid: this.getGridPublic(),
      outcome: r ? r.outcome : null,
      secretIndex: r ? r.secretIndex : this.secretIndex,
      secretWord: r ? r.secretWord : this._secretWord(),
      chameleonId: r ? r.chameleonId : this.chameleonId,
      chameleonName: r ? r.chameleonName : this._nameOf(this.chameleonId),
      accusedId: r ? r.accusedId : this.accusedId,
      accusedName: r ? r.accusedName : this._nameOf(this.accusedId),
      caught: r ? r.caught : this.caught,
      caughtOnTie: r ? r.caughtOnTie : this.caughtOnTie,
      guessIndex: r ? r.guessIndex : this.guessIndex,
      guessWord: r ? r.guessWord : null,
      guessCorrect: r ? r.guessCorrect : false,
      tally: r ? r.tally : this.tally,
      scorers: r ? r.scorers : [],
      leaderboard: this.getLeaderboard(),
      gameOver: !!this.winnerId,
      winnerId: this.winnerId,
      winnerName: this._nameOf(this.winnerId),
      autoAdvance: this.autoAdvanceMs > 0 && !this.winnerId,
      revealEndsAt: this.revealEndsAt || 0,
      serverNow: Date.now(),
      target: this.targetScore,
    };
  }

  getLeaderboard(limit) {
    const sorted = Array.from(this.players.values())
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => (b.score !== a.score
        ? b.score - a.score
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
    const ranked = [];
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const rank = (i > 0 && sorted[i - 1].score === p.score) ? ranked[i - 1].rank : i + 1;
      ranked.push({ rank, id: p.id, name: p.name, score: p.score });
    }
    return typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
  }

  getPodiumGroups() {
    const full = this.getLeaderboard();
    if (!full.length) return [];
    const groups = [];
    for (const row of full) {
      const last = groups[groups.length - 1];
      if (last && last.rank === row.rank) {
        last.players.push({ id: row.id, name: row.name });
      } else {
        if (groups.length >= 3) break;
        groups.push({ rank: row.rank, score: row.score, players: [{ id: row.id, name: row.name }] });
      }
    }
    return groups;
  }

  getFinalPublic() {
    return {
      podiumGroups: this.getPodiumGroups(),
      fullLeaderboard: this.getLeaderboard(),
      winnerId: this.winnerId,
      winnerName: this._nameOf(this.winnerId),
      target: this.targetScore,
    };
  }

  /**
   * THE ONLY accessor that exposes the secret word. Must be delivered to a
   * single socket — never broadcast. The Chameleon gets the same envelope with
   * no word, so their phone can render an identical hold-to-peek card.
   */
  getRolePrivate(playerId) {
    const p = this.players.get(playerId);
    if (!p || !this.currentTopic) return null;
    const isChameleon = playerId === this.chameleonId;
    return {
      round: this.roundIndex,
      topic: this.currentTopic.topic,
      isChameleon,
      secretWord: isChameleon ? null : this._secretWord(),
    };
  }

  getPlayerResult(playerId) {
    const p = this.players.get(playerId);
    const r = this.lastRoundResult;
    if (!p || !r) return null;
    const lb = this.getLeaderboard();
    const row = lb.find((e) => e.id === playerId);
    const rank = row ? row.rank : lb.length;
    const tied = lb.filter((e) => e.rank === rank).length > 1;
    const earned = r.scorers.find((s) => s.playerId === playerId);
    return {
      round: r.roundIndex,
      outcome: r.outcome,
      wasChameleon: r.chameleonId === playerId,
      secretWord: r.secretWord,
      chameleonName: r.chameleonName,
      accusedName: r.accusedName,
      caught: r.caught,
      guessWord: r.guessWord,
      guessCorrect: r.guessCorrect,
      myVote: p.votedRound === r.roundIndex ? this._nameOf(p.votedFor) : null,
      votedCorrectly: p.votedRound === r.roundIndex && p.votedFor === r.chameleonId,
      pointsEarned: earned ? earned.points : 0,
      totalScore: p.score,
      rank,
      tied,
      totalPlayers: lb.length,
      target: this.targetScore,
      gameOver: !!this.winnerId,
      isWinner: this.winnerId === playerId,
    };
  }

  reset() {
    this._clearTimers();
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.queue = [];
    this.roundIndex = 0;
    this.currentTopic = null;
    this.secretIndex = -1;
    this.chameleonId = null;
    this.order = [];
    this.turnIndex = 0;
    this.tally = [];
    this.accusedId = null;
    this.caught = false;
    this.caughtOnTie = false;
    this.guessIndex = -1;
    this.guessCorrect = false;
    this.lastRoundResult = null;
    this.chameleonBag = [];
    this.lastChameleonId = null;
    this.winnerId = null;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
    this.revealEndsAt = 0;
    this.autoAdvanceMs = 0;
  }
}

module.exports = {
  Game,
  PHASES,
  MAX_NAME_LEN,
  MIN_PLAYERS,
  MAX_PLAYERS,
  INTRO_DURATION_MS,
  ROLE_MAX_MS,
  DEFAULT_TARGET,
  GRID_SIZE,
};
