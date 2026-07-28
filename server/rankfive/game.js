'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Rank Five — single-room, co-operative "read the ranker's mind" game.
//
// Flow:  LOBBY → [COLLECT] → INTRO → RANK → DISCUSS → REVEAL → (loop) → FINAL
//
//   COLLECT : (Custom Words mode only) every player secretly submits 5
//             words/phrases; together they form the pool. Each submitted
//             phrase is used exactly once, in exactly one round. Rounds only
//             begin once EVERY player has submitted all 5.
//   RANK    : one player (the ranker) secretly orders 5 items 1→5.
//             Nobody else sees the items yet.
//   DISCUSS : a DIFFERENT player (the submitter) drags the group's consensus
//             order, mirrored live to the host + every non-ranker phone. The
//             ranker sits back and stays quiet.
//   REVEAL  : the consensus and the ranker's secret order are shown together.
//             Each matching position scores the GROUP +1, each mismatch scores
//             the GAME +1 (5 points split per round).
//   FINAL   : after everyone has been ranker once (and submitter once), the
//             group WINS if its total ≥ the game's total.
//
// The whole game is co-operative: there are no individual scores, just Group
// vs Game. Roles are assigned once at start as a random derangement so the
// ranker and submitter of a round are never the same person, and every player
// is ranker exactly once and submitter exactly once.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = {
  LOBBY: 'LOBBY',
  COLLECT: 'COLLECT',
  INTRO: 'INTRO',
  RANK: 'RANK',
  DISCUSS: 'DISCUSS',
  REVEAL: 'REVEAL',
  FINAL: 'FINAL',
};

const MAX_NAME_LEN = 20;
const MAX_WORD_LEN = 50;
const WORDS_PER_PLAYER = 5;
const MIN_PLAYERS = 2;
const ITEMS_PER_ROUND = 5;
const INTRO_DURATION_MS = 4000;
const INTRO_GO_HOLD_MS = 1100;
const REVEAL_TRANSITION_MS = 2500;   // "Let's see how the group did…" hold before results

const { buildPool } = require('./words');

