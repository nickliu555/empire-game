'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES } = require('./game');
const { solveBoardWords } = require('./dictionary');
const { VALID_SIZES, DEFAULT_TIME_SEC, MIN_TIME_SEC, MAX_TIME_SEC, MIN_WORD_LEN, generateBoard } = require('./dice');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;
const REACTION_COUNT = 6;
const REACTION_COOLDOWN_MS = 10 * 1000;

/**
 * Mount the Boggle word game onto the hub's Express app and HTTP server.
 *
 * Architecture mirrors server/twentyfour/: a Socket.IO namespace at /noggle
 * for all real-time events, plus a couple of REST endpoints for QR/config.
 * IMPORTANT: reuses the single shared Socket.IO Server cached on the HTTP
 * server (httpServer._triviaIo) — creating a second Server binds a second
 * engine.io upgrade handler and crashes on the first WebSocket upgrade.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountBoggle(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  // ---------------- Game state ----------------
  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;
  let reactionsMuted = false;
  const lastReactionAt = new Map(); // playerId -> ms timestamp

  function isHostPresent() {
    if (hostLeftIntentionally) return false;
    if (hostCount > 0) return true;
    return lastHostSeenAt > 0 && (Date.now() - lastHostSeenAt) < HOST_GRACE_MS;
  }
  function emitHostPresence(present) {
    ns.emit('state:hostPresence', { present: !!present });
  }

  // Inactivity auto-reset.
  let lastActivity = Date.now();
  function touchActivity() { lastActivity = Date.now(); }
  setInterval(() => {
    if (Date.now() - lastActivity >= INACTIVITY_RESET_MS) {
      game.reset();
      reactionsMuted = false;
      lastReactionAt.clear();
      ns.emit('state:reset');
      console.log('[noggle] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/noggle/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'noggle', 'host.html'));
  });
  app.get('/noggle/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'noggle', 'join.html'));
  });
  app.get('/noggle/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'noggle', 'player.html'));
  });
  // Solo practice mode — no socket connection; the client hunts words on a
  // freshly shaken board with an open-ended (count-up) timer.
  app.get('/noggle/practice', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'noggle', 'practice.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/noggle/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/noggle/join`,
      sizes: VALID_SIZES,
      defaultTimeSec: DEFAULT_TIME_SEC,
      minTimeSec: MIN_TIME_SEC,
      maxTimeSec: MAX_TIME_SEC,
      minWordLen: MIN_WORD_LEN,
    });
  });

  // Solo practice: shake a fresh board and return it with the full solved word
  // list (word -> points) so the client can validate + reveal entirely offline.
  app.get('/api/noggle/practice/board', (req, res) => {
    let size = Number(req.query.size);
    if (!VALID_SIZES.includes(size)) size = VALID_SIZES[0];
    const minWordLen = MIN_WORD_LEN[size];
    const grid = generateBoard(size);
    const { words, totalWords, maxScore } = solveBoardWords(grid, minWordLen);
    res.json({ ok: true, size, minWordLen, grid, words, totalWords, maxScore });
  });

  app.get('/api/noggle/qr', async (req, res) => {
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

  // ---------------- Socket.IO namespace ----------------
  if (!httpServer._triviaIo) {
    httpServer._triviaIo = new Server(httpServer, { cors: { origin: '*' } });
  }
  const io = httpServer._triviaIo;
  const ns = io.of('/noggle');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', {
      phase: game.phase,
      players: game.getLobbyPlayers(),
      total: game.players.size,
    });
  }
  function broadcastIntro() {
    ns.emit('state:intro', game.getIntroPublic());
  }
  function broadcastRound() {
    ns.emit('state:round', game.getRoundPublic());
  }
  // Per-player word counts — host-only info during play (scores stay secret).
  function broadcastCounts() {
    ns.to(HOST_ROOM).emit('state:counts', { counts: game.getWordCounts() });
  }
  function broadcastFinal() {
    ns.emit('state:final', {
      podium: game.getPodium(),
      fullLeaderboard: game.getLeaderboard(),
      board: game.getBoardPublic(),
      stats: game.getFinalStats(),
    });
    // Per-player private recap (their own word list) so opponents can't read
    // it via DevTools. Disconnected players get it via the reconnect snapshot.
    for (const player of game.players.values()) {
      if (!player.socketId) continue;
      ns.to(player.socketId).emit('you:final', game.getPersonalFinal(player.id));
    }
  }

  // When the round timer fires server-side, switch everyone to FINAL.
  game.onRoundEnd = () => {
    broadcastFinal();
  };
  // When the pre-round INTRO countdown elapses, the board has just been shaken
  // and the round timer armed — push the round state so clients leave the
  // "Get ready" splash and see the board.
  game.onIntroEnd = () => {
    broadcastRound();
    broadcastCounts();
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
      ack && ack({
        ok: true,
        player: { id: res.player.id, name: res.player.name },
        hostPresent: isHostPresent(),
        phase: game.phase,
        reactionsMuted,
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
        player: { id: res.player.id, name: res.player.name },
        phase: game.phase,
        hostPresent: isHostPresent(),
        total: game.players.size,
        reactionsMuted,
      };
      if (game.phase === PHASES.INTRO) {
        payload.intro = game.getIntroPublic();
      } else if (game.phase === PHASES.ROUND) {
        payload.round = game.getRoundPublic();
        // Restore the player's own found words + running score.
        payload.you = {
          score: res.player.score,
          wordCount: res.player.wordCount,
          words: (res.player.foundWords || []).slice(),
        };
      } else if (game.phase === PHASES.FINAL) {
        payload.podium = game.getPodium();
        payload.fullLeaderboard = game.getLeaderboard();
        payload.board = game.getBoardPublic();
        payload.stats = game.getFinalStats();
        payload.youFinal = game.getPersonalFinal(pid);
      }
      ack && ack(payload);
      broadcastLobby();
    });

    socket.on('player:word', ({ path: cellPath } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.submitWord({ playerId, path: cellPath });
      if (!res.ok) return ack && ack(res);
      ack && ack(res);
      // Only a newly-accepted word changes a player's word count.
      if (res.accepted) broadcastCounts();
    });

    // ---- Host flows ----
    socket.on('host:auth', (_p, ack) => {
      role = 'host';
      socket.join(HOST_ROOM);
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      const wasAbsent = !isHostPresent();
      hostLeftIntentionally = false;
      hostCount += 1;
      lastHostSeenAt = Date.now();
      if (wasAbsent) emitHostPresence(true);
      const payload = {
        ok: true,
        phase: game.phase,
        players: game.getLobbyPlayers(),
        sizes: VALID_SIZES,
        defaultTimeSec: DEFAULT_TIME_SEC,
        minTimeSec: MIN_TIME_SEC,
        maxTimeSec: MAX_TIME_SEC,
        minWordLen: MIN_WORD_LEN,
        reactionsMuted,
      };
      if (game.phase === PHASES.INTRO) {
        payload.intro = game.getIntroPublic();
      } else if (game.phase === PHASES.ROUND) {
        payload.round = game.getRoundPublic();
        payload.counts = game.getWordCounts();
      } else if (game.phase === PHASES.FINAL) {
        payload.podium = game.getPodium();
        payload.fullLeaderboard = game.getLeaderboard();
        payload.board = game.getBoardPublic();
        payload.stats = game.getFinalStats();
      }
      ack && ack(payload);
      // Push the matching state event so a refreshed host lands on the right
      // screen.
      if (game.phase === PHASES.INTRO) {
        socket.emit('state:intro', game.getIntroPublic());
      } else if (game.phase === PHASES.ROUND) {
        socket.emit('state:round', game.getRoundPublic());
        socket.emit('state:counts', { counts: game.getWordCounts() });
      } else if (game.phase === PHASES.FINAL) {
        socket.emit('state:final', {
          podium: game.getPodium(),
          fullLeaderboard: game.getLeaderboard(),
          board: game.getBoardPublic(),
          stats: game.getFinalStats(),
        });
      }
    });

    function requireHost(ack) {
      if (role !== 'host') {
        ack && ack({ ok: false, reason: 'not-host' });
        return false;
      }
      return true;
    }

    socket.on('host:start', (payload, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const { boardSize, timeLimitSec } = payload || {};
      const res = game.start({
        boardSize: boardSize != null ? Number(boardSize) : undefined,
        timeLimitSec: timeLimitSec != null ? Number(timeLimitSec) : undefined,
      });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
      // Hold everyone on a "Get ready" countdown; the board + round state are
      // emitted from game.onIntroEnd when the intro timer elapses.
      broadcastIntro();
    });

    socket.on('host:kick', ({ playerId: pid } = {}, ack) => {
      if (!requireHost(ack)) return;
      const p = game.removePlayer(pid);
      if (!p) return ack && ack({ ok: false, reason: 'unknown-player' });
      if (p.socketId) ns.to(p.socketId).emit('player:rejected', { reason: 'kicked' });
      ack && ack({ ok: true });
      broadcastLobby();
      if (game.phase === PHASES.ROUND) broadcastCounts();
    });

    socket.on('host:reset', (_p, ack) => {
      if (!requireHost(ack)) return;
      game.reset();
      reactionsMuted = false;
      lastReactionAt.clear();
      ack && ack({ ok: true });
      ns.emit('state:reset');
      ns.emit('state:reactionsMuted', { muted: reactionsMuted });
      broadcastLobby();
    });

    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
      game.reset();
      reactionsMuted = false;
      lastReactionAt.clear();
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

    // Host-only: reveal every findable word on the frozen final board. Solved
    // lazily (and cached) so we don't compute a potentially huge 6x6 list until
    // the host actually asks for it.
    socket.on('host:solveBoard', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (game.phase !== PHASES.FINAL) {
        return ack && ack({ ok: false, reason: 'not-final' });
      }
      const solved = game.getSolvedWords();
      ack && ack({ ok: true, ...solved });
    });

    // Player reactions: relayed to the host as floating emoji. Gated to
    // lobby + final phases (the round itself is heads-down word hunting).
    socket.on('player:reaction', ({ index } = {}, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof index !== 'number' || index < 0 || index >= REACTION_COUNT) {
        return ack && ack({ ok: false, reason: 'bad-index' });
      }
      if (game.phase !== PHASES.LOBBY && game.phase !== PHASES.FINAL) {
        return ack && ack({ ok: false, reason: 'phase-closed' });
      }
      if (reactionsMuted) return ack && ack({ ok: false, reason: 'muted' });
      const now = Date.now();
      const last = lastReactionAt.get(playerId) || 0;
      if (now - last < REACTION_COOLDOWN_MS) {
        return ack && ack({
          ok: false, reason: 'cooldown',
          retryInMs: REACTION_COOLDOWN_MS - (now - last),
        });
      }
      lastReactionAt.set(playerId, now);
      ack && ack({ ok: true });
      ns.to(HOST_ROOM).emit('host:reaction', { index });
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

module.exports = mountBoggle;
