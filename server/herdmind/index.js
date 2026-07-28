'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES } = require('./game');
const { buildGroups } = require('./grouping');
const questions = require('./questions');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const REACTION_COUNT = 6;
const REACTION_COOLDOWN_MS = 10 * 1000;
const INACTIVITY_RESET_MS = 60 * 60 * 1000;
const HOST_GRACE_MS = 15000;

/**
 * Mount the Herd Mind game onto the hub's Express app and HTTP server.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountHerdMind(app, httpServer, opts) {
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
      game.reset();
      ns.emit('state:reset');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  const pub = (f) => path.join(__dirname, '..', '..', 'public', 'herdmind', f);
  app.get('/herdmind/host', (_req, res) => res.sendFile(pub('host.html')));
  app.get('/herdmind/join', (_req, res) => res.sendFile(pub('join.html')));
  app.get('/herdmind/play', (_req, res) => res.sendFile(pub('player.html')));

  // ---------------- REST endpoints ----------------
  app.get('/api/herdmind/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({ joinUrl: `${base}/herdmind/join`, questionsTotal: questions.count() });
  });

  app.get('/api/herdmind/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, width: 320,
        color: { dark: '#3B2A22', light: '#FFFFFF' },
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
  const ns = io.of('/herdmind');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', {
      phase: game.phase,
      players: game.getLobbyPlayers(),
      total: game.players.size,
    });
  }
  function broadcastIntro() { ns.emit('state:intro', game.getIntroPublic()); }
  function broadcastQuestion() {
    const q = game.getQuestionPublic();
    if (q) ns.emit('state:question', q);
  }
  function broadcastReviewing() {
    ns.emit('state:reviewing', { round: game.roundIndex });
  }
  function sendReviewToHost(target) {
    (target || ns.to(HOST_ROOM)).emit('state:review', game.getReviewPublic());
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
  function broadcastAnswerCount() {
    ns.to(HOST_ROOM).emit('host:answerCount', {
      answered: game.answeredCount(),
      total: game.players.size,
    });
  }

  // Build answer groups (async; may hit Groq) then push the review screen.
  async function startReview() {
    const myToken = ++reviewToken;
    broadcastReviewing();
    let groups = [];
    try {
      groups = await buildGroups(game.collectSubmissions(), { groqKey: GROQ_KEY });
    } catch (_) { groups = []; }
    // Round changed (reset / new question) while we were grouping — drop it.
    if (myToken !== reviewToken || game.phase !== PHASES.REVIEW) return;
    game.setGroups(groups);
    sendReviewToHost();
  }

  game.onIntroEnd = () => broadcastQuestion();
  game.onQuestionEnd = () => { startReview(); };
  game.onRevealEnd = () => {
    const res = game.advanceReveal();
    if (!res.ok) return;
    if (res.phase === PHASES.QUESTION) broadcastQuestion();
    else if (res.phase === PHASES.FINAL) broadcastFinal();
  };

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
      ack && ack({ ok: true, player: { id: res.player.id, name: res.player.name }, reactionsMuted, hostPresent: isHostPresent() });
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
        target: game.targetScore,
        hasCow: game.cowHolderId === pid,
      };
      if (game.phase === PHASES.INTRO) payload.intro = game.getIntroPublic();
      else if (game.phase === PHASES.QUESTION) {
        payload.question = game.getQuestionPublic();
        if (res.player.answeredRound === game.roundIndex) payload.myAnswer = res.player.roundAnswer;
      } else if (game.phase === PHASES.REVIEW) payload.reviewing = { round: game.roundIndex };
      else if (game.phase === PHASES.REVEAL) payload.myResult = game.getPlayerResult(pid);
      ack && ack(payload);
      broadcastLobby();
    });

    socket.on('player:answer', ({ questionId, answer } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.submitAnswer({ playerId, questionId, answer });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, locked: true, answer: res.answer });
      broadcastAnswerCount();
      // If that submission ended the question, kick off review.
      if (game.phase === PHASES.REVIEW) { /* onQuestionEnd already fired */ }
    });

    socket.on('player:reaction', ({ index } = {}, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof index !== 'number' || index < 0 || index >= REACTION_COUNT) {
        return ack && ack({ ok: false, reason: 'bad-index' });
      }
      if (game.phase === PHASES.QUESTION || game.phase === PHASES.INTRO || game.phase === PHASES.REVIEW) {
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
        questionsTotal: questions.count(),
        reactionsMuted,
        target: game.targetScore,
        timeLimitSec: game.timeLimitSec,
      });
      if (game.phase === PHASES.INTRO) socket.emit('state:intro', game.getIntroPublic());
      else if (game.phase === PHASES.QUESTION) {
        const q = game.getQuestionPublic();
        if (q) socket.emit('state:question', q);
        socket.emit('host:answerCount', { answered: game.answeredCount(), total: game.players.size });
      } else if (game.phase === PHASES.REVIEW) {
        if (game.currentGroups) sendReviewToHost(socket);
        else socket.emit('state:reviewing', { round: game.roundIndex });
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
        timeLimitSec: payload.timeLimitSec,
        targetScore: payload.targetScore,
        autoAdvance: !!payload.autoAdvance,
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
      // QUESTION→REVIEW fires onQuestionEnd (startReview) internally.
      if (res.phase === PHASES.QUESTION) broadcastQuestion();
      else if (res.phase === PHASES.FINAL) broadcastFinal();
      ack && ack({ ok: true, phase: res.phase });
    });

    socket.on('host:score', ({ groups } = {}, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.scoreRound(groups);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastReveal();
    });

    socket.on('host:kick', ({ playerId: pid } = {}, ack) => {
      if (!requireHost(ack)) return;
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

module.exports = mountHerdMind;
