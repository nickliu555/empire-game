'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const {
  Game,
  PHASES,
  MIN_TIME_LIMIT_SEC,
  MAX_TIME_LIMIT_SEC,
  DEFAULT_TIME_LIMIT_SEC,
  CAPACITY,
  MAX_PER_TEAM,
} = require('./game');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const INACTIVITY_RESET_MS = 60 * 60 * 1000; // 60 minutes
const HOST_GRACE_MS = 15000;
const EMOTE_COOLDOWN_MS = 2000;

// Must mirror the EMOTES list in public/puckball/js/player.js. Whitelisting
// keeps arbitrary text off the host screen.
const ALLOWED_EMOTES = new Set(['😂', '🔥', '👏', '😱', '😭', '😡']);

/**
 * Mount Puck Ball onto the hub's Express app and HTTP server.
 *
 * The live match is simulated on the HOST browser (see public/puckball/js/
 * engine.js) so controller input travels player -> server -> host in a single
 * relay hop. This module is a thin relay + lobby manager. It MUST reuse the
 * single shared Socket.IO Server cached on the HTTP server (httpServer._triviaIo)
 * — creating a second Server binds a second engine.io upgrade handler and
 * crashes on the first WebSocket upgrade.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountPuckBall(app, httpServer, opts) {
  const getPublicBaseUrl = (opts && opts.getPublicBaseUrl) || (() => '');

  const game = new Game();
  let hostCount = 0;
  let lastHostSeenAt = 0;
  let hostGraceTimer = null;
  let hostLeftIntentionally = false;
  let emotesMuted = false;
  // The host browser runs the physics, so exactly one screen may drive a match.
  // A second host tab would otherwise simulate in parallel and fight over the
  // players' countdown/goal/clock stream.
  let activeHostId = null;

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
      console.log('[puckball] auto-reset after 60 minutes of inactivity.');
      touchActivity();
    }
  }, 60 * 1000).unref();

  // ---------------- Page routes ----------------
  app.get('/puckball/host', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'puckball', 'host.html'));
  });
  app.get('/puckball/join', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'puckball', 'join.html'));
  });
  app.get('/puckball/play', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'puckball', 'player.html'));
  });

  // ---------------- REST endpoints ----------------
  app.get('/api/puckball/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({
      joinUrl: `${base}/puckball/join`,
      capacity: CAPACITY,
      perTeam: MAX_PER_TEAM,
      minTimeLimitSec: MIN_TIME_LIMIT_SEC,
      maxTimeLimitSec: MAX_TIME_LIMIT_SEC,
      defaultTimeLimitSec: DEFAULT_TIME_LIMIT_SEC,
    });
  });

  app.get('/api/puckball/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        color: { dark: '#2c4326', light: '#FFFFFF' },
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
  const ns = io.of('/puckball');

  function broadcastLobby() {
    ns.emit('state:lobby', game.getLobby());
  }

  // ---------------- Socket handlers ----------------
  ns.on('connection', (socket) => {
    let role = null;
    let playerId = null;
    let lastEmoteAt = 0;

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

    // Controller input relay — the latency-critical path, kept minimal.
    // d: 0..8 = (dx+1) + (dy+1)*3 with dx,dy in {-1,0,1}. k: 1 while kick held.
    socket.on('in', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING) return;
      if (game.match.paused) return;
      const d = msg && msg.d;
      if (!Number.isInteger(d) || d < 0 || d > 8) return;
      ns.to(HOST_ROOM).emit('in', { id: playerId, d, k: msg.k ? 1 : 0 });
    });

    // Goal-celebration reactions: whitelisted emoji only, rate limited, and
    // silenced entirely while the host has reactions muted.
    socket.on('emote', (msg) => {
      if (role !== 'player' || !playerId) return;
      if (game.phase !== PHASES.PLAYING) return;
      if (emotesMuted || game.match.paused) return;
      const e = msg && msg.e;
      if (!ALLOWED_EMOTES.has(e)) return;
      const now = Date.now();
      if (now - lastEmoteAt < EMOTE_COOLDOWN_MS) return;
      lastEmoteAt = now;
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
      if (activeHostId && activeHostId !== socket.id && ns.sockets.get(activeHostId)) {
        ns.to(activeHostId).emit('host:superseded');
      }
      activeHostId = socket.id;
      if (wasAbsent) emitHostPresence(true);
      const payload = {
        ok: true,
        phase: game.phase,
        lobby: game.getLobby(),
        emotesMuted,
        minTimeLimitSec: MIN_TIME_LIMIT_SEC,
        maxTimeLimitSec: MAX_TIME_LIMIT_SEC,
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

    // Only one screen may drive the live match. The newest host screen claims
    // it; if the holder has gone away the slot is free for the next host that
    // tries to drive (so a stray tab can't demote the real host forever).
    function isActiveHost() {
      if (role !== 'host') return false;
      if (activeHostId && !ns.sockets.get(activeHostId)) activeHostId = null;
      if (!activeHostId) activeHostId = socket.id;
      return activeHostId === socket.id;
    }

    socket.on('host:setTimeLimit', ({ timeLimitSec } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setTimeLimit(timeLimitSec);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, timeLimitSec: game.timeLimitSec });
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
      // Kicking is lobby-only: once the match starts the roster is locked.
      if (game.phase !== PHASES.LOBBY) return ack && ack({ ok: false, reason: 'not-lobby' });
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

    socket.on('host:muteEmotes', ({ muted } = {}, ack) => {
      if (!requireHost(ack)) return;
      emotesMuted = !!muted;
      ack && ack({ ok: true, emotesMuted });
    });

    socket.on('host:start', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      touchActivity();
      const res = game.startMatch();
      if (!res.ok) return ack && ack(res);
      ack && ack({
        ok: true,
        roster: res.roster,
        tier: res.tier,
        timeLimitSec: game.timeLimitSec,
        kickoffTeam: res.kickoffTeam,
      });
      ns.emit('m:start', {
        tier: res.tier,
        timeLimitSec: game.timeLimitSec,
        roster: res.roster,
        kickoffTeam: res.kickoffTeam,
      });
    });

    // ---- Live match meta pushed by the host (rebroadcast to players) ----
    socket.on('host:countdown', ({ n, note } = {}) => {
      if (!isActiveHost()) return;
      touchActivity();
      game.setLive(false);
      ns.to(PLAYER_ROOM).emit('m:countdown', { n, note });
    });
    socket.on('host:play', () => {
      if (!isActiveHost()) return;
      game.setLive(true);
      ns.to(PLAYER_ROOM).emit('m:play', {});
    });
    // The clock tick doubles as the match heartbeat: it carries the full
    // authoritative snapshot so a phone that missed an event (backgrounded,
    // signal blip) re-syncs within a quarter of a second.
    socket.on('host:clock', ({ ms, red, blue, live, paused } = {}) => {
      if (!isActiveHost()) return;
      game.setClock(ms);
      if (typeof red === 'number' && typeof blue === 'number') game.setScore(red, blue);
      if (typeof paused === 'boolean') game.setPaused(paused);
      if (typeof live === 'boolean') game.setLive(live);
      ns.to(PLAYER_ROOM).emit('m:clock', {
        ms: game.match.clockMs,
        red: game.match.redScore,
        blue: game.match.blueScore,
        live: game.match.live,
        paused: game.match.paused,
      });
    });
    socket.on('host:goal', ({ team, red, blue } = {}) => {
      if (!isActiveHost()) return;
      touchActivity();
      game.setScore(red, blue);
      game.setLive(false);
      ns.to(PLAYER_ROOM).emit('m:goal', { team, red: game.match.redScore, blue: game.match.blueScore });
    });
    socket.on('host:pause', () => {
      if (!isActiveHost()) return;
      touchActivity();
      game.setPaused(true);
      ns.to(PLAYER_ROOM).emit('m:pause', {});
    });
    socket.on('host:resume', ({ live } = {}) => {
      if (!isActiveHost()) return;
      touchActivity();
      game.setPaused(false);
      ns.to(PLAYER_ROOM).emit('m:resume', { live: !!live });
    });
    socket.on('host:matchEnd', ({ winner, red, blue } = {}) => {
      if (!isActiveHost()) return;
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
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      // Reset from a live/finished match keeps the score + time limits; a lobby
      // reset returns them to defaults.
      const keepConfig = game.phase !== PHASES.LOBBY;
      game.reset(keepConfig);
      ack && ack({ ok: true });
      ns.emit('state:reset');
      broadcastLobby();
    });

    socket.on('host:leave', (_p, ack) => {
      if (!requireHost(ack)) return;
      if (!isActiveHost()) return ack && ack({ ok: false, reason: 'not-active-host' });
      game.reset();
      hostLeftIntentionally = true;
      if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
      emitHostPresence(false);
      ack && ack({ ok: true });
    });

    socket.on('disconnect', () => {
      if (role === 'player') {
        // The player stays on the roster — a dropped phone is never a forfeit.
        game.markDisconnected(socket.id);
        broadcastLobby();
        ns.to(HOST_ROOM).emit('player:dropped', { id: playerId });
      } else if (role === 'host') {
        if (activeHostId === socket.id) activeHostId = null;
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

module.exports = mountPuckBall;
