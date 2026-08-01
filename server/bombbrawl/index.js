'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const {
  Game,
  PHASES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MIN_ROUND_SEC,
  MAX_ROUND_SEC,
  DEFAULT_ROUND_SEC,
  MIN_ROUNDS_TO_WIN,
  MAX_ROUNDS_TO_WIN,
  DEFAULT_ROUNDS_TO_WIN,
  BOT_DIFFICULTIES,
} = require('./game');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;

/**
 * Mount Bomb Brawl onto the hub's Express app and HTTP server.
 *
 * The live game runs on the HOST browser; this module is a thin relay + lobby
 * manager + match-meta cache. It MUST reuse the single shared Socket.IO Server
 * cached on the HTTP server (httpServer._triviaIo) — creating a second Server
 * binds a second engine.io upgrade handler and crashes on the first WebSocket
 * upgrade.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountBombBrawl(app, httpServer, opts) {
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
      console.log('[bombbrawl] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/bombbrawl/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'bombbrawl', 'host.html'));
  });
  app.get('/bombbrawl/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'bombbrawl', 'join.html'));
  });
  app.get('/bombbrawl/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'bombbrawl', 'player.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/bombbrawl/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/bombbrawl/join`,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      minRoundSec: MIN_ROUND_SEC,
      maxRoundSec: MAX_ROUND_SEC,
      defaultRoundSec: DEFAULT_ROUND_SEC,
      minRoundsToWin: MIN_ROUNDS_TO_WIN,
      maxRoundsToWin: MAX_ROUNDS_TO_WIN,
      defaultRoundsToWin: DEFAULT_ROUNDS_TO_WIN,
      botDifficulties: BOT_DIFFICULTIES,
    });
  });

  app.get('/api/bombbrawl/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#171233', light: '#FFFFFF' },
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
  const ns = io.of('/bombbrawl');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', game.getLobby());
  }

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;

    socket.on('query:status', (_p, ack) => {
      ack && ack({
        hostPresent: isHostPresent(),
        phase: game.phase,
        total: game.players.size,
        capacity: game.capacity(),
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
        player: { id: res.player.id, name: res.player.name },
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

    // True while this socket's bomber may act: the match is live, not paused,
    // and they haven't been blown up yet this round.
    function controlsActive() {
      if (role !== 'player' || !playerId) return false;
      if (game.phase !== PHASES.PLAYING || !game.match.live) return false;
      if (game.match.paused) return false;
      if (game.match.alive && game.match.alive[playerId] === false) return false;
      return true;
    }

    // Thumbstick relay: forwarded straight to the host with the player's id
    // attached. x/y are a normalised direction vector (-1..1 each).
    socket.on('in', (msg) => {
      if (!controlsActive()) return;
      const x = msg && Number(msg.x);
      const y = msg && Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      ns.to(HOST_ROOM).emit('in', {
        id: playerId,
        x: Math.max(-1, Math.min(1, x)),
        y: Math.max(-1, Math.min(1, y)),
      });
    });

    // Discrete "drop a bomb" press. The host decides whether the bomber
    // actually has a bomb left and whether the tile is free.
    socket.on('bomb', () => {
      if (!controlsActive()) return;
      ns.to(HOST_ROOM).emit('bomb', { id: playerId });
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
        minRoundSec: MIN_ROUND_SEC,
        maxRoundSec: MAX_ROUND_SEC,
        minRoundsToWin: MIN_ROUNDS_TO_WIN,
        maxRoundsToWin: MAX_ROUNDS_TO_WIN,
        botDifficulties: BOT_DIFFICULTIES,
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

    socket.on('host:setRoundLength', ({ roundLengthSec } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setRoundLength(roundLengthSec);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, roundLengthSec: game.roundLengthSec });
      broadcastLobby();
    });

    socket.on('host:setRoundsToWin', ({ roundsToWin } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setRoundsToWin(roundsToWin);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, roundsToWin: game.roundsToWin });
      broadcastLobby();
    });

    socket.on('host:setPowerUps', ({ on } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setPowerUps(on);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, powerUps: game.powerUps });
      broadcastLobby();
    });

    socket.on('host:setBotDifficulty', ({ level } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setBotDifficulty(level);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, botDifficulty: game.botDifficulty });
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

    socket.on('host:reorder', ({ playerId: pid, beforeId } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.reorderPlayer(pid, beforeId);
      if (!res.ok) return ack && ack(res);
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
      const payload = Object.assign({ roster: res.roster }, game.getConfig());
      ack && ack(Object.assign({ ok: true }, payload));
      ns.emit('m:start', payload);
    });

    // ---- Live match meta pushed by the host (rebroadcast to players) ----
    socket.on('host:roundStart', ({ round, seed, durationSec } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.setRound(round, seed);
      game.setClock((durationSec || game.roundLengthSec) * 1000);
      game.setLive(false);
      game.setSuddenDeath(false);
      // A fresh round: everyone is alive again with starting power stats.
      const roster = game.getRoster();
      const alive = {};
      roster.forEach((r) => {
        alive[r.id] = true;
        game.setHud(r.id, { bombs: 1, fire: 1, speed: 0, kick: false, out: 0 });
      });
      game.setAlive(alive);
      ns.to(PLAYER_ROOM).emit('m:roundStart', {
        round: game.match.round,
        seed: game.match.seed,
        roundsToWin: game.roundsToWin,
        durationSec: durationSec || game.roundLengthSec,
        hud: game.match.hud,
      });
    });
    socket.on('host:countdown', ({ n, note } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.setLive(false);
      ns.to(PLAYER_ROOM).emit('m:countdown', { n, note });
    });
    socket.on('host:play', () => {
      if (role !== 'host') return;
      game.setLive(true);
      ns.to(PLAYER_ROOM).emit('m:play', {});
    });
    socket.on('host:pause', () => {
      if (role !== 'host') return;
      touchActivity();
      game.setPaused(true);
      ns.to(PLAYER_ROOM).emit('m:pause', {});
    });
    socket.on('host:resume', ({ live } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.setPaused(false);
      ns.to(PLAYER_ROOM).emit('m:resume', { live: !!live });
    });
    socket.on('host:clock', ({ ms, suddenDeath } = {}) => {
      if (role !== 'host') return;
      game.setClock(ms);
      if (suddenDeath !== undefined) game.setSuddenDeath(suddenDeath);
      ns.to(PLAYER_ROOM).emit('m:clock', {
        ms: game.match.clockMs,
        suddenDeath: game.match.suddenDeath,
      });
    });
    // Per-player power stats, pushed only when something actually changes so
    // the phone HUD can mirror the big screen without a firehose of packets.
    socket.on('host:hud', ({ id, bombs, fire, speed, kick, out } = {}) => {
      if (role !== 'host') return;
      const hud = game.setHud(id, { bombs, fire, speed, kick, out });
      if (!hud) return;
      ns.to(PLAYER_ROOM).emit('m:hud', Object.assign({ id }, hud));
    });
    socket.on('host:eliminated', ({ id, by } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      if (id) game.setAlive({ [id]: false });
      ns.to(PLAYER_ROOM).emit('m:eliminated', { id, by: by || null });
    });
    socket.on('host:board', ({ board } = {}) => {
      if (role !== 'host') return;
      game.setBoard(board);
    });
    socket.on('host:roundEnd', ({ round, winnerId, gamePoints } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.setLive(false);
      game.setSuddenDeath(false);
      if (gamePoints) game.setGamePoints(gamePoints);
      ns.to(PLAYER_ROOM).emit('m:roundEnd', {
        round,
        winnerId: winnerId || null,
        gamePoints: game.match.gamePoints,
        roundsToWin: game.roundsToWin,
      });
    });
    socket.on('host:matchEnd', ({ winnerIds, gamePoints } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.endMatch({ winnerIds, gamePoints });
      ns.to(PLAYER_ROOM).emit('m:end', {
        winnerIds: game.match.winnerIds,
        gamePoints: game.match.gamePoints,
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
}

module.exports = mountBombBrawl;
