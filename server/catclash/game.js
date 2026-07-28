'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Category Clash — single-room game state machine (Scattergories rules).
//
// Flow:  LOBBY → INTRO → ROUND → REVIEWING → REVIEW → REVEAL → (loop) → FINAL
//
//   INTRO     : the round's letter is revealed on the big screen.
//   ROUND     : every player fills in the SAME 12 categories on their phone,
//               each answer must start with the round's letter. Answers save
//               as they type; a player can tap Done early.
//   REVIEWING : answers are auto-bucketed + validity-checked (grouping.js).
//   REVIEW    : host-only, ONE CATEGORY AT A TIME. Buckets can be merged /
//               split / renamed, and anything bogus dragged into the special
//               "Invalid" bucket. Confirming a category scores it.
//   REVEAL    : round scoreboard.
//   FINAL     : most points after the last round wins.
//
// Scoring (classic Scattergories): an answer scores +1 when it is
//   (1) unique — nobody else wrote the same word,
//   (2) starting with the round's letter (a/an/the prefix allowed), and
//   (3) a genuine member of the category.
// Duplicates and invalid answers score nothing.
//
// A letter is never reused within a game, and neither is a category.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  INTRO: 'INTRO',
  ROUND: 'ROUND',
  REVIEWING: 'REVIEWING',
  REVIEW: 'REVIEW',
  REVEAL: 'REVEAL',
  FINAL: 'FINAL',
};

const MAX_NAME_LEN = 20;
const MAX_ANSWER_LEN = 40;
const MIN_PLAYERS = 2;
const INTRO_DURATION_MS = 4000;
const INTRO_GO_HOLD_MS = 1200;
const DEFAULT_ROUNDS = 3;
const DEFAULT_TIME_SEC = 180;

