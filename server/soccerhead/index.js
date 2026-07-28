'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES, MODES, MIN_DURATION_SEC, MAX_DURATION_SEC, DEFAULT_DURATION_SEC } = require('./game');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;

// Emojis a player may send as a goal-celebration reaction. Must mirror the
// EMOTES list in public/soccerhead/js/player.js. Whitelisting keeps arbitrary
// text off the host screen.
const ALLOWED_EMOTES = new Set(['😀', '😂', '😎', '😭', '😡', '👍', '⚽', '🔥', '💪', '🎉']);

/**
 * Mount Soccer Head onto the hub's Express app and HTTP server.
 *
 * Architecture note: the live match (physics/ball/scoring) is simulated on the
 * HOST browser so controller input travels player -> server -> host in a single
 * relay hop (lowest latency). This module is a thin relay + lobby manager. It
 * MUST reuse the single shared Socket.IO Server cached on the HTTP server
 * (httpServer._triviaIo) — creating a second Server binds a second engine.io
 * upgrade handler and crashes on the first WebSocket upgrade.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountSoccerHead(app, httpServer, opts) {
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
      console.log('[soccerhead] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/soccerhead/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'soccerhead', 'host.html'));
  });
  app.get('/soccerhead/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'soccerhead', 'join.html'));
  });
  app.get('/soccerhead/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'soccerhead', 'player.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/soccerhead/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/soccerhead/join`,
      modes: Object.keys(MODES),
      minDurationSec: MIN_DURATION_SEC,
      maxDurationSec: MAX_DURATION_SEC,
      defaultDurationSec: DEFAULT_DURATION_SEC,
    });
  });

  app.get('/api/soccerhead/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#132a3f', light: '#FFFFFF' },
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
  const ns = io.of('/soccerhead');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', game.getLobby());
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
      // Let the host un-dim this player's character if they dropped and came back.
      if (game.phase === PHASES.PLAYING) ns.to(HOST_ROOM).emit('player:rejoined', { id: pid });
      broadcastLobby();
    });

    // Controller input relay: forwarded straight to the host with the player's
    // id attached. Kept intentionally minimal — this is the latency-critical
    // path. c: 0=left 1=right 2=jump 3=kick, d: 1 down / 0 up.
    socket.on('in', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING) return;
      if (game.match.paused) return;
      const c = msg && msg.c;
      if (c !== 0 && c !== 1 && c !== 2 && c !== 3) return;
      ns.to(HOST_ROOM).emit('in', { id: playerId, c, d: msg.d ? 1 : 0 });
    });
    socket.on('dash', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING) return;
      if (game.match.paused) return;
      const dir = msg && msg.dir < 0 ? -1 : 1;
      ns.to(HOST_ROOM).emit('dash', { id: playerId, dir });
    });

    // Goal-celebration emote relay: only a whitelisted emoji, only during a
    // live match. Forwarded to the host, which shows it as a bubble.
    socket.on('emote', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING) return;
      if (game.match.paused) return;
      const e = msg && msg.e;
      if (!ALLOWED_EMOTES.has(e)) return;
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
        minDurationSec: MIN_DURATION_SEC,
        maxDurationSec: MAX_DURATION_SEC,
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

    socket.on('host:setMode', ({ mode } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setMode(mode);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastLobby();
    });

    socket.on('host:setDuration', ({ durationSec } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setDuration(durationSec);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, durationSec: game.durationSec });
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
      ack && ack({ ok: true, roster: res.roster, durationSec: game.durationSec, mode: game.mode });
      // Everyone leaves the lobby: players -> controller, host -> pitch.
      ns.emit('m:start', {
        mode: game.mode,
        durationSec: game.durationSec,
        roster: res.roster,
      });
    });

    // ---- Live match meta pushed by the host (rebroadcast to players) ----
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
    socket.on('host:clock', ({ ms, sudden } = {}) => {
      if (role !== 'host') return;
      game.setClock(ms, sudden);
      ns.to(PLAYER_ROOM).emit('m:clock', { ms: game.match.clockMs, sudden: game.match.sudden });
    });
    socket.on('host:goal', ({ team, red, blue } = {}) => {
      if (role !== 'host') return;
      touchActivity();
      game.setScore(red, blue);
      game.setLive(false);
      ns.to(PLAYER_ROOM).emit('m:goal', { team, red: game.match.redScore, blue: game.match.blueScore });
    });
    socket.on('host:sudden', () => {
      if (role !== 'host') return;
      game.setSudden(true);
      ns.to(PLAYER_ROOM).emit('m:sudden', {});
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
      // Reset from a live/finished match returns to the lobby but KEEPS the mode
      // + match-length settings; reset from the lobby returns them to defaults.
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
        // Tell the host a controller dropped so it can pause that character.
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

module.exports = mountSoccerHead;
