'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES } = require('./game');
const { fetchQuestions, fetchCategories, TriviaApiError, prewarmToken } = require('./questions');

const HOST_ROOM = 'hosts';
const REACTION_COUNT = 6;
const REACTION_COOLDOWN_MS = 10 * 1000;
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Mount the Trivia game onto the hub's Express app and HTTP server.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountTrivia(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  // Warm the Open Trivia DB session token on boot so the first user-triggered
  // Start only needs a single API call (the token round-trip is the slow bit).
  prewarmToken();

  // ---------------- Game state ----------------
  let game = new Game();
  let reactionsMuted = false;
  let hostCount = 0;
  // Grace window: when the last host disconnects we wait this long before
  // declaring the host absent. Absorbs page reloads, brief network blips,
  // and the round-trip when the host clicks Hub. Long enough that normal
  // navigation never trips a false positive; short enough that a real
  // departure is detected quickly.
  const HOST_GRACE_MS = 15000;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  // Set true when the host explicitly clicks Hub. Forces isHostPresent() to
  // return false immediately, skipping the grace window. Cleared on the next
  // host:auth.
  let hostLeftIntentionally = false;
  function isHostPresent() {
    if (hostLeftIntentionally) return false;
    if (hostCount > 0) return true;
    return lastHostSeenAt > 0 && (Date.now() - lastHostSeenAt) < HOST_GRACE_MS;
  }
  function emitHostPresence(present) {
    // Broadcast to the entire namespace so the join page (which isn't in the
    // 'players' room yet) also receives the update.
    ns.emit('state:hostPresence', { present: !!present });
  }
  const lastReactionAt = new Map(); // playerId -> ms timestamp

  // Inactivity auto-reset
  let lastActivity = Date.now();
  function touchActivity() { lastActivity = Date.now(); }
  setInterval(() => {
    if (Date.now() - lastActivity >= INACTIVITY_RESET_MS) {
      game.reset();
      io.of('/trivia').emit('state:reset');
      console.log('[trivia] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- REST endpoints ----------------
  app.get('/api/trivia/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({ joinUrl: `${base}/trivia/join` });
  });

  app.get('/api/trivia/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#1A1A1A', light: '#FFFFFF' },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (e) {
      res.status(500).send('qr error');
    }
  });

  app.get('/api/trivia/categories', async (_req, res) => {
    try {
      const list = await fetchCategories();
      res.json({ categories: list });
    } catch (e) {
      res.status(502).json({ error: 'Could not fetch categories from Open Trivia DB.' });
    }
  });

  // ---------------- Socket.IO namespace ----------------
  // Attach Socket.IO to the shared HTTP server. Reuse a single Server across
  // calls (mountTrivia is only ever called once, but be defensive).
  if (!httpServer._triviaIo) {
    httpServer._triviaIo = new Server(httpServer, { cors: { origin: '*' } });
  }
  const io = httpServer._triviaIo;
  const ns = io.of('/trivia');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', {
      phase: game.phase,
      players: game.getLobbyPlayers(),
      total: game.players.size,
      questionsTotal: game.questions.length,
    });
  }
  function broadcastQuestion() {
    const q = game.getQuestionPublic();
    if (!q) return;
    ns.emit('state:question', q);
  }
  function broadcastIntro() {
    ns.emit('state:intro', game.getIntroPublic());
  }
  function broadcastPrompt() {
    const p = game.getPromptPublic();
    if (!p) return;
    ns.emit('state:prompt', p);
  }
  function broadcastReveal() {
    const q = game.getCurrentQuestion();
    if (!q) return;
    const payload = {
      questionId: q.id,
      index: game.currentIndex,
      total: game.questions.length,
      correctIndex: q.correctIndex,
      distribution: game.getAnswerDistribution(),
      leaderboardTop5: game.getLeaderboard(5),
      isLastQuestion: game.currentIndex === game.questions.length - 1,
      endReason: game.lastEndReason || 'host',
      autoAdvance: game.autoAdvanceMs > 0,
      revealEndsAt: game.revealEndsAt || 0,
      serverNow: Date.now(),
    };
    ns.emit('state:reveal', payload);
    for (const p of game.players.values()) {
      if (!p.socketId) continue;
      const result = game.getPlayerResult(p.id);
      if (result) ns.to(p.socketId).emit('player:result', result);
    }
  }
  function broadcastFinal() {
    const lb = game.getLeaderboard();
    ns.emit('state:final', { podium: lb.slice(0, 3), podiumGroups: game.getPodiumGroups(), fullLeaderboard: lb });
  }
  function broadcastAnswerCount() {
    ns.to(HOST_ROOM).emit('host:answerCount', {
      answered: game.answeredCount(),
      total: game.players.size,
    });
  }

  game.onQuestionTimeout = () => broadcastReveal();
  game.onIntroEnd = () => broadcastPrompt();
  game.onPromptEnd = () => broadcastQuestion();
  // Auto-advance: the reveal timer fired, progress to the next phase.
  game.onRevealEnd = () => { advanceAndBroadcast(); };

  // Advance the game one step and broadcast the resulting phase. Shared by
  // the host's manual "Next" button and the optional auto-advance timer.
  function advanceAndBroadcast() {
    const res = game.advance();
    if (!res.ok) return res;
    if (res.phase === PHASES.PROMPT) broadcastPrompt();
    else if (res.phase === PHASES.QUESTION) broadcastQuestion();
    else if (res.phase === PHASES.REVEAL) broadcastReveal();
    else if (res.phase === PHASES.FINAL) broadcastFinal();
    return res;
  }

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;

    // Anyone (join page, player page) can ask for current status to render
    // the right initial UI before any other events fire.
    socket.on('query:status', (_p, ack) => {
      ack && ack({
        hostPresent: isHostPresent(),
        phase: game.phase,
      });
    });

    // ---- Player flows ----
    socket.on('player:join', ({ playerId: pid, name }, ack) => {
      touchActivity();
      if (!pid || typeof pid !== 'string') return ack && ack({ ok: false, reason: 'bad-player-id' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.addPlayer({ playerId: pid, name, socketId: socket.id });
      if (!res.ok) return ack && ack(res);
      role = 'player';
      playerId = pid;
      socket.join('players');
      ack && ack({ ok: true, player: { id: res.player.id, name: res.player.name }, reactionsMuted, hostPresent: isHostPresent() });
      broadcastLobby();
    });

    socket.on('player:reconnect', ({ playerId: pid }, ack) => {
      if (!pid) return ack && ack({ ok: false, reason: 'bad-player-id' });
      const res = game.reconnectPlayer({ playerId: pid, socketId: socket.id });
      if (!res.ok) return ack && ack(res);
      role = 'player';
      playerId = pid;
      socket.join('players');
      const payload = {
        ok: true,
        player: { id: res.player.id, name: res.player.name, score: res.player.score },
        phase: game.phase,
        reactionsMuted,
        hostPresent: isHostPresent(),
        total: game.players.size,
      };
      if (game.phase === PHASES.INTRO) payload.intro = game.getIntroPublic();
      else if (game.phase === PHASES.PROMPT) payload.prompt = game.getPromptPublic();
      else if (game.phase === PHASES.QUESTION) {
        payload.question = game.getQuestionPublic();
        const q = game.getCurrentQuestion();
        if (q) {
          const ans = res.player.answers && res.player.answers.find((a) => a.questionId === q.id);
          if (ans) {
            payload.myChoiceIndex = ans.choiceIndex;
            payload.player.score = Math.max(0, (res.player.score || 0) - (ans.points || 0));
          }
        }
      } else if (game.phase === PHASES.REVEAL) {
        payload.myResult = game.getPlayerResult(pid);
      }
      ack && ack(payload);
      broadcastLobby();
    });

    socket.on('player:answer', ({ questionId, choiceIndex }, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.submitAnswer({ playerId, questionId, choiceIndex });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, locked: true });
      broadcastAnswerCount();
      if (game.phase === PHASES.REVEAL) broadcastReveal();
    });

    socket.on('player:reaction', ({ index }, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof index !== 'number' || index < 0 || index >= REACTION_COUNT) {
        return ack && ack({ ok: false, reason: 'bad-index' });
      }
      if (game.phase === PHASES.QUESTION || game.phase === PHASES.INTRO || game.phase === PHASES.PROMPT) {
        return ack && ack({ ok: false, reason: 'phase-closed' });
      }
      if (reactionsMuted) return ack && ack({ ok: false, reason: 'muted' });
      const now = Date.now();
      const last = lastReactionAt.get(playerId) || 0;
      if (now - last < REACTION_COOLDOWN_MS) {
        return ack && ack({
          ok: false,
          reason: 'cooldown',
          retryInMs: REACTION_COOLDOWN_MS - (now - last),
        });
      }
      lastReactionAt.set(playerId, now);
      ack && ack({ ok: true });
      ns.to(HOST_ROOM).emit('host:reaction', { index });
    });

    // ---- Host flows ----
    socket.on('host:auth', (_p, ack) => {
      role = 'host';
      socket.join(HOST_ROOM);
      // Cancel any pending "host left" broadcast — host is back.
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      const wasAbsent = !isHostPresent();
      hostLeftIntentionally = false; // host is here now
      hostCount += 1;
      lastHostSeenAt = Date.now();
      if (wasAbsent) emitHostPresence(true);
      ack && ack({
        ok: true,
        phase: game.phase,
        players: game.getLobbyPlayers(),
        questionsTotal: game.questions.length,
        currentIndex: game.currentIndex,
        reactionsMuted,
      });
      if (game.phase === PHASES.INTRO) {
        socket.emit('state:intro', game.getIntroPublic());
      } else if (game.phase === PHASES.PROMPT) {
        const p = game.getPromptPublic();
        if (p) socket.emit('state:prompt', p);
      } else if (game.phase === PHASES.QUESTION) {
        const q = game.getQuestionPublic();
        if (q) socket.emit('state:question', q);
        socket.emit('host:answerCount', {
          answered: game.answeredCount(),
          total: game.players.size,
        });
      } else if (game.phase === PHASES.REVEAL) {
        const q = game.getCurrentQuestion();
        const pub = game.getQuestionPublic();
        if (q && pub) {
          socket.emit('state:question', pub);
          socket.emit('state:reveal', {
            questionId: q.id,
            index: game.currentIndex,
            total: game.questions.length,
            correctIndex: q.correctIndex,
            distribution: game.getAnswerDistribution(),
            leaderboardTop5: game.getLeaderboard(5),
            isLastQuestion: game.currentIndex === game.questions.length - 1,
            endReason: 'replay',
          });
        }
      } else if (game.phase === PHASES.FINAL) {
        const lb = game.getLeaderboard();
        socket.emit('state:final', { podium: lb.slice(0, 3), podiumGroups: game.getPodiumGroups(), fullLeaderboard: lb });
      }
    });

    function requireHost(ack) {
      if (role !== 'host') {
        ack && ack({ ok: false, reason: 'not-host' });
        return false;
      }
      return true;
    }

    socket.on('host:start', async (payload, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const opts = payload || {};
      const amount = parseInt(opts.amount, 10) || 10;
      const timeLimitSec = parseInt(opts.timeLimitSec, 10) || 20;
      const category = opts.category ? String(opts.category) : null; // category slug or null
      const difficulty = opts.difficulty && ['easy', 'medium', 'hard'].includes(opts.difficulty)
        ? opts.difficulty
        : null;
      // Tell the host UI we're loading (some category combinations can take
      // a couple seconds, especially after a token reset).
      socket.emit('host:startLoading', { amount, category, difficulty });
      try {
        const list = await fetchQuestions({ amount, category, difficulty, timeLimitSec });
        game.setQuestions(list);
        const res = game.start({ autoAdvance: !!opts.autoAdvance });
        if (!res.ok) return ack && ack(res);
        ack && ack({ ok: true });
        broadcastLobby();
        broadcastIntro();
      } catch (e) {
        const msg = (e instanceof TriviaApiError)
          ? e.message
          : 'Could not load trivia questions. Please try again.';
        socket.emit('host:startError', { message: msg });
        ack && ack({ ok: false, reason: 'fetch-failed', message: msg });
      }
    });

    socket.on('host:next', (_p, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = advanceAndBroadcast();
      if (!res.ok) return ack && ack(res);
      if (res.phase === PHASES.PROMPT) ack && ack({ ok: true, advanced: 'prompt' });
      else if (res.phase === PHASES.QUESTION) ack && ack({ ok: true, advanced: 'question' });
      else if (res.phase === PHASES.REVEAL) ack && ack({ ok: true, advanced: 'reveal' });
      else if (res.phase === PHASES.FINAL) ack && ack({ ok: true, advanced: 'final' });
      else ack && ack({ ok: true });
    });

    socket.on('host:kick', ({ playerId: pid }, ack) => {
      if (!requireHost(ack)) return;
      const p = game.removePlayer(pid);
      if (!p) return ack && ack({ ok: false, reason: 'unknown-player' });
      if (p.socketId) ns.to(p.socketId).emit('player:rejected', { reason: 'kicked' });
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:reset', (_p, ack) => {
      if (!requireHost(ack)) return;
      game.reset();
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

    // Host clicked the Hub button. Reset the game AND immediately mark host
    // absent (skip grace window). We deliberately DO NOT emit state:reset to
    // players — they should just see the host-absent overlay covering the
    // page, not a "Game reset, rejoin?" screen first.
    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
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
            // Only fire if still absent after the grace window.
            if (!isHostPresent()) emitHostPresence(false);
          }, HOST_GRACE_MS);
        }
      }
    });
  });
}

module.exports = mountTrivia;
