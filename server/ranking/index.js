'use strict';

const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { Game, PHASES, MIN_PLAYERS, WORDS_PER_PLAYER, MAX_WORD_LEN } = require('./game');
const words = require('./words');

const HOST_ROOM = 'hosts';
const PLAYER_ROOM = 'players';
const REACTION_COUNT = 6;
const REACTION_COOLDOWN_MS = 10 * 1000;
const INACTIVITY_RESET_MS = 60 * 60 * 1000;
const HOST_GRACE_MS = 15000;

/**
 * Mount the Ranking game onto the hub's Express app and HTTP server.
 *
 * @param {import('express').Application} app
 * @param {import('http').Server} httpServer
 * @param {Object} opts
 * @param {() => string} opts.getPublicBaseUrl
 */
function mountRanking(app, httpServer, opts) {
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
  const pub = (f) => path.join(__dirname, '..', '..', 'public', 'ranking', f);
  app.get('/ranking/host', (_req, res) => res.sendFile(pub('host.html')));
  app.get('/ranking/join', (_req, res) => res.sendFile(pub('join.html')));
  app.get('/ranking/play', (_req, res) => res.sendFile(pub('player.html')));

  // ---------------- REST endpoints ----------------
  app.get('/api/ranking/config', (_req, res) => {
    const base = getPublicBaseUrl();
    res.json({ joinUrl: `${base}/ranking/join`, wordsTotal: words.count() });
  });

  app.get('/api/ranking/qr', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || url.length > 500) return res.status(400).send('bad url');
    try {
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, width: 320,
        color: { dark: '#5A3E00', light: '#FFFFFF' },
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
  const ns = io.of('/ranking');

  // ---------------- Broadcast helpers ----------------
  function broadcastLobby() {
    ns.emit('state:lobby', {
      phase: game.phase,
      players: game.getLobbyPlayers(),
      total: game.players.size,
    });
  }
  function broadcastIntro() { ns.emit('state:intro', game.getIntroPublic()); }

  // On entering COLLECT, tell EVERYONE (players render the form, host renders
  // progress). Progress-only updates thereafter go to the host room only, so a
  // player typing in their form is never clobbered by a re-render.
  function broadcastCollectAll() { ns.emit('state:collect', game.getCollectPublic()); }
  function broadcastCollectHost() { ns.to(HOST_ROOM).emit('state:collect', game.getCollectPublic()); }

  function socketOf(playerId) {
    const p = game.players.get(playerId);
    return p && p.socketId ? p.socketId : null;
  }

  function broadcastRank() {
    ns.emit('state:rank', game.getRankPublic());
    const r = game.currentRound();
    if (!r) return;
    const sid = socketOf(r.rankerId);
    const items = game.getRankerItems(r.rankerId);
    if (sid && items && !items.alreadyRanked) ns.to(sid).emit('you:rankItems', items);
  }

  function broadcastDiscuss() {
    ns.emit('state:discuss', game.getDiscussPublic());
    const r = game.currentRound();
    if (!r) return;
    const sid = socketOf(r.rankerId);
    const secret = game.getRankerSecret(r.rankerId);
    if (sid && secret) ns.to(sid).emit('you:rankerSecret', secret);
  }

  function broadcastConsensus() { ns.emit('state:consensus', game.getConsensusPublic()); }
  function broadcastRevealTransition() { ns.emit('state:revealTransition', game.getRevealTransitionPublic()); }
  function broadcastReveal() { ns.emit('state:reveal', game.getRevealPublic()); }
  function broadcastFinal() { ns.emit('state:final', game.getFinalPublic()); }

  game.onIntroEnd = () => broadcastRank();
  game.onRevealReady = () => broadcastReveal();

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
        player: { id: res.player.id, name: res.player.name },
        phase: game.phase,
        reactionsMuted,
        hostPresent: isHostPresent(),
        total: game.players.size,
      };
      if (game.phase === PHASES.INTRO) payload.intro = game.getIntroPublic();
      else if (game.phase === PHASES.COLLECT) payload.collect = game.getCollectPersonal(pid);
      else if (game.phase === PHASES.RANK) {
        payload.rank = game.getRankPublic();
        const items = game.getRankerItems(pid);
        if (items && !items.alreadyRanked) payload.rankItems = items;
      } else if (game.phase === PHASES.DISCUSS) {
        payload.discuss = game.getDiscussPublic();
        const secret = game.getRankerSecret(pid);
        if (secret) payload.rankerSecret = secret;
      } else if (game.phase === PHASES.REVEAL) {
        if (game.revealTransition) payload.revealTransition = game.getRevealTransitionPublic();
        else payload.reveal = game.getRevealPublic();
      } else if (game.phase === PHASES.FINAL) payload.final = game.getFinalPublic();
      ack && ack(payload);
      broadcastLobby();
    });

    socket.on('player:words', ({ words: submitted } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.submitWords({ playerId, words: submitted });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, words: res.words, phase: game.phase });
      // No auto-advance: the host starts the game once everyone is ready. Update
      // host progress (and the ready/Start state) only.
      broadcastCollectHost();
    });

    socket.on('player:editWords', (_p = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.editWords({ playerId });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, words: res.words });
      // They're now unsubmitted → progress ticks down and the host Start retracts.
      broadcastCollectHost();
    });

    socket.on('player:rank', ({ order } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.submitRanking({ playerId, order });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastDiscuss();
    });

    socket.on('player:consensus', ({ order } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      const res = game.updateConsensus({ playerId, order });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastConsensus();
    });

    socket.on('player:submit', ({ order } = {}, ack) => {
      touchActivity();
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      const res = game.submitConsensus({ playerId, order });
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true });
      broadcastRevealTransition();
    });

    socket.on('player:reaction', ({ index } = {}, ack) => {
      if (!playerId) return ack && ack({ ok: false, reason: 'not-joined' });
      if (!isHostPresent()) return ack && ack({ ok: false, reason: 'host-absent' });
      if (typeof index !== 'number' || index < 0 || index >= REACTION_COUNT) {
        return ack && ack({ ok: false, reason: 'bad-index' });
      }
      if (game.phase === PHASES.INTRO || game.phase === PHASES.COLLECT || game.phase === PHASES.RANK || game.phase === PHASES.DISCUSS) {
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
        wordsTotal: words.count(),
        reactionsMuted,
        minPlayers: MIN_PLAYERS,
        customWords: game.customWords,
        wordsPerPlayer: WORDS_PER_PLAYER,
        maxWordLen: MAX_WORD_LEN,
      });
      if (game.phase === PHASES.INTRO) socket.emit('state:intro', game.getIntroPublic());
      else if (game.phase === PHASES.COLLECT) socket.emit('state:collect', game.getCollectPublic());
      else if (game.phase === PHASES.RANK) socket.emit('state:rank', game.getRankPublic());
      else if (game.phase === PHASES.DISCUSS) socket.emit('state:discuss', game.getDiscussPublic());
      else if (game.phase === PHASES.REVEAL) {
        if (game.revealTransition) socket.emit('state:revealTransition', game.getRevealTransitionPublic());
        else socket.emit('state:reveal', game.getRevealPublic());
      } else if (game.phase === PHASES.FINAL) socket.emit('state:final', game.getFinalPublic());
    });

    socket.on('host:start', (_payload = {}, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      // Custom Words: a Start during COLLECT builds the rounds (only when everyone
      // has submitted and nobody is mid-edit); otherwise it's the lobby start.
      if (game.phase === PHASES.COLLECT) {
        const res = game.beginFromCollect();
        if (!res.ok) return ack && ack(res);
        ack && ack({ ok: true, phase: game.phase });
        return broadcastIntro();
      }
      const res = game.start();
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, phase: game.phase });
      broadcastLobby();
      // Custom Words: collect phrases first; otherwise straight into the intro.
      if (game.phase === PHASES.COLLECT) broadcastCollectAll();
      else broadcastIntro();
    });

    socket.on('host:setCustomWords', ({ on } = {}, ack) => {
      if (!requireHost(ack)) return;
      const res = game.setCustomWords(on);
      if (!res.ok) return ack && ack(res);
      ack && ack({ ok: true, customWords: res.customWords });
      ns.emit('state:customWords', { on: res.customWords });
    });

    socket.on('host:next', (_p, ack) => {
      if (!requireHost(ack)) return;
      touchActivity();
      const res = game.advance();
      if (!res.ok) return ack && ack(res);
      if (res.phase === PHASES.RANK) broadcastRank();
      else if (res.phase === PHASES.FINAL) broadcastFinal();
      ack && ack({ ok: true, phase: res.phase });
    });

    socket.on('host:kick', ({ playerId: pid } = {}, ack) => {
      if (!requireHost(ack)) return;
      // Kicking is only allowed in the lobby; removePlayer returns null otherwise.
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

module.exports = mountRanking;
