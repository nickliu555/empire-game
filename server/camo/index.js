'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES, MIN_PLAYERS, MAX_PLAYERS } = require('./game');
const topics = require('./topics');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const REACTION_COUNT = 6;
const REACTION_COOLDOWN_MS = 10 * 1000;
const INACTIVITY_RESET_MS = 60 * 60 * 1000;
const HOST_GRACE_MS = 15000;

/**
 * Mount the Camo game onto the hub's Express app and HTTP server.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountCamo(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  // ---------------- Game state ----------------
  let game = new Game();
  let reactionsMuted = false;
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;
  const lastReactionAt = new Map();

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
  const pub = (f) => path.join(__dirname, '..', '..', 'public', 'camo', f);
  app.get('/camo/host', (_req, res) => res.sendFile(pub('host.html')));
  app.get('/camo/join', (_req, res) => res.sendFile(pub('join.html')));
  app.get('/camo/play', (_req, res) => res.sendFile(pub('player.html')));

  // ---------------- REST endpoints ----------------
  app.get('/api/camo/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({ joinUrl: `${base}/camo/join`, topicsTotal: topics.count(), maxPlayers: MAX_PLAYERS });
  });

  app.get('/api/camo/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, width: 320,
        color: { dark: '#2A1B3D', light: '#FFFFFF' },
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
  // Server to the same HTTP server breaks WebSocket upgrades).
  if (!httpServer._triviaIo) {
    httpServer._triviaIo = new Server(httpServer, { cors: { origin: '*' } });
  }
  const io = httpServer._triviaIo;
  const ns = io.of('/camo');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', {
      phase: game.phase,
      players: game.getLobbyPlayers(),
      total: game.players.size,
      max: MAX_PLAYERS,
    });
  }
  function broadcastIntro() { ns.emit('state:intro', game.getIntroPublic()); }

  // The grid is public; the secret word goes to one socket at a time.
  function broadcastRole() {
    ns.emit('state:role', game.getRolePublic());
    sendRoles();
  }
  function sendRoles(target) {
    for (const p of game.players.values()) {
      if (!p.socketId || !p.connected) continue;
      if (target && p.socketId !== target) continue;
      const priv = game.getRolePrivate(p.id);
      if (priv) ns.to(p.socketId).emit('you:role', priv);
    }
  }
  function broadcastClues() { ns.emit('state:clues', game.getCluesPublic()); }
  function broadcastDiscuss() { ns.emit('state:discuss', game.getDiscussPublic()); }
  function broadcastVote() { ns.emit('state:vote', game.getVotePublic()); }
  function broadcastGuess() { ns.emit('state:guess', game.getGuessPublic()); }
  function broadcastReveal() {
    ns.emit('state:reveal', game.getRevealPublic());
    for (const p of game.players.values()) {
      if (!p.socketId) continue;
      const r = game.getPlayerResult(p.id);
      if (r) ns.to(p.socketId).emit('player:result', r);
    }
  }
  function broadcastFinal() { ns.emit('state:final', game.getFinalPublic()); }
  function broadcastRoleAckCount() {
    ns.to(HOST_ROOM).emit('host:roleAckCount', {
      acked: game.roleAckedCount(), total: game.rosterCount(),
    });
  }
  function broadcastVoteCount() {
    ns.to(HOST_ROOM).emit('host:voteCount', {
      voted: game.votedCount(), total: game.rosterCount(),
    });
  }

  // Push whatever screen the current phase calls for.
  function broadcastPhase(phase) {
    if (phase === PHASES.ROLE) broadcastRole();
    else if (phase === PHASES.CLUES) broadcastClues();
    else if (phase === PHASES.DISCUSS) broadcastDiscuss();
    else if (phase === PHASES.VOTE) broadcastVote();
    else if (phase === PHASES.GUESS) broadcastGuess();
    else if (phase === PHASES.REVEAL) broadcastReveal();
    else if (phase === PHASES.FINAL) broadcastFinal();
  }

  game.onIntroEnd = () => broadcastRole();
  game.onRoleEnd = () => broadcastClues();
  game.onRevealEnd = () => {
    const res = game.advanceReveal();
    if (!res.ok) return;
    broadcastPhase(res.phase);
  };

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;

    socket.on('query:status', (_p, ack) => {
      ack && ack({
        hostPresent: isHostPresent(),
        phase: game.phase,
        full: game.players.size >= MAX_PLAYERS,
      });
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
        target: game.targetScore,
      };
      if (game.phase === PHASES.INTRO) payload.intro = game.getIntroPublic();
      else if (game.phase === PHASES.ROLE) {
        payload.role = game.getRolePublic();
        payload.myRole = game.getRolePrivate(pid);
        payload.acked = res.player.roleAckRound === game.roundIndex;
      } else if (game.phase === PHASES.CLUES) {
        payload.clues = game.getCluesPublic();
        payload.myRole = game.getRolePrivate(pid);
      } else if (game.phase === PHASES.DISCUSS) {
        payload.discuss = game.getDiscussPublic();
        payload.myRole = game.getRolePrivate(pid);
      } else if (game.phase === PHASES.VOTE) {
        payload.vote = game.getVotePublic();
        payload.myRole = game.getRolePrivate(pid);
        payload.myVote = res.player.votedRound === game.roundIndex ? res.player.votedFor : null;
      } else if (game.phase === PHASES.GUESS) {
        payload.guess = game.getGuessPublic();
      } else if (game.phase === PHASES.REVEAL) {
        payload.reveal = game.getRevealPublic();
        payload.myResult = game.getPlayerResult(pid);
      } else if (game.phase === PHASES.FINAL) {
        payload.final = game.getFinalPublic();
      }
      ack && ack(payload);
      broadcastLobby();
      if (game.phase === PHASES.ROLE) broadcastRoleAckCount();
      if (game.phase === PHASES.VOTE) broadcastVoteCount();
    });

    socket.on('player:roleAck', (_p, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.ackRole({ playerId });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, acked: res.acked, total: res.total });
      broadcastRoleAckCount();
      // _endRole fires onRoleEnd → broadcastClues.
    });

    socket.on('player:clueDone', (_p, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.clueDone({ playerId });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, phase: res.phase });
      broadcastPhase(res.phase);
    });

    socket.on('player:vote', ({ targetId } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.castVote({ playerId, targetId });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, targetId: res.targetId, voted: res.voted, total: res.total });
      broadcastVoteCount();
      if (res.closed) broadcastPhase(res.phase);
    });

    socket.on('player:guess', ({ wordIndex } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.submitGuess({ playerId, wordIndex });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastReveal();
    });

    socket.on('player:reaction', ({ index } = {}, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof index !== 'number' || index < 0 || index >= REACTION_COUNT) {
        return ack && ack({ ok: false, reason: 'bad-index' });
      }
      if (game.phase === PHASES.INTRO || game.phase === PHASES.ROLE) {
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
        topicsTotal: topics.count(),
        reactionsMuted,
        target: game.targetScore,
        minPlayers: MIN_PLAYERS,
        maxPlayers: MAX_PLAYERS,
      });
      if (game.phase === PHASES.INTRO) socket.emit('state:intro', game.getIntroPublic());
      else if (game.phase === PHASES.ROLE) {
        socket.emit('state:role', game.getRolePublic());
        socket.emit('host:roleAckCount', { acked: game.roleAckedCount(), total: game.rosterCount() });
      } else if (game.phase === PHASES.CLUES) socket.emit('state:clues', game.getCluesPublic());
      else if (game.phase === PHASES.DISCUSS) socket.emit('state:discuss', game.getDiscussPublic());
      else if (game.phase === PHASES.VOTE) {
        socket.emit('state:vote', game.getVotePublic());
        socket.emit('host:voteCount', { voted: game.votedCount(), total: game.rosterCount() });
      } else if (game.phase === PHASES.GUESS) socket.emit('state:guess', game.getGuessPublic());
      else if (game.phase === PHASES.REVEAL) socket.emit('state:reveal', game.getRevealPublic());
      else if (game.phase === PHASES.FINAL) socket.emit('state:final', game.getFinalPublic());
    });

    socket.on('host:start', (payload = {}, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.start({
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
      ack && ack({ ok: true, phase: res.phase });
      broadcastPhase(res.phase);
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
      game.reset();
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

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
        const gone = game.markDisconnected(socket.id);
        broadcastLobby();
        if (!gone) return;
        // The roster is fixed once the game starts, so a drop never shrinks a
        // total. Only the speaking order needs a nudge, or the round dead-ends
        // on someone who can no longer take their turn.
        if (game.phase === PHASES.CLUES && game.currentSpeakerId() === gone.id) {
          const res = game.skipTurn();
          if (res.ok) broadcastPhase(res.phase);
        }
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

module.exports = mountCamo;
