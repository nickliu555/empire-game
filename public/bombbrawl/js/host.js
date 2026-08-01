(function () {
  'use strict';

  const socket = io('/bombbrawl', { transports: ['polling', 'websocket'] });
  const BB = window.BombBrawl;

  // ---------------- Tunables ----------------
  const FIXED_DT = 1 / 120;
  const MAX_STEPS = 20;
  const COUNTDOWN_FROM = 3;
  const COUNTDOWN_STEP_MS = 800;
  const CLOCK_EMIT_MS = 250;
  const ROUNDOVER_MS = 7000;
  const ROUND_END_HOLD_MS = 2000;   // let the last death animation finish
  const SLOWMO_SCALE = 0.4;         // sim speed from the deciding kill to the round card
                                    // (0.4 x ROUND_END_HOLD_MS = 0.8s of sim, just enough
                                    //  for the 0.75s death animation to finish first)
  const SD_START_SEC = 30;          // sudden death kicks in with this much left

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
  const powSeg = document.getElementById('powSeg');
  const diffSeg = document.getElementById('diffSeg');
  const slotList = document.getElementById('slotList');
  const configHint = document.getElementById('configHint');
  const startBtn = document.getElementById('startBtn');

  const canvas = document.getElementById('arena');
  const scoreStrip = document.getElementById('scoreStrip');
  const sbRound = document.getElementById('sbRound');
  const sbTarget = document.getElementById('sbTarget');
  const sbClock = document.getElementById('sbClock');
  const countOverlay = document.getElementById('countOverlay');
  const coNum = document.getElementById('coNum');
  const coNote = document.getElementById('coNote');
  const roundOverlay = document.getElementById('roundOverlay');
  const roBadge = document.getElementById('roBadge');
  const roTitle = document.getElementById('roTitle');
  const roSub = document.getElementById('roSub');
  const roList = document.getElementById('roList');

  const finalHeading = document.getElementById('finalHeading');
  const finalList = document.getElementById('finalList');
  const backToLobbyBtn = document.getElementById('backToLobbyBtn');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const pauseOverlay = document.getElementById('pauseOverlay');

  let reduceMotion = false;
  try { reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}

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
  backToLobbyBtn && backToLobbyBtn.addEventListener('click', function () {
    socket.emit('host:reset', {});
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
          if (window.Iris && typeof window.Iris.transitionTo === 'function') window.Iris.transitionTo('/', origin, { emoji: '💣', name: 'Game Hub', color: '#171233' });
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
  function sweep(f0, f1, dur, type, gain, when) {
    const c = getAudioCtx(); if (!c) return;
    const t = when || c.currentTime;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  let noiseBuf = null;
  function getNoise(c) {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(c.sampleRate * 1.2);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  /** Filtered noise burst — the backbone of every explosion/thud. */
  function boom(dur, f0, f1, gain) {
    const c = getAudioCtx(); if (!c) return;
    const t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = getNoise(c);
    const flt = c.createBiquadFilter(); flt.type = 'lowpass';
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(c.destination);
    src.start(t); src.stop(t + dur + 0.02);
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
  function playLookUp() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime; [392, 523, 659, 784].forEach(function (f, i) { blip(f, 0.16, 'triangle', 0.14, b + i * 0.08); }); }
  function beep(n) { blip(440 + (COUNTDOWN_FROM - n) * 120, 0.1, 'square', 0.14); }
  function playGo() { blip(880, 0.22, 'square', 0.18); }
  let lastDrop = 0;
  function playBombDrop() {
    const c = getAudioCtx(); if (!c) return;
    if (c.currentTime - lastDrop < 0.05) return;
    lastDrop = c.currentTime;
    sweep(420, 140, 0.12, 'sine', 0.16);
  }
  let lastBoom = 0;
  function playExplosion(size) {
    const c = getAudioCtx(); if (!c) return;
    if (c.currentTime - lastBoom < 0.045) return;
    lastBoom = c.currentTime;
    const s = Math.min(1.6, 0.7 + (size || 3) * 0.06);
    boom(0.42 * s, 1400, 60, 0.42);
    sweep(150, 38, 0.3, 'sine', 0.28);
  }
  function playPowerUp() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime; [784, 988, 1319].forEach(function (f, i) { blip(f, 0.11, 'square', 0.12, b + i * 0.055); }); }
  function playDeath() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime; [440, 349, 262, 175].forEach(function (f, i) { blip(f, 0.16, 'triangle', 0.17, b + i * 0.1); }); }
  function playCrate() { boom(0.13, 2600, 500, 0.13); }
  function playKick() { blip(300, 0.07, 'square', 0.1); }
  let lastThud = 0;
  function playThud() {
    const c = getAudioCtx(); if (!c) return;
    if (c.currentTime - lastThud < 0.08) return;
    lastThud = c.currentTime;
    boom(0.2, 480, 60, 0.24);
  }
  function playSuddenDeath() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [0, 0.22, 0.44].forEach(function (o) { sweep(220, 110, 0.2, 'sawtooth', 0.2, b + o); });
    boom(0.6, 900, 60, 0.3);
  }
  function playRoundWin() { const c = getAudioCtx(); if (!c) return; const b = c.currentTime; [523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.24, 'sawtooth', 0.14, b + i * 0.08); }); }
  function playGameWin() {
    const c = getAudioCtx(); if (!c) return; const b = c.currentTime;
    [523, 659, 784, 1047, 1319, 1568].forEach(function (f, i) { blip(f, 0.3, 'sawtooth', 0.15, b + i * 0.1); });
  }

  // ---------------- Lobby ----------------
  let lobby = { players: [], total: 0, capacity: 4, minPlayers: 2, roundLengthSec: 120, roundsToWin: 3, powerUps: true, botDifficulty: 'normal', canStart: false };
  let lastHumanTotal = -1;
  let dragActive = false;
  let pendingLobby = null;

  function fmtClock(ms) { const t = Math.max(0, Math.ceil(ms / 1000)); const m = Math.floor(t / 60), s = t % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtDur(sec) { const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  function renderQR() {
    fetch('/api/bombbrawl/config').then(function (r) { return r.json(); }).then(function (cfg) {
      const url = (cfg && cfg.joinUrl) || (window.location.origin + '/bombbrawl/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      return fetch('/api/bombbrawl/qr?url=' + encodeURIComponent(url));
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
    setSeg(powSeg, 'pow', l.powerUps ? '1' : '0');
    setSeg(diffSeg, 'diff', l.botDifficulty);

    slotList.innerHTML = '';
    l.players.forEach(function (p, i) {
      const el = document.createElement('div');
      el.className = 'player-chip' + (p.connected === false ? ' disconnected' : '') + (p.isBot ? ' is-bot' : '');
      el.dataset.pid = p.id;
      el.style.setProperty('--pc', p.color);
      const grip = document.createElement('span'); grip.className = 'chip-grip'; grip.textContent = '⠿';
      const seat = document.createElement('span'); seat.className = 'chip-seat'; seat.textContent = String(i + 1);
      const label = document.createElement('span'); label.className = 'chip-name'; label.textContent = p.name;
      const corner = document.createElement('span'); corner.className = 'chip-corner'; corner.textContent = p.corner || '';
      const kick = document.createElement('button'); kick.className = 'chip-kick'; kick.type = 'button'; kick.textContent = '✕';
      kick.title = p.isBot ? 'Remove CPU' : 'Remove player';
      kick.addEventListener('click', function (e) { e.stopPropagation(); socket.emit('host:kick', { playerId: p.id }); });
      el.appendChild(grip); el.appendChild(seat); el.appendChild(label); el.appendChild(corner); el.appendChild(kick);
      slotList.appendChild(el);
    });
    for (let i = l.players.length; i < l.capacity; i++) {
      const e = document.createElement('div'); e.className = 'slot-empty'; e.textContent = 'Open spot'; slotList.appendChild(e);
    }
    startBtn.disabled = !l.canStart;    if (addBotBtn) addBotBtn.disabled = l.total >= l.capacity;
    configHint.textContent = l.canStart ? '' : ('Need at least ' + l.minPlayers + ' bombers (add a CPU to fill in).');
  }

  function setSeg(seg, attr, value) {
    if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('on', b.dataset[attr] === String(value));
    });
  }

  // ---- Smooth pointer-drag to reorder the lobby (order = seat/colour/corner) --
  (function setupLobbyDrag() {
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
      previewOrder();
    }
    /** Live-update seat number, colour and corner while a chip is being dragged. */
    function previewOrder() {
      let seat = 0;
      Array.prototype.forEach.call(slotList.children, function (n) {
        // The lifted chip is still a DOM child but is drawn at the pointer —
        // it takes its place at the placeholder instead.
        if (n === d.el) return;
        const chip = n === d.ph ? d.el : n;
        if (!chip.classList || !chip.classList.contains('player-chip')) return;
        // Seat, colour and corner belong to the slot, not the player, so they
        // re-map as chips move past each other.
        const slot = lobby.players[seat];
        seat++;
        chip.querySelector('.chip-seat').textContent = String(seat);
        if (!slot) return;
        chip.style.setProperty('--pc', slot.color);
        chip.querySelector('.chip-corner').textContent = slot.corner || '';
      });
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
  powSeg && powSeg.addEventListener('click', function (e) {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    setSeg(powSeg, 'pow', b.dataset.pow);
    socket.emit('host:setPowerUps', { on: b.dataset.pow === '1' });
  });
  diffSeg && diffSeg.addEventListener('click', function (e) {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    setSeg(diffSeg, 'diff', b.dataset.diff);
    socket.emit('host:setBotDifficulty', { level: b.dataset.diff });
  });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (!res || !res.ok) { toast('Need at least 2 bombers to start.'); return; }
      startMatch(res.roster, res, null);
    });
  });

  // ---------------- Match state ----------------
  let world = null, renderer = null, rafId = null, lastFrame = 0, acc = 0;
  let matchState = 'idle'; // idle | countdown | play | roundover | ended
  let roster = [];
  let roundLengthSec = 120, roundsToWin = 3, powerUps = true, botDifficulty = 'normal';
  let round = 1;
  let clockMs = 0, lastClockEmit = 0;
  let gamePoints = {};
  let roundEndAt = null;
  let countdownTimer = null, roundOverTimer = null;
  let bots = [];
  let sdStarted = false;
  let prevHud = {};

  // ---------------- Pause ----------------
  // The whole simulation runs in this browser, so pausing means: stop stepping
  // the world/clock in loop(), and freeze every wall-clock timer so the
  // sequence resumes exactly where it left off.
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
          if (!pausableTimers.has(rec)) return; // fn() may have cleared it
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
    if (world) { world.frozen = true; world.clearInputs(); }
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

  // ---------------- Match flow ----------------
  function startMatch(rost, cfg, initial) {
    roster = rost || [];
    roundLengthSec = (cfg && cfg.roundLengthSec) || 120;
    roundsToWin = (cfg && cfg.roundsToWin) || 3;
    powerUps = cfg && cfg.powerUps !== undefined ? !!cfg.powerUps : true;
    botDifficulty = (cfg && cfg.botDifficulty) || 'normal';
    gamePoints = {};
    roster.forEach(function (r) { gamePoints[r.id] = 0; });
    if (initial && initial.gamePoints) { for (const id in initial.gamePoints) if (id in gamePoints) gamePoints[id] = initial.gamePoints[id]; }
    round = (initial && initial.round) || 1;
    show('match');
    buildScoreStrip();
    startLoop();
    beginRound(round);
  }

  function beginRound(r) {
    round = r;
    const seed = (Math.random() * 2147483647) | 0;
    world = new BB.World({ powerUps: powerUps });
    world.reset(seed, roster);
    world.frozen = true;
    if (!renderer) renderer = new window.BombBrawlRender.Renderer(canvas, world);
    else { renderer.setWorld(world); renderer.clearFx(); }
    bots = roster.filter(function (x) { return x.isBot; })
      .map(function (x) { return new window.BombBrawlBot.Bot(x.id, botDifficulty); });
    prevHud = {};
    sdStarted = false;
    clockMs = roundLengthSec * 1000;
    roundEndAt = null;
    paused = false; pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;
    if (roundOverlay) roundOverlay.hidden = true;
    updateScoreStrip();
    requestAnimationFrame(function () { if (renderer) renderer.resize(); });
    socket.emit('host:roundStart', { round: round, seed: seed, durationSec: roundLengthSec });
    socket.emit('host:board', { board: { round: round, gamePoints: gamePoints } });
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
      socket.emit('host:countdown', { n: v, note: 'Round ' + round });
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
    playGo();
    socket.emit('host:play', {});
  }

  function startLoop() { if (rafId) cancelAnimationFrame(rafId); lastFrame = performance.now(); acc = 0; rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    let dt = (now - lastFrame) / 1000; lastFrame = now;
    if (dt > 0.1) dt = 0.1;

    // Once the round is decided everything plays out in slow motion until the
    // round card drops — the sim, the debris and the flames all crawl while
    // real time keeps running underneath.
    const simDt = (matchState === 'play' && roundEndAt !== null) ? dt * SLOWMO_SCALE : dt;

    if (matchState === 'play' && !paused && world) {
      // A brief hit-stop on a kill makes the death land harder.
      if (renderer && renderer.hitStop > 0) {
        renderer.hitStop = Math.max(0, renderer.hitStop - dt);
        acc = 0;
      } else {
        for (let i = 0; i < bots.length; i++) bots[i].update(world, simDt);
        acc += simDt;
        let steps = 0;
        while (acc >= FIXED_DT && steps < MAX_STEPS) {
          handleEvents(world.step(FIXED_DT));
          acc -= FIXED_DT; steps++;
        }
        emitHudChanges();

        clockMs -= dt * 1000;
        if (clockMs < 0) clockMs = 0;
        if (!sdStarted && clockMs <= SD_START_SEC * 1000) {
          sdStarted = true;
          world.startSuddenDeath();
          playSuddenDeath();
        }
        updateScoreStrip();
        if (now - lastClockEmit >= CLOCK_EMIT_MS) {
          lastClockEmit = now;
          socket.emit('host:clock', { ms: Math.max(0, clockMs), suddenDeath: sdStarted });
        }

        // The round is decided the moment one bomber (or nobody) is left.
        if (roundEndAt === null && world.alivePlayers().length <= 1) {
          roundEndAt = now;
        }
        if (roundEndAt !== null && (now - roundEndAt) >= ROUND_END_HOLD_MS) endRound();
      }
    }

    if (renderer) renderer.render(simDt);
  }

  function handleEvents(events) {
    if (!events || !events.length) return;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (renderer) renderer.onEvent(ev);
      switch (ev.type) {
        case 'bomb': playBombDrop(); break;
        case 'explode': playExplosion(ev.cells.length); break;
        case 'crate': playCrate(); break;
        case 'pickup': playPowerUp(); break;
        case 'kick': playKick(); break;
        case 'sdLand': playThud(); break;
        case 'death':
          playDeath();
          socket.emit('host:eliminated', { id: ev.id, by: ev.by });
          break;
        default: break;
      }
    }
  }

  /** Push power-up changes to the phones so their controller HUD stays in sync. */
  function emitHudChanges() {
    if (!world) return;
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i];
      if (p.isBot) continue;
      const h = world.hudOf(p);
      const prev = prevHud[p.id];
      if (!prev || prev.bombs !== h.bombs || prev.fire !== h.fire || prev.speed !== h.speed ||
          prev.kick !== h.kick || prev.out !== h.out) {
        prevHud[p.id] = h;
        socket.emit('host:hud', { id: p.id, bombs: h.bombs, fire: h.fire, speed: h.speed, kick: h.kick, out: h.out });
      }
    }
  }

  function endRound() {
    if (matchState !== 'play') return;
    matchState = 'roundover';
    updatePauseBtn();
    if (world) world.frozen = true;
    const alive = world.alivePlayers();
    const wipeout = alive.length === 0;
    const winnerId = wipeout ? lastToFall() : alive[0].id;
    if (winnerId) gamePoints[winnerId] = (gamePoints[winnerId] || 0) + 1;

    socket.emit('host:roundEnd', { round: round, winnerId: winnerId, gamePoints: gamePoints });
    updateScoreStrip();
    renderRoundOverlay(winnerId, wipeout);
    playRoundWin();

    const champs = roster.filter(function (r) { return (gamePoints[r.id] || 0) >= roundsToWin; }).map(function (r) { return r.id; });
    if (roundOverTimer) pClear(roundOverTimer);
    roundOverTimer = pTimeout(function () {
      roundOverlay.hidden = true;
      if (champs.length) endMatch(champs);
      else beginRound(round + 1);
    }, ROUNDOVER_MS);
  }

  /**
   * Nobody left standing still has a winner: the bomber who went down last.
   * Deaths inside the same tick are broken by who lit the fuse (blowing
   * yourself up loses to being blown up), then by who is further behind on the
   * scoreboard, then by seat — so a round never ends undecided.
   */
  function lastToFall() {
    const ps = world.players.slice().sort(function (a, b) {
      if (b.diedAt !== a.diedAt) return b.diedAt - a.diedAt;
      const selfA = a.killedBy === a.id ? 1 : 0, selfB = b.killedBy === b.id ? 1 : 0;
      if (selfA !== selfB) return selfA - selfB;
      const gpA = gamePoints[a.id] || 0, gpB = gamePoints[b.id] || 0;
      if (gpA !== gpB) return gpA - gpB;
      return a.seat - b.seat;
    });
    return ps.length ? ps[0].id : null;
  }

  function endMatch(champs) {
    matchState = 'ended';
    paused = false;
    pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    stopLoop();
    socket.emit('host:matchEnd', { winnerIds: champs, gamePoints: gamePoints });
    playGameWin();
    renderFinal(champs);
    const c = colorOf(champs[0]);
    launchConfetti(c);
  }

  function nameOf(id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.name : '?'; }
  function colorOf(id) { const r = roster.find(function (x) { return x.id === id; }); return r ? r.color : '#FFD23F'; }

  // ---------------- Scoreboard ----------------
  function buildScoreStrip() {
    scoreStrip.innerHTML = '';
    roster.forEach(function (r, i) {
      const card = document.createElement('div'); card.className = 'sc-card'; card.dataset.pid = r.id;
      card.style.setProperty('--pc', r.color);
      const top = document.createElement('div'); top.className = 'sc-top';
      const dot = document.createElement('span'); dot.className = 'sc-dot'; dot.style.background = r.color; dot.textContent = String(i + 1);
      const name = document.createElement('span'); name.className = 'sc-name'; name.textContent = r.name;
      top.appendChild(dot); top.appendChild(name);
      const pips = document.createElement('div'); pips.className = 'sc-pips';
      const stats = document.createElement('div'); stats.className = 'sc-stats';
      ['bombs', 'fire', 'speed', 'kick'].forEach(function (k) {
        const s = document.createElement('span'); s.dataset.stat = k; stats.appendChild(s);
      });
      const out = document.createElement('div'); out.className = 'sc-out'; out.textContent = 'OUT';
      card.appendChild(top); card.appendChild(pips); card.appendChild(stats); card.appendChild(out);
      scoreStrip.appendChild(card);
    });
  }

  function updateScoreStrip() {
    if (sbRound) sbRound.textContent = 'Round ' + round;
    if (sbTarget) sbTarget.textContent = 'First to ' + roundsToWin;
    if (sbClock) {
      sbClock.textContent = sdStarted ? 'SUDDEN DEATH' : fmtClock(clockMs);
      sbClock.classList.toggle('urgent', sdStarted || clockMs <= 30000);
    }
    const cards = scoreStrip.children;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]; const pid = card.dataset.pid;
      const p = world ? world.playerById(pid) : null;
      card.classList.toggle('dead', !!(p && !p.alive));

      const pipsEl = card.querySelector('.sc-pips');
      const want = roundsToWin, have = gamePoints[pid] || 0;
      if (pipsEl.children.length !== want) {
        pipsEl.innerHTML = '';
        for (let k = 0; k < want; k++) { const d = document.createElement('span'); d.className = 'pip'; pipsEl.appendChild(d); }
      }
      for (let k = 0; k < pipsEl.children.length; k++) pipsEl.children[k].classList.toggle('on', k < have);

      const h = p ? world.hudOf(p) : { bombs: 1, fire: 1, speed: 0, kick: false };
      setStat(card, 'bombs', '💣 ' + h.bombs, false);
      setStat(card, 'fire', '🔥 ' + h.fire, false);
      setStat(card, 'speed', '👟 ' + h.speed, h.speed === 0);
      setStat(card, 'kick', '🥾', !h.kick);
    }
  }

  function setStat(card, key, text, off) {
    const el = card.querySelector('[data-stat="' + key + '"]');
    if (!el) return;
    if (el.textContent !== text) {
      el.textContent = text;
      if (!reduceMotion) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    }
    el.classList.toggle('off', !!off);
  }

  function renderRoundOverlay(winnerId, wipeout) {
    roBadge.textContent = '🏆';
    roTitle.textContent = nameOf(winnerId) + ' wins the round!';
    roTitle.style.setProperty('--rc', colorOf(winnerId));
    roSub.textContent = wipeout ? 'Everyone went up — they fell last.' : 'Last bomber standing.';
    roList.innerHTML = '';
    const sorted = roster.slice().sort(function (a, b) { return (gamePoints[b.id] || 0) - (gamePoints[a.id] || 0); });
    sorted.forEach(function (r) {
      const row = document.createElement('div'); row.className = 'ro-row' + (r.id === winnerId ? ' win' : '');
      const dot = document.createElement('span'); dot.className = 'ro-dot'; dot.style.background = r.color;
      const nm = document.createElement('span'); nm.className = 'ro-name'; nm.textContent = r.name;
      const gp = document.createElement('span'); gp.className = 'ro-gp'; gp.textContent = '🏆 ' + (gamePoints[r.id] || 0) + ' / ' + roundsToWin;
      row.appendChild(dot); row.appendChild(nm); row.appendChild(gp);
      roList.appendChild(row);
    });
    roundOverlay.hidden = false;
  }

  function renderFinal(champs) {
    const names = champs.map(nameOf);
    finalHeading.textContent = names.length > 1 ? (names.join(' & ') + ' win!') : ((names[0] || 'Someone') + ' wins!');
    finalHeading.style.setProperty('--wc', champs.length === 1 ? colorOf(champs[0]) : '#FFD23F');
    finalList.innerHTML = '';
    const sorted = roster.slice().sort(function (a, b) { return (gamePoints[b.id] || 0) - (gamePoints[a.id] || 0); });
    sorted.forEach(function (r) {
      const row = document.createElement('div'); row.className = 'fn-row' + (champs.indexOf(r.id) >= 0 ? ' win' : '');
      const dot = document.createElement('span'); dot.className = 'fn-dot'; dot.style.background = r.color;
      const nm = document.createElement('span'); nm.className = 'fn-name'; nm.textContent = r.name;
      const pips = document.createElement('span'); pips.className = 'fn-pips';
      for (let k = 0; k < roundsToWin; k++) {
        const d = document.createElement('span'); d.className = 'pip' + (k < (gamePoints[r.id] || 0) ? ' on' : '');
        pips.appendChild(d);
      }
      row.appendChild(dot); row.appendChild(nm); row.appendChild(pips);
      finalList.appendChild(row);
    });
    show('final');
  }

  // ---------------- Confetti ----------------
  function launchConfetti(tint) {
    if (reduceMotion) return;
    const colors = [tint || '#FFD23F', '#FF7A18', '#FFFFFF', '#3DDC84', '#3DA5FF'];
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
  socket.on('in', function (d) {
    if (!world || !d || matchState !== 'play' || paused) return;
    world.setInput(d.id, d.x, d.y);
  });
  socket.on('bomb', function (d) {
    if (!world || !d || matchState !== 'play' || paused) return;
    world.requestBomb(d.id);
  });
  socket.on('player:dropped', function (d) {
    if (!world || !d) return;
    world.setInput(d.id, 0, 0);
  });

  // ---------------- Boot ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      renderQR();
      renderLobby(res.lobby);
      roundsToWin = res.lobby.roundsToWin;
      roundLengthSec = res.lobby.roundLengthSec;
      powerUps = res.lobby.powerUps;
      botDifficulty = res.lobby.botDifficulty;
      if (res.phase === 'LOBBY') show('lobby');
      else if (res.phase === 'PLAYING' && res.match) {
        // Host refreshed mid-match: restart the CURRENT round fresh, keeping the
        // round number and rounds won (the arena state can't be restored).
        startMatch(res.match.roster, res.match, { gamePoints: res.match.gamePoints, round: res.match.round });
      } else if (res.phase === 'FINAL' && res.match) {
        roster = res.match.roster || [];
        gamePoints = res.match.gamePoints || {};
        roundsToWin = res.match.roundsToWin;
        renderFinal(res.match.winnerIds || []);
      }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
  });

  socket.on('state:lobby', function (l) {
    if (l && l.phase === 'LOBBY') {
      renderLobby(l);
      if (!views.match.classList.contains('active') && !views.final.classList.contains('active')) show('lobby');
    }
  });
  socket.on('state:reset', function () {
    stopLoop();
    pClearAll();
    countdownTimer = null; roundOverTimer = null;
    paused = false;
    matchState = 'idle'; world = null; renderer = null; lastHumanTotal = -1;
    bots = []; sdStarted = false; prevHud = {};
    if (roundOverlay) roundOverlay.hidden = true;
    if (countOverlay) countOverlay.hidden = true;
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    show('lobby');
  });

  window.addEventListener('resize', function () { if (renderer) renderer.resize(); });
})();