const { buildQueue, buildLetterQueue, CATEGORIES_PER_ROUND } = require('./categories');

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    /** @type {Map<string, any>} */
    this.players = new Map();

    this.totalRounds = DEFAULT_ROUNDS;
    this.timeLimitSec = DEFAULT_TIME_SEC;

    this.categoryQueue = [];   // shuffled bank, drawn 12 at a time
    this.letterQueue = [];     // shuffled 20 letters, drawn 1 per round
    this.categories = [];      // this round's 12 categories
    this.letter = '';          // this round's letter

    this.roundIndex = 0;       // 1-based once a round has begun
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
    this.lastEndReason = null; // 'timeout' | 'all-done' | 'host'

    this.reviewIndex = 0;              // which category the host is reviewing
    /** @type {Array<any>} */
    this.categoryReviews = [];         // provisional, from grouping.js
    /** @type {Array<any>} */
    this.categoryResults = [];         // confirmed by the host, used for scoring
    this.lastRoundResult = null;

    this._introTimer = null;
    this._roundTimer = null;

    this.onIntroEnd = null;
    this.onRoundEnd = null;
  }

  // ---------------- Lobby / players ----------------

  sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    let n = raw.replace(/[^\p{L}\p{N} '._-]/gu, '').trim().replace(/\s+/g, ' ');
    if (n.length > MAX_NAME_LEN) n = n.slice(0, MAX_NAME_LEN);
    return n;
  }

  sanitizeAnswer(raw) {
    if (typeof raw !== 'string') return '';
    let a = raw.replace(/[\r\n\t]+/g, ' ').trim().replace(/\s+/g, ' ');
    if (a.length > MAX_ANSWER_LEN) a = a.slice(0, MAX_ANSWER_LEN);
    return a;
  }

  nameIsTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  _blankAnswers() {
    return new Array(CATEGORIES_PER_ROUND).fill('');
  }

  addPlayer({ playerId, name, socketId }) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'lobby-closed' };
    if (!playerId || typeof playerId !== 'string') return { ok: false, reason: 'bad-player-id' };
    if (this.players.has(playerId)) return this.reconnectPlayer({ playerId, socketId });
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) return { ok: false, reason: 'name-taken', name: clean };
    const player = {
      id: playerId,
      name: clean,
      socketId,
      score: 0,
      roundPoints: 0,
      answers: this._blankAnswers(),
      doneRound: -1,
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

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  // ---------------- Draws ----------------

  _drawLetter() {
    if (!this.letterQueue.length) this.letterQueue = buildLetterQueue();
    return this.letterQueue.shift() || 'A';
  }

  _drawCategories() {
    const out = [];
    while (out.length < CATEGORIES_PER_ROUND) {
      if (!this.categoryQueue.length) this.categoryQueue = buildQueue();
      const c = this.categoryQueue.shift();
      if (!c) break;
      out.push({ id: c.id, text: c.text });
    }
    return out;
  }

  // ---------------- Progression ----------------

  start({ rounds, timeLimitSec } = {}) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'already-started' };
    if (this.players.size < MIN_PLAYERS) return { ok: false, reason: 'not-enough-players', min: MIN_PLAYERS };
    const r = parseInt(rounds, 10);
    this.totalRounds = (r >= 1 && r <= 10) ? r : DEFAULT_ROUNDS;
    const t = parseInt(timeLimitSec, 10);
    this.timeLimitSec = (t >= 30 && t <= 900) ? t : DEFAULT_TIME_SEC;
    this.categoryQueue = buildQueue();
    this.letterQueue = buildLetterQueue();
    this.roundIndex = 0;
    this.lastRoundResult = null;
    for (const p of this.players.values()) {
      p.score = 0;
      p.roundPoints = 0;
      p.answers = this._blankAnswers();
      p.doneRound = -1;
    }
    return this._enterIntro();
  }

  _clearTimers() {
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    if (this._roundTimer) { clearTimeout(this._roundTimer); this._roundTimer = null; }
  }

  _enterIntro() {
    this._clearTimers();
    this.phase = PHASES.INTRO;
    this.roundIndex += 1;
    this.letter = this._drawLetter();
    this.categories = this._drawCategories();
    this.reviewIndex = 0;
    this.categoryReviews = [];
    this.categoryResults = [];
    for (const p of this.players.values()) {
      p.roundPoints = 0;
      p.answers = this._blankAnswers();
      p.doneRound = -1;
    }
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
    this._enterRound();
    if (typeof this.onIntroEnd === 'function') { try { this.onIntroEnd(); } catch (_) {} }
  }

  _enterRound() {
    this._clearTimers();
    this.phase = PHASES.ROUND;
    this.lastEndReason = null;
    this.currentStartTs = Date.now();
    this.currentEndsAt = this.currentStartTs + this.timeLimitSec * 1000;
    this._roundTimer = setTimeout(() => {
      this._roundTimer = null;
      this._endRound('timeout');
    }, this.timeLimitSec * 1000 + 100);
    return { ok: true, phase: PHASES.ROUND };
  }

  _endRound(reason) {
    if (this.phase !== PHASES.ROUND) return;
    this._clearTimers();
    this.phase = PHASES.REVIEWING;
    this.lastEndReason = reason || 'host';
    this.reviewIndex = 0;
    this.categoryReviews = [];
    this.categoryResults = [];
    if (typeof this.onRoundEnd === 'function') { try { this.onRoundEnd(); } catch (_) {} }
  }

  // ---------------- Answers ----------------

  submitAnswer({ playerId, catIdx, text }) {
    if (this.phase !== PHASES.ROUND) return { ok: false, reason: 'not-accepting-answers' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    const i = parseInt(catIdx, 10);
    if (!Number.isInteger(i) || i < 0 || i >= this.categories.length) {
      return { ok: false, reason: 'bad-category' };
    }
    const clean = this.sanitizeAnswer(text);
    p.answers[i] = clean;
    return { ok: true, catIdx: i, answer: clean };
  }

  setDone({ playerId, done }) {
    if (this.phase !== PHASES.ROUND) return { ok: false, reason: 'not-accepting-answers' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    p.doneRound = done ? this.roundIndex : -1;
    // End early once every current player has tapped Done.
    if (done && this.players.size > 0 && this.doneCount() >= this.players.size) {
      this._endRound('all-done');
      return { ok: true, done: true, roundOver: true };
    }
    return { ok: true, done: !!done };
  }

  doneCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.doneRound === this.roundIndex) n++;
    return n;
  }

  filledCount(playerId) {
    const p = this.players.get(playerId);
    if (!p) return 0;
    let n = 0;
    for (const a of p.answers) if (a && a.trim()) n++;
    return n;
  }

  // Non-blank answers for one category, one entry per player who wrote one.
  collectCategory(catIdx) {
    const out = [];
    for (const p of this.players.values()) {
      const raw = (p.answers[catIdx] || '').trim();
      if (!raw) continue;
      out.push({ playerId: p.id, name: p.name, raw });
    }
    return out;
  }

  // Players who left a category blank (shown greyed-out on the review screen).
  collectBlanks(catIdx) {
    const out = [];
    for (const p of this.players.values()) {
      const raw = (p.answers[catIdx] || '').trim();
      if (!raw) out.push({ playerId: p.id, name: p.name });
    }
    return out;
  }

  /** Provisional per-category buckets from grouping.js (set by the transport). */
  setCategoryReviews(reviews) {
    if (this.phase !== PHASES.REVIEWING) return { ok: false, reason: 'not-reviewing' };
    this.categoryReviews = Array.isArray(reviews) ? reviews : [];
    this.reviewIndex = 0;
    this.phase = PHASES.REVIEW;
    return { ok: true };
  }

  // ---------------- Scoring ----------------

  /**
   * Validate the host's buckets for one category. Every player who submitted a
   * non-blank answer must appear exactly once across the buckets and the
   * invalid pile. Returns sanitized data, or null if the payload is bogus.
   */
  _validateCategory(catIdx, buckets, invalidIds) {
    if (!Array.isArray(buckets)) return null;
    const expected = new Set(this.collectCategory(catIdx).map((s) => s.playerId));
    const seen = new Set();
    const outBuckets = [];
    for (const b of buckets) {
      if (!b || !Array.isArray(b.members)) return null;
      const members = [];
      for (const m of b.members) {
        const pid = m && m.playerId;
        const p = pid && this.players.get(pid);
        if (!p || !expected.has(pid) || seen.has(pid)) return null;
        seen.add(pid);
        members.push({ playerId: pid, name: p.name, raw: (p.answers[catIdx] || '').trim() });
      }
      if (members.length === 0) continue;
      outBuckets.push({
        id: typeof b.id === 'string' && b.id ? b.id.slice(0, 40) : ('b' + outBuckets.length),
        label: typeof b.label === 'string' && b.label.trim()
          ? b.label.trim().slice(0, 60)
          : members[0].raw,
        members,
      });
    }
    const outInvalid = [];
    for (const pid of (Array.isArray(invalidIds) ? invalidIds : [])) {
      const p = typeof pid === 'string' && this.players.get(pid);
      if (!p || !expected.has(pid) || seen.has(pid)) return null;
      seen.add(pid);
      outInvalid.push({ playerId: pid, name: p.name, raw: (p.answers[catIdx] || '').trim() });
    }
    if (seen.size !== expected.size) return null;
    return { buckets: outBuckets, invalid: outInvalid };
  }

  /**
   * Confirm + score one category. Must be the category currently under review.
   * A bucket of exactly one member scores that player +1; buckets of 2+ are
   * duplicates and score nothing, as does everything in the invalid pile.
   */
  scoreCategory({ catIdx, buckets, invalid } = {}) {
    if (this.phase !== PHASES.REVIEW) return { ok: false, reason: 'not-reviewing' };
    const i = parseInt(catIdx, 10);
    if (i !== this.reviewIndex) return { ok: false, reason: 'wrong-category' };

    let data = this._validateCategory(i, buckets, invalid);
    if (!data) {
      // Fall back to the provisional AI result so a malformed payload can
      // never wedge the game.
      const prov = this.categoryReviews[i] || { buckets: [], invalid: [] };
      data = {
        buckets: (prov.buckets || []).map((b) => ({
          id: b.id,
          label: b.label,
          members: (b.members || []).map((m) => ({ playerId: m.playerId, name: m.name, raw: m.raw })),
        })),
        invalid: (prov.invalid || []).map((m) => ({ playerId: m.playerId, name: m.name, raw: m.raw })),
      };
    }

    const scorers = [];
    const scored = data.buckets.map((b) => {
      const isUnique = b.members.length === 1;
      if (isUnique) {
        const p = this.players.get(b.members[0].playerId);
        if (p) { p.score += 1; p.roundPoints += 1; scorers.push(p.id); }
      }
      return { id: b.id, label: b.label, members: b.members, scored: isUnique };
    }).sort((a, b) => b.members.length - a.members.length ||
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

    this.categoryResults[i] = {
      catIdx: i,
      category: this.categories[i] ? this.categories[i].text : '',
      buckets: scored,
      invalid: data.invalid,
      blanks: this.collectBlanks(i),
      scorers,
    };

    this.reviewIndex = i + 1;
    if (this.reviewIndex >= this.categories.length) {
      this._finishRound();
      return { ok: true, done: true, phase: PHASES.REVEAL };
    }
    return { ok: true, done: false, catIdx: this.reviewIndex, phase: PHASES.REVIEW };
  }

  _finishRound() {
    this._clearTimers();
    this.phase = PHASES.REVEAL;
    this.lastRoundResult = {
      round: this.roundIndex,
      letter: this.letter,
      categories: this.categories.map((c) => c.text),
      results: this.categoryResults.slice(),
      board: Array.from(this.players.values()).map((p) => ({
        id: p.id, name: p.name, roundPoints: p.roundPoints, score: p.score,
      })),
      isLastRound: this.roundIndex >= this.totalRounds,
    };
  }

  /** Advance out of REVEAL: next round, or the final results. */
  advanceReveal() {
    if (this.phase !== PHASES.REVEAL) return { ok: false, reason: 'not-reveal' };
    this._clearTimers();
    if (this.roundIndex >= this.totalRounds) {
      this.phase = PHASES.FINAL;
      return { ok: true, phase: PHASES.FINAL };
    }
    return this._enterIntro();
  }

  /** Generic host "Next" dispatcher used by the transport layer. */
  advance() {
    if (this.phase === PHASES.INTRO) { this._endIntro(); return { ok: true, phase: PHASES.ROUND }; }
    if (this.phase === PHASES.ROUND) { this._endRound('host'); return { ok: true, phase: PHASES.REVIEWING }; }
    if (this.phase === PHASES.REVEAL) return this.advanceReveal();
    return { ok: false, reason: 'cannot-advance' };
  }

  // ---------------- Views / serialization ----------------

  getIntroPublic() {
    return {
      round: this.roundIndex,
      totalRounds: this.totalRounds,
      letter: this.letter,
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      durationMs: INTRO_DURATION_MS,
    };
  }

  getRoundPublic() {
    return {
      round: this.roundIndex,
      totalRounds: this.totalRounds,
      letter: this.letter,
      categories: this.categories.map((c, i) => ({ idx: i, id: c.id, text: c.text })),
      timeLimitSec: this.timeLimitSec,
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
    };
  }

  getReviewingPublic() {
    return {
      round: this.roundIndex,
      totalRounds: this.totalRounds,
      letter: this.letter,
      total: this.categories.length,
    };
  }

  // Host-only review payload for the category currently under the microscope.
  getReviewPublic() {
    const i = this.reviewIndex;
    const cat = this.categories[i];
    const prov = this.categoryReviews[i] || { buckets: [], invalid: [] };
    return {
      round: this.roundIndex,
      totalRounds: this.totalRounds,
      letter: this.letter,
      catIdx: i,
      total: this.categories.length,
      category: cat ? cat.text : '',
      buckets: (prov.buckets || []).map((b) => ({
        id: b.id,
        label: b.label,
        autoMerged: !!b.autoMerged,
        mergeSource: b.mergeSource || null,
        members: (b.members || []).map((m) => ({ playerId: m.playerId, name: m.name, raw: m.raw })),
      })),
      invalid: (prov.invalid || []).map((m) => ({
        playerId: m.playerId, name: m.name, raw: m.raw, reason: m.reason || null,
      })),
      blanks: this.collectBlanks(i),
      totalPlayers: this.players.size,
    };
  }

  // Progress ticker shown on the phones while the host reviews.
  getReviewProgressPublic() {
    const cat = this.categories[this.reviewIndex];
    return {
      round: this.roundIndex,
      totalRounds: this.totalRounds,
      letter: this.letter,
      catIdx: this.reviewIndex,
      total: this.categories.length,
      category: cat ? cat.text : '',
    };
  }

  getRevealPublic() {
    const r = this.lastRoundResult;
    const lb = this.getLeaderboard();
    const pts = new Map((r ? r.board : []).map((b) => [b.id, b.roundPoints]));
    return {
      round: this.roundIndex,
      totalRounds: this.totalRounds,
      letter: this.letter,
      isLastRound: this.roundIndex >= this.totalRounds,
      board: lb.map((row) => ({
        rank: row.rank,
        id: row.id,
        name: row.name,
        score: row.score,
        roundPoints: pts.get(row.id) || 0,
      })),
      serverNow: Date.now(),
    };
  }

  _nameOf(pid) {
    if (!pid) return null;
    const p = this.players.get(pid);
    return p ? p.name : null;
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

  // Up to 3 podium GROUPS by distinct rank (ties share a card).
  getPodiumGroups() {
    const full = this.getLeaderboard();
    if (full.length === 0) return [];
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

  // The sole rank-1 player, or null when the lead is tied.
  getWinnerId() {
    const lb = this.getLeaderboard();
    if (!lb.length) return null;
    const leaders = lb.filter((r) => r.rank === 1);
    return leaders.length === 1 ? leaders[0].id : null;
  }

  getFinalPublic() {
    const winnerId = this.getWinnerId();
    return {
      podiumGroups: this.getPodiumGroups(),
      fullLeaderboard: this.getLeaderboard(),
      winnerId,
      winnerName: this._nameOf(winnerId),
      totalRounds: this.totalRounds,
    };
  }

  getLobbyPlayers() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id, name: p.name, connected: p.connected,
    }));
  }

  // Live per-player progress for the host's round screen.
  getProgressPublic() {
    return {
      done: this.doneCount(),
      total: this.players.size,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        filled: p.answers.reduce((n, a) => n + (a && a.trim() ? 1 : 0), 0),
        done: p.doneRound === this.roundIndex,
      })),
    };
  }

  // Private per-player breakdown for the phone during REVEAL.
  getPlayerResult(playerId) {
    const p = this.players.get(playerId);
    const r = this.lastRoundResult;
    if (!p || !r) return null;
    const lb = this.getLeaderboard();
    const row = lb.find((e) => e.id === playerId);
    const rank = row ? row.rank : lb.length;
    const tied = lb.filter((e) => e.rank === rank).length > 1;

    const breakdown = this.categories.map((cat, i) => {
      const res = r.results[i];
      const answer = (p.answers[i] || '').trim();
      let status = 'blank';
      if (res) {
        if (res.invalid.some((m) => m.playerId === playerId)) status = 'invalid';
        else {
          const b = res.buckets.find((bk) => bk.members.some((m) => m.playerId === playerId));
          if (b) status = b.scored ? 'scored' : 'duplicate';
        }
      } else if (answer) {
        status = 'duplicate';
      }
      return { category: cat.text, answer, status };
    });

    return {
      round: r.round,
      totalRounds: this.totalRounds,
      letter: r.letter,
      roundPoints: p.roundPoints,
      totalScore: p.score,
      rank,
      tied,
      totalPlayers: lb.length,
      isLastRound: r.isLastRound,
      breakdown,
    };
  }

  getPlayerAnswers(playerId) {
    const p = this.players.get(playerId);
    return p ? p.answers.slice() : this._blankAnswers();
  }

  reset() {
    this._clearTimers();
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.categoryQueue = [];
    this.letterQueue = [];
    this.categories = [];
    this.letter = '';
    this.roundIndex = 0;
    this.currentStartTs = 0;
    this.currentEndsAt = 0;
    this.reviewIndex = 0;
    this.categoryReviews = [];
    this.categoryResults = [];
    this.lastRoundResult = null;
  }
}

module.exports = {
  Game, PHASES, MAX_NAME_LEN, MAX_ANSWER_LEN, MIN_PLAYERS,
  INTRO_DURATION_MS, DEFAULT_ROUNDS, DEFAULT_TIME_SEC, CATEGORIES_PER_ROUND,
};
