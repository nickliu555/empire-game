'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES, CATEGORIES_PER_ROUND } = require('./game');
const { buildCategoryReview } = require('./grouping');
const categories = require('./categories');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const REACTION_COUNT = 6;
const REACTION_COOLDOWN_MS = 10 * 1000;
const INACTIVITY_RESET_MS = 60 * 60 * 1000;
const HOST_GRACE_MS = 15000;

/**
 * Mount the Category Clash game onto the hub's Express app and HTTP server.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountCatClash(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');
  const GROQ_KEY = process.env.GROQ_API_KEY || null;

  // ---------------- Game state ----------------
  let game = new Game();
  let reactionsMuted = false;
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;
  const lastReactionAt = new Map();
  // Guards against a stale async grouping result overwriting a newer round.
  let reviewToken = 0;

  function isHostPresent() {
    if (hostLeftIntentionally) return false;
    if (hostCount > 0) return true;
    return lastHostSeenAt > 0 && (Date.now() - lastHostSeenAt) < HOST_GRACE_MS;
  }
  function emitHostPresence(present) {
    ns.emit('state:hostPresence', { present: !!present });
  }

  let lastActivity = Date.now();
  function touchActivity() { lastActivity = Date.now(); }
  setInterval(() => {
    if (Date.now() - lastActivity >= INACTIVITY_RESET_MS) {
      reviewToken++;
      game.reset();
      ns.emit('state:reset');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  const pub = (f) => path.join(__dirname, '..', '..', 'public', 'catclash', f);
  app.get('/catclash/host', (_req, res) => res.sendFile(pub('host.html')));
  app.get('/catclash/join', (_req, res) => res.sendFile(pub('join.html')));
  app.get('/catclash/play', (_req, res) => res.sendFile(pub('player.html')));

  // ---------------- REST endpoints ----------------
  app.get('/api/catclash/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/catclash/join`,
      categoriesTotal: categories.count(),
      categoriesPerRound: CATEGORIES_PER_ROUND,
      letters: categories.LETTERS,
    });
  });

  app.get('/api/catclash/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, width: 320,
        color: { dark: '#3A1D12', light: '#FFFFFF' },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (e) {
      res.status(500).send('qr error');
    }
  });

  // ---------------- Socket.IO namespace ----------------
  // Reuse the single Socket.IO Server shared by all games (attaching a second
  // Server to the same HTTP server breaks WebSocket upgrades). Each game just
  // adds its own namespace.
  if (!httpServer._triviaIo) {
    httpServer._triviaIo = new Server(httpServer, { cors: { origin: '*' } });
  }
  const io = httpServer._triviaIo;
  const ns = io.of('/catclash');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', {
      phase: game.phase,
      players: game.getLobbyPlayers(),
      total: game.players.size,
    });
  }
  function broadcastIntro() { ns.emit('state:intro', game.getIntroPublic()); }
  function broadcastRound() { ns.emit('state:round', game.getRoundPublic()); }
  function broadcastReviewing() { ns.emit('state:reviewing', game.getReviewingPublic()); }
  function sendReviewToHost(target) {
    (target || ns.to(HOST_ROOM)).emit('state:review', game.getReviewPublic());
  }
  function broadcastReviewProgress() {
    ns.to(PLAYER_ROOM).emit('state:reviewProgress', game.getReviewProgressPublic());
  }
  function broadcastReveal() {
    ns.emit('state:reveal', game.getRevealPublic());
    for (const p of game.players.values()) {
      if (!p.socketId) continue;
      const r = game.getPlayerResult(p.id);
      if (r) ns.to(p.socketId).emit('player:result', r);
    }
  }
  function broadcastFinal() { ns.emit('state:final', game.getFinalPublic()); }
  function broadcastProgress() {
    ns.to(HOST_ROOM).emit('host:progress', game.getProgressPublic());
  }

  // Bucket + validity-check all 12 categories (async; may hit Groq), then push
  // the first category's review screen to the host.
  async function startReview() {
    const myToken = ++reviewToken;
    broadcastReviewing();
    const letter = game.letter;
    const cats = game.categories.slice();
    let reviews = [];
    try {
      reviews = await Promise.all(cats.map((cat, i) => buildCategoryReview({
        category: cat.text,
        letter,
        submissions: game.collectCategory(i),
        groqKey: GROQ_KEY,
      }).catch(() => ({ buckets: [], invalid: [] }))));
    } catch (_) {
      reviews = cats.map(() => ({ buckets: [], invalid: [] }));
    }
    // Round changed (reset / next round) while we were grouping — drop it.
    if (myToken !== reviewToken || game.phase !== PHASES.REVIEWING) return;
    const res = game.setCategoryReviews(reviews);
    if (!res.ok) return;
    sendReviewToHost();
    broadcastReviewProgress();
  }

  game.onIntroEnd = () => broadcastRound();
  game.onRoundEnd = () => { startReview(); };

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;

    socket.on('query:status', (_p, ack) => {
      ack && ack({ hostPresent: isHostPresent(), phase: game.phase });
    });

    // ---- Player flows ----
    socket.on('player:join', ({ playerId: pid, name } = {}, ack) => {
      touchActivity();
      if (!pid || typeof pid !== 'string') return ack && ack({ ok: false, reason: 'bad-player-id' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.addPlayer({ playerId: pid, name, socketId: socket.id });
      if (!res.ok) return ack && ack(res);
      role = 'player';
      playerId = pid;
      socket.join(PLAYER_ROOM);
      ack && ack({
        ok: true,
        player: { id: res.player.id, name: res.player.name },
        reactionsMuted,
        hostPresent: isHostPresent(),
      });
      broadcastLobby();
    });

    socket.on('player:reconnect', ({ playerId: pid } = {}, ack) => {
      if (!pid) return ack && ack({ ok: false, reason: 'bad-player-id' });
      const res = game.reconnectPlayer({ playerId: pid, socketId: socket.id });
      if (!res.ok) return ack && ack(res);
      role = 'player';
      playerId = pid;
      socket.join(PLAYER_ROOM);
      const payload = {
        ok: true,
        player: { id: res.player.id, name: res.player.name, score: res.player.score },
        phase: game.phase,
        reactionsMuted,
        hostPresent: isHostPresent(),
        total: game.players.size,
      };
      if (game.phase === PHASES.INTRO) payload.intro = game.getIntroPublic();
      else if (game.phase === PHASES.ROUND) {
        payload.round = game.getRoundPublic();
        payload.myAnswers = game.getPlayerAnswers(pid);
        payload.myDone = res.player.doneRound === game.roundIndex;
      } else if (game.phase === PHASES.REVIEWING) {
        payload.reviewing = game.getReviewingPublic();
      } else if (game.phase === PHASES.REVIEW) {
        payload.reviewing = game.getReviewingPublic();
        payload.reviewProgress = game.getReviewProgressPublic();
      } else if (game.phase === PHASES.REVEAL) {
        payload.myResult = game.getPlayerResult(pid);
      }
      ack && ack(payload);
      broadcastLobby();
    });

    socket.on('player:answer', ({ catIdx, text } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.submitAnswer({ playerId, catIdx, text });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, catIdx: res.catIdx, answer: res.answer });
      broadcastProgress();
    });

    socket.on('player:done', ({ done } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.setDone({ playerId, done: !!done });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, done: res.done });
      broadcastProgress();
      // If that ended the round, onRoundEnd already kicked off the review.
    });

    socket.on('player:reaction', ({ index } = {}, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof index !== 'number' || index < 0 || index >= REACTION_COUNT) {
        return ack && ack({ ok: false, reason: 'bad-index' });
      }
      if (game.phase === PHASES.INTRO || game.phase === PHASES.ROUND) {
        return ack && ack({ ok: false, reason: 'phase-closed' });
      }
      if (reactionsMuted) return ack && ack({ ok: false, reason: 'muted' });
      const now = Date.now();
      const last = lastReactionAt.get(playerId) || 0;
      if (now - last < REACTION_COOLDOWN_MS) {
        return ack && ack({ ok: false, reason: 'cooldown', retryInMs: REACTION_COOLDOWN_MS - (now - last) });
      }
      lastReactionAt.set(playerId, now);
      ack && ack({ ok: true });
      ns.to(HOST_ROOM).emit('host:reaction', { index });
    });

    // ---- Host flows ----
    function requireHost(ack) {
      if (role !== 'host') { ack && ack({ ok: false, reason: 'not-host' }); return false; }
      return true;
    }

    socket.on('host:auth', (_p, ack) => {
      role = 'host';
      socket.join(HOST_ROOM);
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      const wasAbsent = !isHostPresent();
      hostLeftIntentionally = false;
      hostCount += 1;
      lastHostSeenAt = Date.now();
      if (wasAbsent) emitHostPresence(true);
      ack && ack({
        ok: true,
        phase: game.phase,
        players: game.getLobbyPlayers(),
        categoriesTotal: categories.count(),
        categoriesPerRound: CATEGORIES_PER_ROUND,
        reactionsMuted,
        totalRounds: game.totalRounds,
        timeLimitSec: game.timeLimitSec,
        aiEnabled: !!GROQ_KEY,
      });
      if (game.phase === PHASES.INTRO) socket.emit('state:intro', game.getIntroPublic());
      else if (game.phase === PHASES.ROUND) {
        socket.emit('state:round', game.getRoundPublic());
        socket.emit('host:progress', game.getProgressPublic());
      } else if (game.phase === PHASES.REVIEWING) {
        socket.emit('state:reviewing', game.getReviewingPublic());
      } else if (game.phase === PHASES.REVIEW) {
        sendReviewToHost(socket);
      } else if (game.phase === PHASES.REVEAL) {
        socket.emit('state:reveal', game.getRevealPublic());
      } else if (game.phase === PHASES.FINAL) {
        socket.emit('state:final', game.getFinalPublic());
      }
    });

    socket.on('host:start', (payload = {}, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.start({
        rounds: payload.rounds,
        timeLimitSec: payload.timeLimitSec,
      });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
      broadcastIntro();
    });

    socket.on('host:next', (_p, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.advance();
      if (!res.ok) return ack && ack(res);
      // ROUND→REVIEWING fires onRoundEnd (startReview) internally.
      if (res.phase === PHASES.ROUND) broadcastRound();
      else if (res.phase === PHASES.INTRO) broadcastIntro();
      else if (res.phase === PHASES.FINAL) broadcastFinal();
      ack && ack({ ok: true, phase: res.phase });
    });

    socket.on('host:scoreCategory', ({ catIdx, buckets, invalid } = {}, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.scoreCategory({ catIdx, buckets, invalid });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, done: !!res.done });
      if (res.done) {
        broadcastReveal();
      } else {
        sendReviewToHost();
        broadcastReviewProgress();
      }
    });

    socket.on('host:kick', ({ playerId: pid } = {}, ack) => {
      if (!requireHost(ack)) return;
      if (game.phase !== PHASES.LOBBY) return ack && ack({ ok: false, reason: 'lobby-only' });
      const p = game.removePlayer(pid);
      if (!p) return ack && ack({ ok: false, reason: 'unknown-player' });
      if (p.socketId) ns.to(p.socketId).emit('player:rejected', { reason: 'kicked' });
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:reset', (_p, ack) => {
      if (!requireHost(ack)) return;
      reviewToken++;
      game.reset();
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
      reviewToken++;
      game.reset();
      hostLeftIntentionally = true;
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      emitHostPresence(false);
      ack && ack({ ok: true });
    });

    socket.on('host:setReactionsMuted', ({ muted } = {}, ack) => {
      if (!requireHost(ack)) return;
      reactionsMuted = !!muted;
      ack && ack({ ok: true, reactionsMuted });
      ns.emit('state:reactionsMuted', { muted: reactionsMuted });
    });

    socket.on('disconnect', () => {
      if (role === 'player') {
        game.markDisconnected(socket.id);
        broadcastLobby();
      } else if (role === 'host') {
        hostCount = Math.max(0, hostCount - 1);
        lastHostSeenAt = Date.now();
        if (hostCount === 0) {
          if (hostGraceTimer) clearTimeout(hostGraceTimer);
          hostGraceTimer = setTimeout(() => {
            hostGraceTimer = null;
            if (!isHostPresent()) emitHostPresence(false);
          }, HOST_GRACE_MS);
        }
      }
    });
  });
}

module.exports = mountCatClash;
