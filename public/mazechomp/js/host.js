(function () {
  'use strict';

  const socket = io('/mazechomp', { transports: ['polling', 'websocket'] });

  // ---------------- Tunables ----------------
  const FIXED_DT = 1 / 120;
  const MAX_STEPS = 20;
  const COUNTDOWN_FROM = 3;
  const COUNTDOWN_STEP_MS = 800;
  const CLOCK_EMIT_MS = 250;
  const ROUNDOVER_MS = 7000;
  const ROUND_END_HOLD_MS = 2000;   // freeze the board this long before the scoreboard
  const EMOTE_MS = 3000;
  const POWER_FLASH_SEC = (window.MazeChomp && window.MazeChomp.POWER_FLASH_SEC) || 3;

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    match: document.getElementById('view-match'),
    final: document.getElementById('view-final'),
  };
  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('active', k === name); });
  }

  const qrSlot = document.getElementById('qrSlot');
  const joinUrlEl = document.getElementById('joinUrl');
  const playerCountEl = document.getElementById('playerCount');
  const playerCapEl = document.getElementById('playerCap');
  const addBotBtn = document.getElementById('addBotBtn');
  const roundsRange = document.getElementById('roundsRange');
  const roundsVal = document.getElementById('roundsVal');
  const durRange = document.getElementById('durRange');
  const durVal = document.getElementById('durVal');
  const slotList = document.getElementById('slotList');
  const configHint = document.getElementById('configHint');
  const startBtn = document.getElementById('startBtn');

  const canvas = document.getElementById('maze');
  const scoreStrip = document.getElementById('scoreStrip');
  const sbRound = document.getElementById('sbRound');
  const sbClock = document.getElementById('sbClock');
  const sbMaze = document.getElementById('sbMaze');
  const countOverlay = document.getElementById('countOverlay');
  const coNum = document.getElementById('coNum');
  const coNote = document.getElementById('coNote');
  const reasonOverlay = document.getElementById('reasonOverlay');
  const reasonText = document.getElementById('reasonText');
  const roundOverlay = document.getElementById('roundOverlay');
  const roTitle = document.getElementById('roTitle');
  const roList = document.getElementById('roList');

  const finalTrophy = document.getElementById('finalTrophy');
  const finalHeading = document.getElementById('finalHeading');
  const finalList = document.getElementById('finalList');
  const finalAwards_el = document.getElementById('finalAwards');
  const finalAwardsSection = document.getElementById('finalAwardsSection');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const pauseOverlay = document.getElementById('pauseOverlay');

  // ---------------- Modal helpers ----------------
  function showInlineConfirm(message, onYes, opts) {
    if (typeof window.showConfirm !== 'function') { if (window.confirm(message)) onYes && onYes(); return; }
    const okLabel = (opts && opts.okLabel) || 'Yes';
    window.showConfirm(message, okLabel, opts || {}).then(function (ok) { if (ok) onYes && onYes(); });
  }
  function toast(message) {
    if (typeof window.showToast === 'function' && window.showToast !== toast) { window.showToast(message); return; }
  }

  // ---------------- Wake Lock ----------------
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function () { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wakeLock === null) acquireWakeLock();
  });
  acquireWakeLock();
  document.addEventListener('click', function once() {
    document.removeEventListener('click', once);
    if (wakeLock === null) acquireWakeLock();
  });

  // ---------------- Fullscreen / reset / hub ----------------
  fullscreenBtn && fullscreenBtn.addEventListener('click', function () {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(function () {});
    else document.exitFullscreen();
  });
  document.addEventListener('fullscreenchange', function () {
    if (fullscreenBtn) fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit' : '⛶ Fullscreen';
  });
  resetBtn && resetBtn.addEventListener('click', function () {
    showInlineConfirm('Reset the entire game? All players will be kicked.', function () {
      socket.emit('host:reset', {});
    }, { okLabel: 'Reset', danger: true });
  });
  const hubBtn = document.getElementById('hubBtn');
  if (hubBtn) {
    hubBtn.addEventListener('click', function (e) {
      e.preventDefault();
      const origin = { clientX: e.clientX, clientY: e.clientY, currentTarget: hubBtn };
      showInlineConfirm('Leaving will reset the game and kick all players. Go back to the hub?', function () {
        let navigated = false;
        const go = function () {
          if (navigated) return; navigated = true;
          if (window.Iris && typeof window.Iris.transitionTo === 'function') window.Iris.transitionTo('/', origin, { emoji: '👻', name: 'Game Hub', color: '#12123a' });
          else window.location.href = '/';
        };
        socket.emit('host:leave', {}, go);
        setTimeout(go, 600);
      }, { okLabel: 'Leave & Reset', danger: true });
    });
  }

  // ---------------- Audio ----------------
  let audioCtx = null;
  function getAudioCtx() { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} } return audioCtx; }
  function unlockAudio() { const c = getAudioCtx(); if (c && c.state === 'suspended') c.resume(); }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  function blip(freq, dur, type, gain, when) {
    const c = getAudioCtx(); if (!c) return;
    const t = when || c.currentTime;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function playJoinDing() {
    const c = getAudioCtx(); if (!c || c.state === 'suspended') return;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, c.currentTime);
    o.frequency.setValueAtTime(1174.66, c.currentTime + 0.08);
    g.gain.setValueAtTime(0.3, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.4);
    o.connect(g); g.connect(c.destination);
    o.start(c.currentTime); o.stop(c.currentTime + 0.4);
  }
  let lastChomp = 0, chompHi = false;
  function playChomp() {
    const c = getAudioCtx(); if (!c) return;
    const now = c.currentTime; if (now - lastChomp < 0.11) return; lastChomp = now;
    chompHi = !chompHi;
    blip(chompHi ? 420 : 300, 0.06, 'square', 0.08);
  }
  function playPower() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[440, 587, 784, 1047].forEach(function (f, i) { blip(f, 0.14, 'square', 0.12, b + i * 0.06); }); }
  function playFruit() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[1047, 1319, 1568].forEach(function (f, i) { blip(f, 0.1, 'sine', 0.14, b + i * 0.05); }); }
  function playGhostEat() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[600, 900, 1200].forEach(function (f, i) { blip(f, 0.08, 'sawtooth', 0.12, b + i * 0.04); }); }
  function playDeath() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[600, 500, 400, 300, 200].forEach(function (f, i) { blip(f, 0.12, 'triangle', 0.16, b + i * 0.09); }); }
  function playLookUp() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[523, 659, 784].forEach(function (f, i) { blip(f, 0.16, 'triangle', 0.16, b + i * 0.09); }); }
  function playRoundWin() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime;[523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.24, 'sawtooth', 0.14, b + i * 0.08); }); }
  function playGameWin() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 659, 784, 1047, 1319, 1568].forEach(function (f, i) { blip(f, 0.3, 'sawtooth', 0.15, b + i * 0.1); });
  }
  function beep(n) { blip(440 + (COUNTDOWN_FROM - n) * 120, 0.1, 'square', 0.14); }

  // ---------------- Lobby ----------------
  let lobby = { players: [], total: 0, capacity: 4, minPlayers: 2, roundLengthSec: 60, roundsToWin: 3, canStart: false };
  let lastHumanTotal = -1;
  // Lobby drag state (pointer-based chip reorder — see setupLobbyDrag below).
  let dragActive = false;    // a chip is mid-drag; defer lobby rebuilds
  let pendingLobby = null;   // latest snapshot to apply once the drag settles

  function fmtClock(ms) { const t = Math.max(0, Math.ceil(ms / 1000)); const m = Math.floor(t / 60), s = t % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtDur(sec) { const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  function renderQR() {
    fetch('/api/mazechomp/config').then(function (r) { return r.json(); }).then(function (cfg) {
      const url = (cfg && cfg.joinUrl) || (window.location.origin + '/mazechomp/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      return fetch('/api/mazechomp/qr?url=' + encodeURIComponent(url));
    }).then(function (r) { return r.text(); }).then(function (svg) { qrSlot.innerHTML = svg; }).catch(function () {});
  }

  function renderLobby(l) {
    if (!l) return;
    // Don't rebuild the chip list out from under an in-progress drag.
    if (dragActive) { pendingLobby = l; return; }
    lobby = l;
    const humanTotal = l.players.filter(function (p) { return !p.isBot; }).length;
    if (lastHumanTotal >= 0 && humanTotal > lastHumanTotal) playJoinDing();
    lastHumanTotal = humanTotal;
    playerCountEl.textContent = l.total;
    playerCapEl.textContent = l.capacity;
    roundsRange.value = l.roundsToWin; roundsVal.textContent = l.roundsToWin;
    durRange.value = l.roundLengthSec; durVal.textContent = fmtDur(l.roundLengthSec);
    slotList.innerHTML = '';
    l.players.forEach(function (p) {
      const el = document.createElement('div');
      el.className = 'player-chip' + (p.connected === false ? ' disconnected' : '') + (p.isBot ? ' is-bot' : '');
      el.dataset.pid = p.id;
      const grip = document.createElement('span'); grip.className = 'chip-grip'; grip.textContent = '⠿';
      const dot = document.createElement('span'); dot.className = 'chip-dot'; dot.style.background = p.color;
      const label = document.createElement('span'); label.className = 'chip-name'; label.textContent = p.name;
      const kick = document.createElement('button'); kick.className = 'chip-kick'; kick.type = 'button'; kick.textContent = '✕';
      kick.title = p.isBot ? 'Remove CPU' : 'Remove player';
      kick.addEventListener('click', function (e) { e.stopPropagation(); socket.emit('host:kick', { playerId: p.id }); });
      el.appendChild(grip); el.appendChild(dot); el.appendChild(label); el.appendChild(kick);
      slotList.appendChild(el);
    });
    for (let i = l.players.length; i < l.capacity; i++) {
      const e = document.createElement('div'); e.className = 'slot-empty'; e.textContent = 'Open spot'; slotList.appendChild(e);
    }
    startBtn.disabled = !l.canStart;
    if (addBotBtn) addBotBtn.disabled = l.total >= l.capacity;
    configHint.textContent = l.canStart ? '' : ('Need at least ' + l.minPlayers + ' players (add a CPU to fill in).');
  }

  // ---- Smooth pointer-drag to reorder the lobby (order = seat/colour/corner) --
  (function setupLobbyDrag() {
    let reduceMotion = false;
    try { reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    let d = null; // { el, pid, downX, downY, active, offX, offY, ph }

    function chips() {
      return Array.prototype.slice.call(slotList.querySelectorAll('.player-chip'))
        .filter(function (c) { return !d || c !== d.el; });
    }
    function measure() { return chips().map(function (c) { return [c, c.getBoundingClientRect().top]; }); }
    function flip(prev) {
      if (reduceMotion || !prev) return;
      const moved = [];
      prev.forEach(function (rec) {
        const c = rec[0]; if (!c.isConnected) return;
        const delta = rec[1] - c.getBoundingClientRect().top;
        if (delta) { c.style.transition = 'none'; c.style.transform = 'translateY(' + delta + 'px)'; moved.push(c); }
      });
      if (!moved.length) return;
      document.body.getBoundingClientRect();
      moved.forEach(function (c) { c.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)'; c.style.transform = ''; });
    }
    function positionPlaceholder(y) {
      const cs = chips();
      let before = null;
      for (let i = 0; i < cs.length; i++) { const r = cs[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { before = cs[i]; break; } }
      if (!before) before = slotList.querySelector('.slot-empty');
      if (d.ph.nextElementSibling === before) return;
      const prev = measure();
      slotList.insertBefore(d.ph, before);
      flip(prev);
    }
    function beginLift() {
      d.active = true; dragActive = true;
      const r = d.el.getBoundingClientRect();
      d.offX = d.downX - r.left; d.offY = d.downY - r.top;
      d.ph = document.createElement('div'); d.ph.className = 'chip-placeholder'; d.ph.style.height = r.height + 'px';
      d.el.parentNode.insertBefore(d.ph, d.el);
      d.el.style.position = 'fixed'; d.el.style.left = '0'; d.el.style.top = '0'; d.el.style.width = r.width + 'px';
      d.el.style.margin = '0'; d.el.style.zIndex = '50'; d.el.style.pointerEvents = 'none'; d.el.style.transition = 'none';
      d.el.classList.add('dragging');
    }
    function onMove(e) {
      if (!d) return;
      if (e.cancelable) e.preventDefault();
      const x = e.clientX, y = e.clientY;
      if (!d.active) { if (Math.abs(x - d.downX) < 5 && Math.abs(y - d.downY) < 5) return; beginLift(); }
      d.el.style.transform = 'translate(' + (x - d.offX) + 'px,' + (y - d.offY) + 'px) scale(1.03)';
      positionPlaceholder(y);
    }
    function onUp() {
      if (!d) return;
      const cur = d; d = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!cur.active) return; // never crossed the threshold → a tap
      let next = cur.ph.nextElementSibling;
      while (next && !next.classList.contains('player-chip')) next = next.nextElementSibling;
      const beforeId = next ? next.dataset.pid : null;
      const el = cur.el;
      const floatRect = el.getBoundingClientRect();
      cur.ph.parentNode.insertBefore(el, cur.ph); cur.ph.remove();
      el.style.position = ''; el.style.left = ''; el.style.top = ''; el.style.width = ''; el.style.margin = ''; el.style.zIndex = ''; el.style.pointerEvents = '';
      let cleaned = false;
      const done = function () { if (cleaned) return; cleaned = true; el.classList.remove('dragging'); el.style.transition = ''; el.style.transform = ''; el.removeEventListener('transitionend', done); };
      if (reduceMotion) { done(); }
      else {
        const dest = el.getBoundingClientRect();
        el.style.transition = 'none';
        el.style.transform = 'translate(' + (floatRect.left - dest.left) + 'px,' + (floatRect.top - dest.top) + 'px) scale(1.03)';
        document.body.getBoundingClientRect();
        el.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)'; el.style.transform = '';
        el.addEventListener('transitionend', done);
        setTimeout(done, 260);
      }
      dragActive = false;
      if (pendingLobby) { const pl = pendingLobby; pendingLobby = null; renderLobby(pl); }
      socket.emit('host:reorder', { playerId: cur.pid, beforeId: beforeId }, function (res) {
        if (res && !res.ok) renderLobby(lobby);
      });
    }
    function onDown(e) {
      if (e.button != null && e.button !== 0) return; // primary only
      if (!e.target || e.target.closest('.chip-kick')) return; // kick isn't a handle
      const el = e.target.closest('.player-chip');
      if (!el || d) return;
      d = { el: el, pid: el.dataset.pid, downX: e.clientX, downY: e.clientY, active: false, offX: 0, offY: 0, ph: null };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    slotList.addEventListener('pointerdown', onDown);
  })();

  addBotBtn && addBotBtn.addEventListener('click', function () {
    socket.emit('host:addBot', {}, function (res) { if (res && !res.ok) toast('Could not add a CPU.'); });
  });
  let roundsTimer = null;
  roundsRange.addEventListener('input', function () {
    roundsVal.textContent = roundsRange.value;
    if (roundsTimer) clearTimeout(roundsTimer);
    roundsTimer = setTimeout(function () { socket.emit('host:setRoundsToWin', { roundsToWin: Number(roundsRange.value) }); }, 120);
  });
  let durTimer = null;
  durRange.addEventListener('input', function () {
    durVal.textContent = fmtDur(Number(durRange.value));
    if (durTimer) clearTimeout(durTimer);
    durTimer = setTimeout(function () { socket.emit('host:setRoundLength', { roundLengthSec: Number(durRange.value) }); }, 120);
  });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (!res || !res.ok) { toast('Need at least 2 players to start.'); return; }
      startMatch(res.roster, { roundLengthSec: res.roundLengthSec, roundsToWin: res.roundsToWin }, null);
    });
  });

  // ---------------- Match state ----------------
  let world = null, renderer = null, rafId = null, lastFrame = 0, acc = 0;
  let matchState = 'idle'; // idle | countdown | play | roundover | ended
  let roster = [];
  let roundLengthSec = 60, roundsToWin = 3;
  let round = 1, mazeIndex = 0, mazeOrder = [];
  let clockMs = 0, lastClockEmit = 0;
  let gamePoints = {}; // id -> rounds won
  let roundEndAt = null; // performance.now() when the round was decided (start of the freeze)
  let countdownTimer = null, roundOverTimer = null;
  let botIds = [];
  let prevPowered = {}; // id -> bool
  const inputQueue = [];
  // Cross-round stats for the end-of-game awards. Per id: total (points),
  // kills, ghosts, powers, cherries, deaths, survived (rounds alive at the end).
  let stats = {};
  let fastestDeath = null; // { id, sec, round } — quickest single-round death
  let finalAwards = null;  // computed award cards (also cached server-side)

  // ---------------- Pause ----------------
  // The whole game runs on this browser, so pausing means: stop stepping the
  // world/clock in loop(), and freeze every wall-clock timer (countdown /
  // round-over) so the sequence picks up exactly where it left off. Players get
  // covered + input-blocked via the server relay (m:pause / m:resume).
  let paused = false;
  const pausableTimers = new Set();
  function pTimeout(fn, ms) {
    const rec = { fn: fn, remaining: ms, startedAt: performance.now(), handle: null, repeat: false, interval: 0 };
    rec.handle = setTimeout(function () { pausableTimers.delete(rec); fn(); }, ms);
    pausableTimers.add(rec); return rec;
  }
  function pInterval(fn, ms) {
    const rec = { fn: fn, remaining: ms, startedAt: performance.now(), handle: null, repeat: true, interval: ms };
    rec.handle = setInterval(function () { rec.startedAt = performance.now(); rec.remaining = ms; fn(); }, ms);
    pausableTimers.add(rec); return rec;
  }
  function pClear(rec) { if (!rec) return; if (rec.repeat) clearInterval(rec.handle); else clearTimeout(rec.handle); pausableTimers.delete(rec); }
  function pClearAll() { pausableTimers.forEach(function (rec) { if (rec.repeat) clearInterval(rec.handle); else clearTimeout(rec.handle); }); pausableTimers.clear(); }
  function freezeTimers() {
    const now = performance.now();
    pausableTimers.forEach(function (rec) {
      rec.remaining = Math.max(0, rec.remaining - (now - rec.startedAt));
      if (rec.repeat) clearInterval(rec.handle); else clearTimeout(rec.handle);
      rec.handle = null;
    });
  }
  function thawTimers() {
    pausableTimers.forEach(function (rec) {
      rec.startedAt = performance.now();
      if (rec.repeat) {
        rec.handle = setTimeout(function () {
          rec.fn();
          if (!pausableTimers.has(rec)) return; // fn() may have cleared it (terminal tick)
          rec.startedAt = performance.now(); rec.remaining = rec.interval;
          rec.handle = setInterval(function () { rec.startedAt = performance.now(); rec.remaining = rec.interval; rec.fn(); }, rec.interval);
        }, rec.remaining);
      } else {
        rec.handle = setTimeout(function () { pausableTimers.delete(rec); rec.fn(); }, rec.remaining);
      }
    });
  }
  function updatePauseBtn() {
    if (!pauseBtn) return;
    const ongoing = matchState === 'countdown' || matchState === 'play' || matchState === 'roundover';
    pauseBtn.hidden = !ongoing;
    pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
  }
  function pauseMatch() {
    if (paused) return;
    const ongoing = matchState === 'countdown' || matchState === 'play' || matchState === 'roundover';
    if (!ongoing) return;
    paused = true;
    if (world) { world.frozen = true; for (const p of world.players) world.clearInputs(p.id); }
    inputQueue.length = 0;
    freezeTimers();
    if (pauseOverlay) pauseOverlay.hidden = false;
    updatePauseBtn();
    socket.emit('host:pause', {});
  }
  function resumeMatch() {
    if (!paused) return;
    paused = false;
    if (world && matchState === 'play') world.frozen = false;
    lastFrame = performance.now(); acc = 0; lastClockEmit = 0;
    thawTimers();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    socket.emit('host:resume', { live: matchState === 'play' });
  }
  pauseBtn && pauseBtn.addEventListener('click', function () { if (paused) resumeMatch(); else pauseMatch(); });

  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }

  function startMatch(rost, cfg, initial) {
    roster = rost || [];
    roundLengthSec = (cfg && cfg.roundLengthSec) || 60;
    roundsToWin = (cfg && cfg.roundsToWin) || 3;
    gamePoints = {};
    roster.forEach(function (r) { gamePoints[r.id] = 0; });
    // Fresh award stats for the match.
    stats = {}; fastestDeath = null; finalAwards = null;
    roster.forEach(function (r) { stats[r.id] = { total: 0, kills: 0, ghosts: 0, powers: 0, cherries: 0, deaths: 0, survived: 0 }; });
    botIds = roster.filter(function (r) { return r.isBot; }).map(function (r) { return r.id; });
    const nMazes = (window.MazeChompMazes && window.MazeChompMazes.length) || 1;
    mazeOrder = shuffle(Array.from({ length: nMazes }, function (_, i) { return i; }));
    if (initial && initial.gamePoints) { for (const id in initial.gamePoints) if (id in gamePoints) gamePoints[id] = initial.gamePoints[id]; }
    round = (initial && initial.round) || 1;
    show('match');
    buildScoreStrip();
    startLoop();
    beginRound(round);
  }

  function beginRound(r) {
    round = r;
    mazeIndex = mazeOrder[(r - 1) % mazeOrder.length];
    world = new window.MazeChomp.World({ mazes: window.MazeChompMazes, parse: window.MazeChompMazes.parse });
    world.setRoster(roster);
    world.reset(mazeIndex);
    world.frozen = true;
    renderer = new window.MazeChompRender.Renderer(canvas, world);
    prevPowered = {};
    roster.forEach(function (rr) { prevPowered[rr.id] = false; });
    clockMs = roundLengthSec * 1000;
    roundEndAt = null;
    if (reasonOverlay) reasonOverlay.hidden = true;
    inputQueue.length = 0;
    paused = false; pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;
    if (roundOverlay) roundOverlay.hidden = true;
    if (sbMaze) sbMaze.textContent = world.board.name;
    updateScoreStrip();
    requestAnimationFrame(function () { renderer.resize(); });
    socket.emit('host:roundStart', { round: round, mazeIndex: mazeIndex, durationSec: roundLengthSec });
    socket.emit('host:board', { board: { round: round, mazeIndex: mazeIndex, gamePoints: gamePoints } });
    playLookUp();
    beginCountdown();
  }

  function beginCountdown() {
    matchState = 'countdown';
    updatePauseBtn();
    if (world) world.frozen = true;
    if (countdownTimer) pClear(countdownTimer);
    let n = COUNTDOWN_FROM;
    function showN(v) {
      countOverlay.hidden = false;
      coNum.textContent = v;
      coNum.style.animation = 'none'; void coNum.offsetWidth; coNum.style.animation = '';
      if (coNote) coNote.textContent = 'Round ' + round;
      socket.emit('host:countdown', { n: v });
      beep(v);
    }
    showN(n);
    countdownTimer = pInterval(function () {
      n--;
      if (n >= 1) showN(n);
      else { pClear(countdownTimer); countdownTimer = null; beginPlay(); }
    }, COUNTDOWN_STEP_MS);
  }

  function beginPlay() {
    countOverlay.hidden = true;
    matchState = 'play';
    updatePauseBtn();
    if (world) world.frozen = false;
    acc = 0; lastFrame = performance.now(); lastClockEmit = 0;
    socket.emit('host:play', {});
  }

  function startLoop() { if (rafId) cancelAnimationFrame(rafId); lastFrame = performance.now(); acc = 0; rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    let dt = (now - lastFrame) / 1000; lastFrame = now;
    if (dt > 0.1) dt = 0.1;

    if (matchState === 'play' && !paused && world) {
      // Apply queued controller inputs.
      while (inputQueue.length) { const q = inputQueue.shift(); world.setDesiredDir(q.id, q.dir); }
      if (!world.settleFreeze) driveBots(dt);
      acc += dt;
      let steps = 0;
      const agg = { pellets: 0, powerEaten: [], ghostsEaten: [], playerKills: [], deaths: [], fruitEaten: false, cherryEaters: [], boardCleared: false };
      while (acc >= FIXED_DT && steps < MAX_STEPS) {
        const ev = world.step(FIXED_DT);
        agg.pellets += ev.pellets;
        if (ev.powerEaten.length) agg.powerEaten.push.apply(agg.powerEaten, ev.powerEaten);
        if (ev.ghostsEaten.length) agg.ghostsEaten.push.apply(agg.ghostsEaten, ev.ghostsEaten);
        if (ev.playerKills.length) agg.playerKills.push.apply(agg.playerKills, ev.playerKills);
        if (ev.deaths.length) agg.deaths.push.apply(agg.deaths, ev.deaths);
        if (ev.fruitEaten) agg.fruitEaten = true;
        if (ev.fruitBy) agg.cherryEaters.push(ev.fruitBy);
        if (ev.boardCleared) agg.boardCleared = true;
        acc -= FIXED_DT; steps++;
      }
      handleEvents(agg);
      foldStats(agg);
      // Power on/off transitions → notify phones.
      for (const p of world.players) {
        if (p.powered !== prevPowered[p.id]) { prevPowered[p.id] = p.powered; socket.emit('host:powered', { id: p.id, on: p.powered }); }
      }
      // Clock.
      clockMs -= dt * 1000;
      if (clockMs < 0) clockMs = 0;
      updateScoreStrip();
      if (now - lastClockEmit >= CLOCK_EMIT_MS) {
        lastClockEmit = now;
        socket.emit('host:clock', { ms: Math.max(0, clockMs), scores: world.scores() });
      }
      // Round-end conditions: the clock runs out, EVERYONE is dead, or a lone
      // survivor has already CLINCHED the round (see below). A lone survivor
      // otherwise keeps playing (racking up points) until the timer or their own
      // death — the round is won on SCORE, not on being the last one standing.
      // (The board auto-refills when cleared, so it never ends on empty pellets.)
      let clinched = false;
      if (world.aliveCount() === 1) {
        // The one survivor's score can only rise and every dead player's score is
        // frozen — so once the survivor is strictly on top, the win is guaranteed.
        // End now instead of a pointless victory lap.
        const sc = world.scores();
        let surv = null, maxDead = -1;
        world.players.forEach(function (p) {
          if (p.alive) surv = p;
          else maxDead = Math.max(maxDead, sc[p.id] || 0);
        });
        if (surv && (sc[surv.id] || 0) > maxDead) clinched = true;
      }
      if ((clockMs <= 0 || world.aliveCount() === 0 || clinched) && roundEndAt === null) {
        // Freeze the board the instant the round is decided, however it ended
        // (clock out, everyone dead, or a clinch) — a short beat so players can
        // read the final board before the scoreboard slides in.
        roundEndAt = now;
        world.settleFreeze = true;
        showEndReason(world.aliveCount() === 0 ? 'down' : (clinched ? 'clinch' : 'time'));
      }
      if (roundEndAt !== null && (now - roundEndAt) >= ROUND_END_HOLD_MS && !world.anyDying()) {
        // Held long enough AND any final death animation has finished.
        endRound();
      }
    }

    if (renderer) renderer.render(dt);
  }

  function handleEvents(agg) {
    if (agg.pellets > 0) playChomp();
    if (agg.fruitEaten) playFruit();
    if (agg.powerEaten.length) playPower();
    if (agg.boardCleared) playLookUp();
    if (agg.ghostsEaten.length) playGhostEat();
    for (const d of agg.deaths) {
      socket.emit('host:eliminated', { id: d });
    }
    if (agg.deaths.length) playDeath();
  }

  // Fold a frame's events into the running award stats.
  function foldStats(agg) {
    if (!stats) return;
    for (const k of agg.playerKills) if (stats[k.killer]) stats[k.killer].kills++;
    for (const g of agg.ghostsEaten) if (stats[g.by]) stats[g.by].ghosts++;
    for (const id of agg.powerEaten) if (stats[id]) stats[id].powers++;
    for (const id of agg.cherryEaters) if (stats[id]) stats[id].cherries++;
    if (agg.deaths.length && world) {
      const sec = world.now; // seconds survived this round (round clock)
      for (const id of agg.deaths) {
        if (stats[id]) stats[id].deaths++;
        if (!fastestDeath || sec < fastestDeath.sec) fastestDeath = { id: id, sec: sec, round: round };
      }
    }
  }

  // Brief banner shown during the round-end freeze, naming how the round ended.
  function showEndReason(kind) {
    if (!reasonOverlay || !reasonText) return;
    const label = kind === 'down' ? "Everyone's down!"
      : kind === 'clinch' ? 'Last one leading!'
      : "Time's up!";
    reasonText.textContent = label;
    reasonOverlay.hidden = false;
    reasonText.style.animation = 'none'; void reasonText.offsetWidth; reasonText.style.animation = '';
  }

  function endRound() {
    if (matchState !== 'play') return;
    matchState = 'roundover';
    updatePauseBtn();
    if (reasonOverlay) reasonOverlay.hidden = true;
    if (world) world.frozen = true;
    const scores = world.scores();
    // Accumulate award stats for this round (total points + rounds survived).
    world.players.forEach(function (p) {
      if (stats[p.id]) { stats[p.id].total += (scores[p.id] || 0); if (p.alive) stats[p.id].survived++; }
    });
    // Round winner: highest SCORE among ALL players (alive or dead) — scoring is
    // what wins the round, but staying alive lets you keep scoring. On a score
    // tie, a player still ALIVE beats a dead one (earned it under pressure); if
    // every tied leader is dead, they share the round.
    let max = -1;
    world.players.forEach(function (p) { if ((scores[p.id] || 0) > max) max = scores[p.id] || 0; });
    const tied = world.players.filter(function (p) { return (scores[p.id] || 0) === max; });
    const aliveTied = tied.filter(function (p) { return p.alive; });
    const winnerIds = (aliveTied.length ? aliveTied : tied).map(function (p) { return p.id; });
    winnerIds.forEach(function (id) { gamePoints[id] = (gamePoints[id] || 0) + 1; });

    // Did anyone reach the target?
    const champs = roster.filter(function (r) { return (gamePoints[r.id] || 0) >= roundsToWin; }).map(function (r) { return r.id; });

    socket.emit('host:roundOver', { round: round, scores: scores, winnerIds: winnerIds, gamePoints: gamePoints, alive: aliveMap() });
    updateScoreStrip();
    renderRoundOverlay(winnerIds, scores);
    playRoundWin();

    if (roundOverTimer) pClear(roundOverTimer);
    roundOverTimer = pTimeout(function () {
      roundOverlay.hidden = true;
      if (champs.length) endMatch(champs);
      else beginRound(round + 1);
    }, ROUNDOVER_MS);
  }

  function aliveMap() { const o = {}; if (world) for (const p of world.players) o[p.id] = p.alive; return o; }

  function endMatch(champs) {
    matchState = 'ended';
    paused = false;
    pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    stopLoop();
    finalAwards = computeAwards();
    socket.emit('host:matchEnd', { winnerIds: champs, gamePoints: gamePoints, awards: finalAwards });
    playGameWin();
    launchConfetti();
    renderFinal(champs);
  }

  // Build the end-of-game award cards from the accumulated stats. Each award
  // picks the top player(s) for a metric; cards with no qualifier are omitted
  // (High Roller always has one). Returns [{ emoji, title, names, color, value }].
  function nameOf(id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.name : '?'; }
  function colorOf(id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.color : '#fff'; }
  function topStat(key) {
    let best = -1, ids = [];
    roster.forEach(function (r) {
      const v = (stats[r.id] || {})[key] || 0;
      if (v > best) { best = v; ids = [r.id]; }
      else if (v === best) ids.push(r.id);
    });
    return { value: best, ids: ids };
  }
  function makeAward(emoji, title, ids, value, minValue) {
    if (!ids || !ids.length || value < (minValue == null ? 1 : minValue)) return null;
    return {
      emoji: emoji, title: title,
      names: ids.map(nameOf).join(' & '),
      color: ids.length === 1 ? colorOf(ids[0]) : '#FFE100',
      value: value,
    };
  }
  function computeAwards() {
    const out = [];
    const high = topStat('total');
    // High Roller always shows (even at 0).
    out.push({ emoji: '💰', title: 'High Roller', names: high.ids.map(nameOf).join(' & '),
      color: high.ids.length === 1 ? colorOf(high.ids[0]) : '#FFE100', value: high.value + ' pts' });
    const preds = topStat('kills'); const pa = makeAward('😈', 'Apex Predator', preds.ids, preds.value);
    if (pa) { pa.value = preds.value + (preds.value === 1 ? ' eaten' : ' eaten'); out.push(pa); }
    if (fastestDeath) {
      out.push({ emoji: '💀', title: 'First to Fall', names: nameOf(fastestDeath.id), color: colorOf(fastestDeath.id),
        value: 'died in ' + Math.max(1, Math.round(fastestDeath.sec)) + 's · R' + fastestDeath.round });
    }
    const gb = topStat('ghosts'); const ga = makeAward('👻', 'Ghostbuster', gb.ids, gb.value);
    if (ga) { ga.value = gb.value + (gb.value === 1 ? ' ghost' : ' ghosts'); out.push(ga); }
    const ph = topStat('powers'); const pha = makeAward('⚡', 'Power Hungry', ph.ids, ph.value);
    if (pha) { pha.value = ph.value + (ph.value === 1 ? ' power-up' : ' power-ups'); out.push(pha); }
    const st = topStat('cherries'); const sta = makeAward('🍒', 'Sweet Tooth', st.ids, st.value);
    if (sta) { sta.value = st.value + (st.value === 1 ? ' cherry' : ' cherries'); out.push(sta); }
    return out;
  }

  // ---------------- Scoreboard ----------------
  function buildScoreStrip() {
    scoreStrip.innerHTML = '';
    roster.forEach(function (r) {
      const card = document.createElement('div'); card.className = 'sc-card'; card.dataset.pid = r.id;
      card.style.setProperty('--pc', r.color);
      const crown = document.createElement('div'); crown.className = 'sc-crown'; crown.textContent = '👑';
      const top = document.createElement('div'); top.className = 'sc-top';
      const dot = document.createElement('span'); dot.className = 'sc-dot'; dot.style.background = r.color;
      const name = document.createElement('span'); name.className = 'sc-name'; name.textContent = r.name;
      top.appendChild(dot); top.appendChild(name);
      const score = document.createElement('div'); score.className = 'sc-score'; score.textContent = '0';
      const pips = document.createElement('div'); pips.className = 'sc-pips';
      card.appendChild(crown); card.appendChild(top); card.appendChild(score); card.appendChild(pips);
      scoreStrip.appendChild(card);
    });
  }
  function updateScoreStrip() {
    if (sbRound) sbRound.textContent = 'Round ' + round;
    if (sbClock) { sbClock.textContent = fmtClock(clockMs); sbClock.classList.toggle('urgent', clockMs <= 10000); }
    const scores = world ? world.scores() : {};
    const cards = scoreStrip.children;
    // Leader = the player(s) with the strictly-highest round score, but only once
    // someone is actually on the board (max > 0), so nobody is crowned at 0-0.
    let maxScore = 0;
    for (let i = 0; i < cards.length; i++) { maxScore = Math.max(maxScore, scores[cards[i].dataset.pid] || 0); }
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]; const pid = card.dataset.pid;
      const p = world ? world.byId.get(pid) : null;
      card.querySelector('.sc-score').textContent = scores[pid] || 0;
      card.classList.toggle('dead', !!(p && !p.alive));
      card.classList.toggle('leader', maxScore > 0 && (scores[pid] || 0) === maxScore);
      // Game-point pips.
      const pipsEl = card.querySelector('.sc-pips');
      const want = roundsToWin, have = gamePoints[pid] || 0;
      if (pipsEl.children.length !== want) {
        pipsEl.innerHTML = '';
        for (let k = 0; k < want; k++) { const d = document.createElement('span'); d.className = 'pip'; pipsEl.appendChild(d); }
      }
      for (let k = 0; k < pipsEl.children.length; k++) pipsEl.children[k].classList.toggle('on', k < have);
    }
  }

  function renderRoundOverlay(winnerIds, scores) {
    const names = winnerIds.map(function (id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.name : '?'; });
    roTitle.textContent = names.length ? (names.join(' & ') + (names.length > 1 ? ' tie the round!' : ' wins the round!')) : 'Round over';
    roList.innerHTML = '';
    const sorted = roster.slice().sort(function (a, b) { return (scores[b.id] || 0) - (scores[a.id] || 0); });
    sorted.forEach(function (r) {
      const row = document.createElement('div'); row.className = 'ro-row' + (winnerIds.indexOf(r.id) >= 0 ? ' win' : '');
      const dot = document.createElement('span'); dot.className = 'ro-dot'; dot.style.background = r.color;
      const nm = document.createElement('span'); nm.className = 'ro-name'; nm.textContent = r.name;
      const sc = document.createElement('span'); sc.className = 'ro-score'; sc.textContent = (scores[r.id] || 0) + ' pts';
      const gp = document.createElement('span'); gp.className = 'ro-gp'; gp.textContent = '🏆 ' + (gamePoints[r.id] || 0);
      row.appendChild(dot); row.appendChild(nm); row.appendChild(sc); row.appendChild(gp);
      roList.appendChild(row);
    });
    roundOverlay.hidden = false;
  }

  function renderFinal(champs) {
    const names = champs.map(function (id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.name : '?'; });
    finalTrophy.textContent = '🏆';
    finalHeading.textContent = names.length > 1 ? (names.join(' & ') + ' win!') : ((names[0] || 'Someone') + ' wins!');
    finalList.innerHTML = '';
    const sorted = roster.slice().sort(function (a, b) { return (gamePoints[b.id] || 0) - (gamePoints[a.id] || 0); });
    sorted.forEach(function (r) {
      const row = document.createElement('div'); row.className = 'fn-row' + (champs.indexOf(r.id) >= 0 ? ' win' : '');
      const dot = document.createElement('span'); dot.className = 'fn-dot'; dot.style.background = r.color;
      const nm = document.createElement('span'); nm.className = 'fn-name'; nm.textContent = r.name;
      const gp = document.createElement('span'); gp.className = 'fn-gp'; gp.textContent = '🏆 ' + (gamePoints[r.id] || 0);
      row.appendChild(dot); row.appendChild(nm); row.appendChild(gp);
      finalList.appendChild(row);
    });
    renderAwards(finalAwards);
    show('final');
  }

  function renderAwards(awards) {
    if (!finalAwards_el) return;
    finalAwards_el.innerHTML = '';
    const list = awards || [];
    if (finalAwardsSection) finalAwardsSection.hidden = list.length === 0;
    list.forEach(function (a) {
      const card = document.createElement('div'); card.className = 'award-card';
      const emoji = document.createElement('div'); emoji.className = 'aw-emoji'; emoji.textContent = a.emoji;
      const title = document.createElement('div'); title.className = 'aw-title'; title.textContent = a.title;
      const who = document.createElement('div'); who.className = 'aw-name'; who.textContent = a.names; who.style.color = a.color;
      const val = document.createElement('div'); val.className = 'aw-value'; val.textContent = a.value;
      card.appendChild(emoji); card.appendChild(title); card.appendChild(who); card.appendChild(val);
      finalAwards_el.appendChild(card);
    });
  }
  // ---------------- Confetti ----------------
  function launchConfetti() {
    const colors = ['#FFE100', '#3DDC84', '#A96BFF', '#34C6FF', '#FF3B30'];
    for (let i = 0; i < 80; i++) {
      const d = document.createElement('div');
      d.className = 'confetti';
      d.style.left = (Math.random() * 100) + 'vw';
      d.style.background = colors[(Math.random() * colors.length) | 0];
      d.style.animationDelay = (Math.random() * 0.6) + 's';
      d.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
      document.body.appendChild(d);
      setTimeout(function () { d.remove(); }, 3200);
    }
  }

  // ---------------- Input + presence relays ----------------
  socket.on('in', function (d) { if (d && world) inputQueue.push(d); });
  socket.on('emote', function (d) {
    if (!world || !d || !d.id || !d.e) return;
    const p = world.byId.get(d.id); if (!p) return;
    p.emote = { char: String(d.e), until: performance.now() + EMOTE_MS };
  });
  socket.on('player:dropped', function (d) { if (world && d) { const p = world.byId.get(d.id); if (p) { p.connected = false; world.clearInputs(d.id); } } });
  socket.on('player:rejoined', function (d) { if (world && d) { const p = world.byId.get(d.id); if (p) p.connected = true; } });

  // ---------------- Bot AI (local chomper CPUs) ----------------
  function driveBots(dt) {
    if (!world || !botIds.length) return;
    for (const id of botIds) { const p = world.byId.get(id); if (p && p.alive) botThink(p); }
  }
  function botThink(p) {
    const b = world.board;
    const W = b.w, H = b.h;
    const pr = Math.round(p.y), pc = ((Math.round(p.x) % W) + W) % W;
    // Threat distance field (multi-source BFS). Active ghosts are always deadly.
    // A POWERED rival chomper can eat this bot too — but only while the bot is
    // UN-powered (two powered chompers merely knock each other back), so include
    // powered rivals as threats only then. Frightened ghosts are edible, not
    // dangerous, so they're never threats.
    const threatCells = [];
    for (const g of world.ghosts) {
      if (g.state === 'active') threatCells.push([Math.round(g.y), ((Math.round(g.x) % W) + W) % W]);
    }
    if (!p.powered) {
      for (const q of world.players) {
        if (q.alive && q.powered && q.id !== p.id) threatCells.push([Math.round(q.y), ((Math.round(q.x) % W) + W) % W]);
      }
    }
    const threatDist = bfsField(threatCells);
    const nearThreat = threatDist[pr] ? threatDist[pr][pc] : Infinity;

    // Flee a nearby threat (a normal ghost OR a powered rival) — step toward the
    // tile that maximises distance from every threat. A normal ghost is deadly
    // even while powered; a powered rival is only in `threatCells` when the bot
    // is un-powered, so this same branch covers both.
    if (nearThreat <= 6) {
      let best = -1, bestD = -1;
      for (let idx = 0; idx < 4; idx++) {
        const dv = window.MazeChomp.DIRS[idx];
        const nr = pr + dv.y, nc = ((pc + dv.x) % W + W) % W;
        if (!passableForChomper(nr, nc)) continue;
        const gd = threatDist[nr] ? threatDist[nr][nc] : Infinity;
        const val = gd === Infinity ? 999 : gd;
        if (val > bestD) { bestD = val; best = idx; }
      }
      if (best >= 0) { world.setDesiredDir(p.id, best); return; }
    }
    // Goal set: powered → frightened ghosts + weaker players; else pellets/power/fruit.
    let goals = new Set();
    if (p.powered) {
      for (const g of world.ghosts) if (g.state === 'frightened') goals.add(Math.round(g.y) + ',' + (((Math.round(g.x) % W) + W) % W));
      for (const q of world.players) if (q.alive && !q.powered && q.id !== p.id) goals.add(Math.round(q.y) + ',' + (((Math.round(q.x) % W) + W) % W));
    }
    if (!goals.size) {
      for (const key of b.pellets) goals.add(key);
      for (const key of b.powerPellets) goals.add(key);
      if (world.fruit) goals.add(world.fruit.r + ',' + world.fruit.c);
    }
    const step = bfsFirstStep([pr, pc], goals);
    if (step >= 0) world.setDesiredDir(p.id, step);
  }
  function passableForChomper(r, c) {
    const b = world.board; if (r < 0 || r >= b.h) return false;
    const cc = ((c % b.w) + b.w) % b.w; const t = b.tiles[r][cc];
    return t === 1; // path only (not wall, not door)
  }
  function bfsField(sources) {
    const b = world.board, W = b.w, H = b.h;
    const dist = []; for (let r = 0; r < H; r++) dist.push(new Array(W).fill(Infinity));
    const q = [];
    for (const s of sources) { if (s[0] >= 0 && s[0] < H) { dist[s[0]][((s[1] % W) + W) % W] = 0; q.push(s); } }
    let head = 0;
    while (head < q.length) {
      const [r, c] = q[head++]; const d = dist[r][c];
      for (const dv of window.MazeChomp.DIRS) {
        const nr = r + dv.y, nc = ((c + dv.x) % W + W) % W;
        if (!passableForChomper(nr, nc)) continue;
        if (dist[nr][nc] > d + 1) { dist[nr][nc] = d + 1; q.push([nr, nc]); }
      }
    }
    return dist;
  }
  function bfsFirstStep(start, goalSet) {
    const b = world.board, W = b.w, H = b.h;
    if (goalSet.has(start[0] + ',' + start[1])) return -1;
    const prev = []; for (let r = 0; r < H; r++) prev.push(new Array(W).fill(null));
    const seen = []; for (let r = 0; r < H; r++) seen.push(new Array(W).fill(false));
    const q = [start]; seen[start[0]][start[1]] = true;
    let head = 0, foundr = -1, foundc = -1;
    while (head < q.length) {
      const [r, c] = q[head++];
      if (goalSet.has(r + ',' + c) && !(r === start[0] && c === start[1])) { foundr = r; foundc = c; break; }
      for (let idx = 0; idx < 4; idx++) {
        const dv = window.MazeChomp.DIRS[idx];
        const nr = r + dv.y, nc = ((c + dv.x) % W + W) % W;
        if (nr < 0 || nr >= H || seen[nr][nc]) continue;
        if (!passableForChomper(nr, nc)) continue;
        seen[nr][nc] = true; prev[nr][nc] = [r, c, idx]; q.push([nr, nc]);
      }
    }
    if (foundr < 0) return -1;
    // Walk back to the first step from start.
    let cur = [foundr, foundc], firstDir = -1;
    while (prev[cur[0]][cur[1]]) { const prv = prev[cur[0]][cur[1]]; firstDir = prv[2]; cur = [prv[0], prv[1]]; }
    return firstDir;
  }

  // ---------------- Boot ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      renderQR();
      renderLobby(res.lobby);
      roundsToWin = res.lobby.roundsToWin; roundLengthSec = res.lobby.roundLengthSec;
      if (res.phase === 'LOBBY') show('lobby');
      else if (res.phase === 'PLAYING' && res.match) {
        // Host refreshed mid-match: restart the CURRENT round fresh, preserving
        // game points + round number (positions/pellet progress can't restore).
        startMatch(res.match.roster, { roundLengthSec: res.match.roundLengthSec, roundsToWin: res.match.roundsToWin }, {
          gamePoints: res.match.gamePoints, round: res.match.round,
        });
      } else if (res.phase === 'FINAL' && res.match) {
        roster = res.match.roster || [];
        gamePoints = res.match.gamePoints || {};
        roundsToWin = res.match.roundsToWin;
        finalAwards = res.match.awards || null;
        renderFinal(res.match.winnerIds || []);
      }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
  });

  socket.on('state:lobby', function (l) {
    if (l && l.phase === 'LOBBY') { renderLobby(l); if (!views.match.classList.contains('active') && !views.final.classList.contains('active')) show('lobby'); }
  });
  socket.on('state:reset', function () {
    stopLoop();
    pClearAll();
    countdownTimer = null; roundOverTimer = null;
    paused = false;
    matchState = 'idle'; world = null; renderer = null; lastHumanTotal = -1;
    stats = {}; fastestDeath = null; finalAwards = null;
    if (roundOverlay) roundOverlay.hidden = true; if (countOverlay) countOverlay.hidden = true;
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    show('lobby');
  });

  window.addEventListener('resize', function () { if (renderer) renderer.resize(); });
})();