// Tier-A normalization for duplicate detection: lowercase, strip punctuation,
// collapse whitespace, and drop a leading article ("the"/"a"/"an"). Deterministic
// and conservative — it catches "Pizza"/"pizza ", "ice-cream"/"ice cream", and
// "The Office"/"Office", but NOT semantic matches like "Trump"/"Donald Trump".
function normalizeWord(w) {
  let s = String(w == null ? '' : w).toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');   // punctuation → space
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(the|a|an)\s+/, '');       // strip a leading article (only when more follows)
  return s;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A permutation S of `ids` with S[i] !== base[i] for all i (a derangement
// relative to `base`). Both are permutations of the same set.
function derange(base) {
  const n = base.length;
  if (n < 2) return base.slice();
  for (let attempt = 0; attempt < 1000; attempt++) {
    const cand = shuffle(base);
    let ok = true;
    for (let i = 0; i < n; i++) { if (cand[i] === base[i]) { ok = false; break; } }
    if (ok) return cand;
  }
  // Deterministic fallback: rotate by one (guaranteed no fixed point).
  return base.slice(1).concat(base.slice(0, 1));
}

class Game {
  constructor() {
    this.phase = PHASES.LOBBY;
    /** @type {Map<string, any>} */
    this.players = new Map();

    this.customWords = true;  // Custom Words mode: players submit the pool (default on)

    this.rounds = [];         // precomputed at start: [{ rankerId, submitterId, items, displayOrder, rankerOrder, consensusOrder, result }]
    this.roundIndex = 0;      // 0-based index of the CURRENT round

    this.groupScore = 0;      // co-op: matches accumulated across rounds
    this.gameScore = 0;       // mismatches accumulated across rounds

    this.currentStartTs = 0;
    this.currentEndsAt = 0;   // only used for the INTRO countdown

    this._introTimer = null;
    this._revealTimer = null;
    // While true, the phase is REVEAL but clients hold on a transition screen
    // ("Let's see how the group did…") until the server flips to the results.
    this.revealTransition = false;
    this.revealReadyAt = 0;   // serverNow when results unlock

    this.onIntroEnd = null;    // transport hook: intro finished → broadcast RANK
    this.onRevealReady = null; // transport hook: transition finished → broadcast REVEAL
  }

  // ---------------- Lobby / players ----------------

  sanitizeName(raw) {
    if (typeof raw !== 'string') return '';
    let n = raw.replace(/[^\p{L}\p{N} '._-]/gu, '').trim().replace(/\s+/g, ' ');
    if (n.length > MAX_NAME_LEN) n = n.slice(0, MAX_NAME_LEN);
    return n;
  }

  sanitizeWord(raw) {
    if (typeof raw !== 'string') return '';
    let w = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (w.length > MAX_WORD_LEN) w = w.slice(0, MAX_WORD_LEN).trim();
    return w;
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
    const clean = this.sanitizeName(name);
    if (clean.length < 1) return { ok: false, reason: 'name-too-short' };
    if (this.nameIsTaken(clean)) return { ok: false, reason: 'name-taken', name: clean };
    const player = {
      id: playerId,
      name: clean,
      socketId,
      joinedAt: Date.now(),
      connected: true,
      submittedWords: null,
      wordsSubmitted: false,
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

  // Kicking is only allowed in the lobby — once the game starts (including the
  // word-collection phase) the roster is locked.
  removePlayer(playerId) {
    if (this.phase !== PHASES.LOBBY) return null;
    const p = this.players.get(playerId);
    if (!p) return null;
    this.players.delete(playerId);
    return p;
  }

  getLobbyPlayers() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id, name: p.name, connected: p.connected,
    }));
  }

  // ---------------- Round construction ----------------

  // Distribute a flat pool of texts into `roundCount` buckets of ITEMS_PER_ROUND,
  // keeping buckets balanced and (best-effort) free of duplicate text within a
  // single round. The pool must hold at least ITEMS_PER_ROUND * roundCount items.
  _distribute(pool, roundCount) {
    const buckets = Array.from({ length: roundCount }, () => []);
    for (const text of pool) {
      if (buckets.every((b) => b.length >= ITEMS_PER_ROUND)) break;
      let cand = buckets.filter((b) => b.length < ITEMS_PER_ROUND && !b.includes(text));
      if (!cand.length) cand = buckets.filter((b) => b.length < ITEMS_PER_ROUND);
      cand.sort((a, b) => a.length - b.length);
      cand[0].push(text);
    }
    return buckets;
  }

  // Build the N rounds (roles + 5 items each). `poolOverride` (Custom Words) is a
  // flat list of player-submitted phrases; without it we draw from the bank.
  _buildRounds(playerIds, poolOverride) {
    const roundCount = playerIds.length;
    const rankers = shuffle(playerIds);
    const submitters = derange(rankers);

    const hasOverride = Array.isArray(poolOverride) && poolOverride.length > 0;
    let pool = hasOverride ? poolOverride.slice() : buildPool();
    // Ensure the pool covers 5 items per round (cross-round reuse fallback — only
    // ever needed for the bank with lots of players; Custom Words is exact).
    const need = ITEMS_PER_ROUND * roundCount;
    while (pool.length < need) {
      pool = pool.concat(shuffle(hasOverride ? poolOverride : buildPool()));
    }
    const buckets = this._distribute(shuffle(pool), roundCount);

    return rankers.map((rankerId, i) => {
      const items = buckets[i].map((text, k) => ({ id: k, text }));
      const ids = items.map((it) => it.id);          // [0,1,2,3,4]
      const displayOrder = shuffle(ids);             // neutral order everyone sees
      return {
        rankerId,
        submitterId: submitters[i],
        items,
        displayOrder,
        rankerOrder: null,                            // ranker's secret 1→5 (item ids)
        consensusOrder: displayOrder.slice(),         // group's working order
        result: null,
      };
    });
  }

  currentRound() {
    return this.rounds[this.roundIndex] || null;
  }

  // ---------------- Progression ----------------

  start() {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'already-started' };
    if (this.players.size < MIN_PLAYERS) {
      return { ok: false, reason: 'not-enough-players', min: MIN_PLAYERS };
    }
    this.roundIndex = 0;
    this.groupScore = 0;
    this.gameScore = 0;
    for (const p of this.players.values()) { p.submittedWords = null; p.wordsSubmitted = false; }
    if (this.customWords) {
      // Collect 5 phrases from every player first; rounds are built once all are in.
      this._clearTimers();
      this.phase = PHASES.COLLECT;
      return { ok: true, phase: PHASES.COLLECT };
    }
    this.rounds = this._buildRounds(Array.from(this.players.keys()));
    return this._enterIntro();
  }

  setCustomWords(on) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'not-lobby' };
    this.customWords = !!on;
    return { ok: true, customWords: this.customWords };
  }

  // A player submits their WORDS_PER_PLAYER phrases during COLLECT. They can
  // re-open the form and resubmit any time before the host starts (see
  // editWords). Rounds are built only when the host starts (beginFromCollect).
  submitWords({ playerId, words }) {
    if (this.phase !== PHASES.COLLECT) return { ok: false, reason: 'not-collecting' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (!Array.isArray(words) || words.length !== WORDS_PER_PLAYER) {
      return { ok: false, reason: 'bad-words', need: WORDS_PER_PLAYER };
    }
    const clean = words.map((w) => this.sanitizeWord(w));
    if (clean.some((w) => !w)) return { ok: false, reason: 'bad-words', need: WORDS_PER_PLAYER };
    const norm = clean.map((w) => normalizeWord(w));
    // No repeats within a player's own 5 (keep the first, flag later duplicates).
    const seenOwn = new Set();
    const ownDup = [];
    norm.forEach((n, i) => { if (seenOwn.has(n)) ownDup.push(i); else seenOwn.add(n); });
    if (ownDup.length) return { ok: false, reason: 'duplicate-own', dupIndexes: ownDup };
    // No repeats across players — first come, first served. Exclude this player's
    // own previously-accepted words so a direct resubmit never collides with self.
    const taken = this._takenWords(playerId);
    const takenIdx = [];
    norm.forEach((n, i) => { if (taken.has(n)) takenIdx.push(i); });
    if (takenIdx.length) return { ok: false, reason: 'duplicate-taken', dupIndexes: takenIdx };
    p.submittedWords = clean;
    p.wordsSubmitted = true;
    return { ok: true, phase: this.phase, words: clean };
  }

  // A player re-opens their submission to edit it. This unsubmits them (their
  // words are released back into the pool for others — first come, first served),
  // keeping their previous words only to prefill the form. Returns those words.
  editWords({ playerId }) {
    if (this.phase !== PHASES.COLLECT) return { ok: false, reason: 'not-collecting' };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    const words = Array.isArray(p.submittedWords) ? p.submittedWords.slice() : null;
    p.wordsSubmitted = false;
    return { ok: true, words };
  }

  // Normalized set of every word already accepted from any player (optionally
  // excluding one player, e.g. the one currently resubmitting).
  _takenWords(excludeId) {
    const set = new Set();
    for (const pl of this.players.values()) {
      if (excludeId && pl.id === excludeId) continue;
      if (pl.wordsSubmitted && Array.isArray(pl.submittedWords)) {
        for (const w of pl.submittedWords) set.add(normalizeWord(w));
      }
    }
    return set;
  }

  allSubmitted() {
    if (this.players.size === 0) return false;
    for (const p of this.players.values()) if (!p.wordsSubmitted) return false;
    return true;
  }

  // Everyone has submitted and nobody is mid-edit (editing unsubmits, so this
  // single check covers both). The host may only start once this is true.
  collectReady() {
    return this.allSubmitted();
  }

  // Host-triggered: build the rounds from every player's submitted words and
  // enter INTRO. Guarded so a Start click that races an edit is rejected.
  beginFromCollect() {
    if (this.phase !== PHASES.COLLECT) return { ok: false, reason: 'not-collecting' };
    if (!this.collectReady()) return { ok: false, reason: 'not-ready' };
    const ids = Array.from(this.players.keys());
    const pool = [];
    for (const id of ids) {
      const p = this.players.get(id);
      if (p && Array.isArray(p.submittedWords)) pool.push(...p.submittedWords);
    }
    this.rounds = this._buildRounds(ids, pool);
    this.roundIndex = 0;
    return this._enterIntro();
  }

  collectCounts() {
    let submitted = 0;
    for (const p of this.players.values()) if (p.wordsSubmitted) submitted++;
    return { submitted, total: this.players.size };
  }

  reset() {
    this._clearTimers();
    this.phase = PHASES.LOBBY;
    this.rounds = [];
    this.roundIndex = 0;
    this.groupScore = 0;
    this.gameScore = 0;
    this.players.clear();   // clear the lobby entirely — everyone must rejoin
    // Keep the customWords toggle.
  }

  _clearTimers() {
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
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
    this._enterRank();
    if (typeof this.onIntroEnd === 'function') { try { this.onIntroEnd(); } catch (_) {} }
  }

  _enterRank() {
    this._clearTimers();
    this.phase = PHASES.RANK;
    const r = this.currentRound();
    if (r) {
      // Fresh start for this round (harmless if already fresh).
      r.rankerOrder = null;
      r.consensusOrder = r.displayOrder.slice();
      r.result = null;
    }
    return { ok: true, phase: PHASES.RANK };
  }

  _isPermutation(order) {
    if (!Array.isArray(order) || order.length !== ITEMS_PER_ROUND) return false;
    const seen = new Set();
    for (const v of order) {
      if (typeof v !== 'number' || v < 0 || v >= ITEMS_PER_ROUND) return false;
      if (seen.has(v)) return false;
      seen.add(v);
    }
    return seen.size === ITEMS_PER_ROUND;
  }

  // Ranker locks in their secret order → move to DISCUSS.
  submitRanking({ playerId, order }) {
    if (this.phase !== PHASES.RANK) return { ok: false, reason: 'not-ranking' };
    const r = this.currentRound();
    if (!r) return { ok: false, reason: 'no-round' };
    if (playerId !== r.rankerId) return { ok: false, reason: 'not-ranker' };
    if (!this._isPermutation(order)) return { ok: false, reason: 'bad-order' };
    r.rankerOrder = order.slice();
    r.consensusOrder = r.displayOrder.slice();  // group starts from the neutral order
    this.phase = PHASES.DISCUSS;
    return { ok: true, phase: PHASES.DISCUSS };
  }

  // Submitter drags the consensus (live). Validated + stored, then mirrored.
  updateConsensus({ playerId, order }) {
    if (this.phase !== PHASES.DISCUSS) return { ok: false, reason: 'not-discussing' };
    const r = this.currentRound();
    if (!r) return { ok: false, reason: 'no-round' };
    if (playerId !== r.submitterId) return { ok: false, reason: 'not-submitter' };
    if (!this._isPermutation(order)) return { ok: false, reason: 'bad-order' };
    r.consensusOrder = order.slice();
    return { ok: true };
  }

  // Submitter locks in the group's answer → score + REVEAL.
  submitConsensus({ playerId, order }) {
    if (this.phase !== PHASES.DISCUSS) return { ok: false, reason: 'not-discussing' };
    const r = this.currentRound();
    if (!r) return { ok: false, reason: 'no-round' };
    if (playerId !== r.submitterId) return { ok: false, reason: 'not-submitter' };
    if (this._isPermutation(order)) r.consensusOrder = order.slice();
    if (!r.rankerOrder) return { ok: false, reason: 'no-ranking' };

    // Score: matching positions → group, mismatches → game.
    const positions = [];
    let matches = 0;
    for (let p = 0; p < ITEMS_PER_ROUND; p++) {
      const hit = r.consensusOrder[p] === r.rankerOrder[p];
      positions.push(hit);
      if (hit) matches++;
    }
    const groupPts = matches;
    const gamePts = ITEMS_PER_ROUND - matches;
    this.groupScore += groupPts;
    this.gameScore += gamePts;
    r.result = { positions, groupPts, gamePts };

    this.phase = PHASES.REVEAL;
    // Hold everyone on a shared transition screen for a beat before the results
    // unlock — the server owns the timing so host + phones flip in lockstep.
    this.revealTransition = true;
    this.revealReadyAt = Date.now() + REVEAL_TRANSITION_MS;
    this._clearTimers();
    this._revealTimer = setTimeout(() => {
      this._revealTimer = null;
      this._endRevealTransition();
    }, REVEAL_TRANSITION_MS);
    return { ok: true, phase: PHASES.REVEAL, transition: true };
  }

  // Transition hold elapsed → unlock the results for everyone at once.
  _endRevealTransition() {
    if (this.phase !== PHASES.REVEAL || !this.revealTransition) return;
    this.revealTransition = false;
    if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
    if (typeof this.onRevealReady === 'function') { try { this.onRevealReady(); } catch (_) {} }
  }

  // Host "Next" from the reveal → next round, or the final tally.
  advance() {
    if (this.phase === PHASES.INTRO) { this._endIntro(); return { ok: true, phase: this.phase }; }
    if (this.phase === PHASES.REVEAL) {
      // A stray Next during the brief transition still lands on the results.
      this.revealTransition = false;
      this._clearTimers();
      if (this.roundIndex >= this.rounds.length - 1) {
        this.phase = PHASES.FINAL;
        return { ok: true, phase: PHASES.FINAL };
      }
      this.roundIndex += 1;
      this._enterRank();
      return { ok: true, phase: PHASES.RANK };
    }
    return { ok: false, reason: 'cannot-advance' };
  }

  // ---------------- Serialization ----------------

  _nameOf(pid) {
    if (!pid) return null;
    const p = this.players.get(pid);
    return p ? p.name : null;
  }

  getIntroPublic() {
    return {
      endsAt: this.currentEndsAt,
      serverNow: Date.now(),
      durationMs: INTRO_DURATION_MS,
      totalRounds: this.rounds.length,
      playerCount: this.players.size,
    };
  }

  // COLLECT progress (host view): who has submitted their words.
  getCollectPublic() {
    const c = this.collectCounts();
    return {
      total: c.total,
      submitted: c.submitted,
      ready: this.collectReady(),
      wordsPerPlayer: WORDS_PER_PLAYER,
      maxWordLen: MAX_WORD_LEN,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id, name: p.name, submitted: !!p.wordsSubmitted, connected: p.connected,
      })),
    };
  }

  // COLLECT state for a single player (their own form / lock state). Returns the
  // stored words even when unsubmitted (mid-edit) so a reconnect can prefill.
  getCollectPersonal(playerId) {
    const p = this.players.get(playerId);
    return {
      wordsPerPlayer: WORDS_PER_PLAYER,
      maxWordLen: MAX_WORD_LEN,
      submitted: !!(p && p.wordsSubmitted),
      words: p && Array.isArray(p.submittedWords) ? p.submittedWords.slice() : null,
    };
  }

  // RANK broadcast (everyone incl. host): no items — only who's ranking. The
  // ranker gets the items privately via getRankerItems().
  getRankPublic() {
    const r = this.currentRound();
    return {
      round: this.roundIndex + 1,
      totalRounds: this.rounds.length,
      rankerId: r ? r.rankerId : null,
      rankerName: r ? this._nameOf(r.rankerId) : null,
      submitterName: r ? this._nameOf(r.submitterId) : null,
      groupScore: this.groupScore,
      gameScore: this.gameScore,
    };
  }

  // Private payload for the ranker only (the 5 items in the neutral order).
  getRankerItems(playerId) {
    const r = this.currentRound();
    if (!r || playerId !== r.rankerId) return null;
    if (r.rankerOrder) return { alreadyRanked: true };
    return {
      round: this.roundIndex + 1,
      totalRounds: this.rounds.length,
      items: r.displayOrder.map((id) => r.items[id]),
    };
  }

  // DISCUSS broadcast (host + all non-ranker phones). Does NOT include the
  // ranker's secret order — that is sent privately to the ranker.
  getDiscussPublic() {
    const r = this.currentRound();
    if (!r) return null;
    return {
      round: this.roundIndex + 1,
      totalRounds: this.rounds.length,
      rankerId: r.rankerId,
      rankerName: this._nameOf(r.rankerId),
      submitterId: r.submitterId,
      submitterName: this._nameOf(r.submitterId),
      items: r.items.map((it) => ({ id: it.id, text: it.text })),
      consensusOrder: r.consensusOrder.slice(),
      groupScore: this.groupScore,
      gameScore: this.gameScore,
    };
  }

  // The ranker's own locked-in secret order — sent only to the ranker so they
  // can smugly watch the group guess.
  getRankerSecret(playerId) {
    const r = this.currentRound();
    if (!r || playerId !== r.rankerId || !r.rankerOrder) return null;
    return { rankerOrder: r.rankerOrder.slice() };
  }

  getConsensusPublic() {
    const r = this.currentRound();
    if (!r) return null;
    return { round: this.roundIndex + 1, consensusOrder: r.consensusOrder.slice() };
  }

  // Minimal payload for the pre-results "Let's see how the group did…" hold.
  getRevealTransitionPublic() {
    return {
      round: this.roundIndex + 1,
      totalRounds: this.rounds.length,
      readyAt: this.revealReadyAt,
      remainingMs: Math.max(0, this.revealReadyAt - Date.now()),
      serverNow: Date.now(),
    };
  }

  getRevealPublic() {
    const r = this.currentRound();
    if (!r || !r.result) return null;
    return {
      round: this.roundIndex + 1,
      totalRounds: this.rounds.length,
      rankerId: r.rankerId,
      rankerName: this._nameOf(r.rankerId),
      submitterId: r.submitterId,
      submitterName: this._nameOf(r.submitterId),
      items: r.items.map((it) => ({ id: it.id, text: it.text })),
      rankerOrder: r.rankerOrder.slice(),
      consensusOrder: r.consensusOrder.slice(),
      positions: r.result.positions.slice(),
      groupPts: r.result.groupPts,
      gamePts: r.result.gamePts,
      groupScore: this.groupScore,
      gameScore: this.gameScore,
      isLastRound: this.roundIndex >= this.rounds.length - 1,
      serverNow: Date.now(),
    };
  }

  getFinalPublic() {
    const recap = this.rounds.map((r, i) => ({
      round: i + 1,
      rankerName: this._nameOf(r.rankerId),
      submitterName: this._nameOf(r.submitterId),
      groupPts: r.result ? r.result.groupPts : 0,
      gamePts: r.result ? r.result.gamePts : ITEMS_PER_ROUND,
    }));
    return {
      groupScore: this.groupScore,
      gameScore: this.gameScore,
      playersWin: this.groupScore >= this.gameScore,
      totalRounds: this.rounds.length,
      recap,
    };
  }
}

module.exports = { Game, PHASES, MIN_PLAYERS, ITEMS_PER_ROUND, WORDS_PER_PLAYER, MAX_WORD_LEN };
