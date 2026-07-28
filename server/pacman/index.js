'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const {
  Game,
  PHASES,
  MIN_ROUND_SEC,
  MAX_ROUND_SEC,
  DEFAULT_ROUND_SEC,
  MIN_ROUNDS_TO_WIN,
  MAX_ROUNDS_TO_WIN,
  DEFAULT_ROUNDS_TO_WIN,
} = require('./game');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;

// Emoji a player may send as a reaction. Mirrors EMOTES in player.js.
const ALLOWED_EMOTES = new Set(['😀', '😂', '😎', '😭', '😡', '👍', '👻', '🍒', '💪', '🎉']);
const REACTION_COOLDOWN_MS = 2000;

/**
 * Mount Pac-Man Royale onto the hub's Express app and HTTP server.
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
function mountPacman(app, httpServer, opts) {
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
      console.log('[pacman] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/pacman/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'pacman', 'host.html'));
  });
  app.get('/pacman/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'pacman', 'join.html'));
  });
  app.get('/pacman/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'pacman', 'player.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/pacman/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/pacman/join`,
      minRoundSec: MIN_ROUND_SEC,
      maxRoundSec: MAX_ROUND_SEC,
      defaultRoundSec: DEFAULT_ROUND_SEC,
      minRoundsToWin: MIN_ROUNDS_TO_WIN,
      maxRoundsToWin: MAX_ROUNDS_TO_WIN,
      defaultRoundsToWin: DEFAULT_ROUNDS_TO_WIN,
    });
  });

  app.get('/api/pacman/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#1a1a4e', light: '#FFFFFF' },
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
  const ns = io.of('/pacman');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', game.getLobby());
  }

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;
    let lastReactionAt = 0;

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

    // Controller input relay: forwarded straight to the host with the player's
    // id attached. dir: 0=up 1=down 2=left 3=right (a desired heading).
    socket.on('in', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING || !game.match.live) return;
      if (game.match.paused) return;
      if (game.match.alive && game.match.alive[playerId] === false) return;
      const dir = msg && msg.dir;
      if (dir !== 0 && dir !== 1 && dir !== 2 && dir !== 3) return;
      ns.to(HOST_ROOM).emit('in', { id: playerId, dir });
    });

    // Reaction emoji relay (whitelisted, cooldown-throttled). Shown as a bubble
    // over that player's Pac-Man on the host screen. Purely cosmetic.
    socket.on('emote', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING) return;
      const now = Date.now();
      if (now - lastReactionAt < REACTION_COOLDOWN_MS) return;
      const e = msg && msg.e;
      if (!ALLOWED_EMOTES.has(e)) return;
      lastReactionAt = now;
      ns.to(HOST_ROOM).emit('emote', { id: playerId, e });
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
      ack && ack({
        ok: true,
        roster: res.roster,
        roundLengthSec: game.roundLengthSec,
        roundsToWin: game.roundsToWin,
      });
      ns.emit('m:start', {
        roster: res.roster,
        roundLengthSec: game.roundLengthSec,
        roundsToWin: game.roundsToWin,
      });
    });

    // ---- Live match meta pushed by the host (rebroadcast to players) ----
    socket.on('host:roundStart', ({ round, mazeIndex, durationSec } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.setRound(round, mazeIndex);
      game.setClock((durationSec || game.roundLengthSec) * 1000);
      game.setLive(false);
      // A fresh round: everyone is alive again.
      const roster = game.getRoster();
      const alive = {};
      roster.forEach((r) => { alive[r.id] = true; });
      game.setAlive(alive);
      ns.to(PLAYER_ROOM).emit('m:roundStart', {
        round: game.match.round,
        mazeIndex: game.match.mazeIndex,
        roundsToWin: game.roundsToWin,
        durationSec: durationSec || game.roundLengthSec,
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
    socket.on('host:clock', ({ ms, scores } = {}) => {
      if (role !== 'host') return;
      game.setClock(ms);
      if (scores) game.setScores(scores);
      ns.to(PLAYER_ROOM).emit('m:clock', { ms: game.match.clockMs, scores: game.match.scores });
    });
    socket.on('host:powered', ({ id, on } = {}) => {
      if (role !== 'host') return;
      ns.to(PLAYER_ROOM).emit('m:powered', { id, on: !!on });
    });
    socket.on('host:eliminated', ({ id } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      if (id) game.setAlive({ [id]: false });
      ns.to(PLAYER_ROOM).emit('m:eliminated', { id });
    });
    socket.on('host:board', ({ board } = {}) => {
      if (role !== 'host') return;
      game.setBoard(board);
    });
    socket.on('host:roundOver', ({ round, scores, winnerIds, gamePoints, alive } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.setLive(false);
      if (scores) game.setScores(scores);
      if (gamePoints) game.setGamePoints(gamePoints);
      if (alive) game.setAlive(alive);
      ns.to(PLAYER_ROOM).emit('m:roundOver', {
        round,
        scores: game.match.scores,
        winnerIds: Array.isArray(winnerIds) ? winnerIds : [],
        gamePoints: game.match.gamePoints,
        roundsToWin: game.roundsToWin,
      });
    });
    socket.on('host:matchEnd', ({ winnerIds, gamePoints, awards } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.endMatch({ winnerIds, gamePoints, awards });
      ns.to(PLAYER_ROOM).emit('m:end', {
        winnerIds: game.match.winnerIds,
        gamePoints: game.match.gamePoints,
        scores: game.match.scores,
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

module.exports = mountPacman;
