'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES, MIN_GOAL_TARGET, MAX_GOAL_TARGET, DEFAULT_GOAL_TARGET } = require('./game');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;

/**
 * Mount Sling Soccer onto the hub's Express app and HTTP server.
 *
 * Architecture note: the live match (top-down flick physics, turn resolution,
 * scoring) is simulated on the HOST browser so aim input travels player ->
 * server -> host in a single relay hop. This module is a thin relay + lobby
 * manager + turn gate. It MUST reuse the single shared Socket.IO Server cached
 * on the HTTP server (httpServer._triviaIo) — creating a second Server binds a
 * second engine.io upgrade handler and crashes on the first WebSocket upgrade.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountSlingSoccer(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;

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
      ns.emit('state:reset');
      broadcastLobby();
      console.log('[slingsoccer] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/slingsoccer/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'slingsoccer', 'host.html'));
  });
  app.get('/slingsoccer/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'slingsoccer', 'join.html'));
  });
  app.get('/slingsoccer/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'slingsoccer', 'player.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/slingsoccer/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/slingsoccer/join`,
      minGoalTarget: MIN_GOAL_TARGET,
      maxGoalTarget: MAX_GOAL_TARGET,
      defaultGoalTarget: DEFAULT_GOAL_TARGET,
    });
  });

  app.get('/api/slingsoccer/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#0f5132', light: '#FFFFFF' },
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
  const ns = io.of('/slingsoccer');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', game.getLobby());
  }

  // Only relay aim input from the socket whose player currently has the turn,
  // while a match is live. Keeps stray/other-player input off the host.
  function canAim(playerId) {
    return game.phase === PHASES.PLAYING && playerId && game.match.currentPlayerId === playerId;
  }

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
        player: { id: res.player.id, name: res.player.name, team: res.player.team },
        hostPresent: isHostPresent(),
        phase: game.phase,
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
        player: { id: res.player.id, name: res.player.name, team: res.player.team },
        phase: game.phase,
        hostPresent: isHostPresent(),
        lobby: game.getLobby(),
      };
      if (game.phase === PHASES.PLAYING || game.phase === PHASES.FINAL) {
        payload.match = game.getMatchMeta();
      }
      ack && ack(payload);
      if (game.phase === PHASES.PLAYING) ns.to(HOST_ROOM).emit('player:rejoined', { id: pid });
      broadcastLobby();
    });

    // ---- Aim relay (gated on whose turn it is) ----
    // The latency-critical path: forwarded straight to the host with the
    // player's id attached. Kept minimal.
    socket.on('aim:select', (msg) => {
      if (role !== 'player' || !canAim(playerId)) return;
      const t = msg && (msg.token | 0);
      if (!(t >= 0 && t < 5)) return;
      ns.to(HOST_ROOM).emit('aim:select', { id: playerId, token: t });
    });
    socket.on('aim:move', (msg) => {
      if (role !== 'player' || !canAim(playerId)) return;
      const dx = clampUnit(msg && msg.dx);
      const dy = clampUnit(msg && msg.dy);
      ns.to(HOST_ROOM).emit('aim:move', { id: playerId, dx, dy });
    });
    socket.on('aim:shoot', (msg) => {
      if (role !== 'player' || !canAim(playerId)) return;
      const dx = clampUnit(msg && msg.dx);
      const dy = clampUnit(msg && msg.dy);
      ns.to(HOST_ROOM).emit('aim:shoot', { id: playerId, dx, dy });
    });
    socket.on('aim:cancel', () => {
      if (role !== 'player' || !canAim(playerId)) return;
      ns.to(HOST_ROOM).emit('aim:cancel', { id: playerId });
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
        lobby: game.getLobby(),
        minGoalTarget: MIN_GOAL_TARGET,
        maxGoalTarget: MAX_GOAL_TARGET,
      };
      if (game.phase === PHASES.PLAYING || game.phase === PHASES.FINAL) {
        payload.match = game.getMatchMeta();
      }
      ack && ack(payload);
    });

    function requireHost(ack) {
      if (role !== 'host') {
        ack && ack({ ok: false, reason: 'not-host' });
        return false;
      }
      return true;
    }

    socket.on('host:setGoalTarget', ({ goalTarget } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setGoalTarget(goalTarget);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, goalTarget: game.goalTarget });
      broadcastLobby();
    });

    socket.on('host:assign', ({ playerId: pid, team, beforeId } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.assignTeam(pid, team, beforeId);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:kick', ({ playerId: pid } = {}, ack) => {
      if (!requireHost(ack)) return;
      const p = game.removePlayer(pid);
      if (!p) return ack && ack({ ok: false, reason: 'unknown-player' });
      if (p.socketId) ns.to(p.socketId).emit('player:rejected', { reason: 'kicked' });
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:addBot', (_p, ack) => {
      if (!requireHost(ack)) return;
      const res = game.addBot();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:start', (_p, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.startMatch();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, roster: res.roster, goalTarget: res.goalTarget });
      ns.emit('m:start', {
        goalTarget: res.goalTarget,
        roster: res.roster,
      });
    });

    // ---- Live match meta pushed by the host (rebroadcast to players) ----
    socket.on('host:turn', ({ team, playerId: pid, playerName, red, blue } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.setTurn({ team, playerId: pid, playerName, red, blue });
      ns.to(PLAYER_ROOM).emit('m:turn', {
        team: game.match.currentTeam,
        playerId: game.match.currentPlayerId,
        playerName: game.match.currentPlayerName,
        red: game.match.redScore,
        blue: game.match.blueScore,
        goalTarget: game.match.goalTarget,
      });
    });
    socket.on('host:board', ({ tokens, ball } = {}) => {
      if (role !== 'host') return;
      game.setBoard({ tokens, ball });
    });
    socket.on('host:countdown', ({ n } = {}) => {
      if (role !== 'host') return;
      ns.to(PLAYER_ROOM).emit('m:countdown', { n: n | 0 });
    });
    socket.on('host:goal', ({ team, red, blue } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.setScore(red, blue);
      ns.to(PLAYER_ROOM).emit('m:goal', { team, red: game.match.redScore, blue: game.match.blueScore });
    });
    socket.on('host:matchEnd', ({ winner, red, blue } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.endMatch({ winner, redScore: red, blueScore: blue });
      ns.to(PLAYER_ROOM).emit('m:end', {
        winner: game.match.winner,
        red: game.match.redScore,
        blue: game.match.blueScore,
      });
    });

    socket.on('host:reset', (_p, ack) => {
      if (!requireHost(ack)) return;
      const keepConfig = game.phase !== PHASES.LOBBY;
      game.reset(keepConfig);
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

    socket.on('disconnect', () => {
      if (role === 'player') {
        game.markDisconnected(socket.id);
        broadcastLobby();
        ns.to(HOST_ROOM).emit('player:dropped', { id: playerId });
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

  function clampUnit(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-1, Math.min(1, n));
  }
}

module.exports = mountSlingSoccer;
