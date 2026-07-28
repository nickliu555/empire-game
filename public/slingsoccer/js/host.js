(function () {
  'use strict';

  const socket = io('/slingsoccer', { transports: ['polling', 'websocket'] });

  // ---------------- Tunables ----------------
  const FIXED_DT = 1 / 120;
  const MAX_STEPS = 40;
  const SIM_MAX_MS = 12000;       // safety: force-settle a runaway simulation
  const GOAL_CELEBRATE_MS = 2600;
  const BOT_THINK_MS = 950;       // CPU "draw back" time before it fires

  const TEAMS = ['red', 'blue'];
  const other = (t) => (t === 'red' ? 'blue' : 'red');

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
  const targetRange = document.getElementById('targetRange');
  const targetVal = document.getElementById('targetVal');
  const slotsRed = document.getElementById('slotsRed');
  const slotsBlue = document.getElementById('slotsBlue');
  const colRed = document.getElementById('colRed');
  const colBlue = document.getElementById('colBlue');
  const configHint = document.getElementById('configHint');
  const startBtn = document.getElementById('startBtn');

  const canvas = document.getElementById('pitch');
  const sbRedName = document.getElementById('sbRedName');
  const sbBlueName = document.getElementById('sbBlueName');
  const sbRedScore = document.getElementById('sbRedScore');
  const sbBlueScore = document.getElementById('sbBlueScore');
  const sbTarget = document.getElementById('sbTarget');
  const turnBanner = document.getElementById('turnBanner');
  const turnText = document.getElementById('turnText');
  const countOverlay = document.getElementById('countOverlay');
  const coNum = document.getElementById('coNum');
  const goalBanner = document.getElementById('goalBanner');
  const gbText = document.getElementById('gbText');
  const gbSub = document.getElementById('gbSub');

  const finalTrophy = document.getElementById('finalTrophy');
  const finalHeading = document.getElementById('finalHeading');
  const fsRed = document.getElementById('fsRed');
  const fsBlue = document.getElementById('fsBlue');
  const finalRosters = document.getElementById('finalRosters');
  const playAgainBtn = document.getElementById('playAgainBtn');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const resetBtn = document.getElementById('resetBtn');

  // ---------------- Modal helpers (match other games) ----------------
  function showInlineConfirm(message, onYes, opts) {
    if (typeof window.showConfirm !== 'function') {
      if (window.confirm(message)) onYes && onYes();
      return;
    }
    const okLabel = (opts && opts.okLabel) || 'Yes';
    window.showConfirm(message, okLabel, opts || {}).then(function (ok) { if (ok) onYes && onYes(); });
  }
  function showToast(message) {
    if (typeof window.showToast === 'function' && window.showToast !== showToast) { window.showToast(message); return; }
    const t = document.createElement('div');
    t.className = 'inline-toast';
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('visible'); }, 10);
    setTimeout(function () { t.classList.remove('visible'); setTimeout(function () { t.remove(); }, 300); }, 3000);
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

  // ---------------- Fullscreen ----------------
  fullscreenBtn && fullscreenBtn.addEventListener('click', function () {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(function () {});
    else document.exitFullscreen();
  });
  document.addEventListener('fullscreenchange', function () {
    if (!fullscreenBtn) return;
    fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit' : '⛶ Fullscreen';
  });

  // ---------------- Reset + Hub ----------------
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
          if (navigated) return;
          navigated = true;
          if (window.Iris && typeof window.Iris.transitionTo === 'function') {
            window.Iris.transitionTo('/', origin, { emoji: '🎮', name: 'Game Hub', color: '#1b2838' });
          } else { window.location.href = '/'; }
        };
        socket.emit('host:leave', {}, go);
        setTimeout(go, 600);
      }, { okLabel: 'Leave & Reset', danger: true });
    });
  }

  // ---------------- Audio (WebAudio, no external assets) ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    return audioCtx;
  }
  function unlockAudio() { const c = getAudioCtx(); if (c && c.state === 'suspended') c.resume(); }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
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
  // Kickoff whistle. Decoded into a Web Audio buffer so it fires with near-zero
  // latency exactly on "GO" (an <audio> element's play() has a noticeable start
  // delay + a currentTime seek). Any leading silence in the file is skipped so
  // the blow is heard right on 0. Falls back to the <audio> element, then a
  // synthetic blow, if the buffer isn't ready.
  const WHISTLE_URL = '/slingsoccer/assets/sounds/whistle.mp3';
  const whistleEl = document.getElementById('sfx-whistle');
  if (whistleEl) whistleEl.volume = 0.7;
  let whistleBuf = null;      // decoded AudioBuffer
  let whistleOffset = 0;      // seconds of leading silence to skip
  let whistleLoading = false;
  function loadWhistleBuffer() {
    if (whistleBuf || whistleLoading) return;
    const c = getAudioCtx(); if (!c) return;
    whistleLoading = true;
    fetch(WHISTLE_URL).then(function (r) { return r.arrayBuffer(); })
      .then(function (ab) { return c.decodeAudioData(ab); })
      .then(function (buf) {
        whistleBuf = buf;
        // Skip any silent lead-in so the whistle is audible right on 0.
        try {
          const d = buf.getChannelData(0);
          const step = Math.max(1, Math.floor(buf.sampleRate / 2000));
          for (let i = 0; i < d.length; i += step) {
            if (Math.abs(d[i]) > 0.02) { whistleOffset = Math.max(0, i / buf.sampleRate - 0.005); break; }
          }
        } catch (_) {}
      })
      .catch(function () {})
      .then(function () { whistleLoading = false; });
  }
  let whistlePrimed = false;
  // Called inside the Start-click gesture: begin decoding the buffer and unlock
  // the <audio> fallback on iOS so either can fire at kickoff a few seconds on.
  function primeWhistle() {
    loadWhistleBuffer();
    if (whistlePrimed || !whistleEl) return;
    whistlePrimed = true;
    try {
      whistleEl.volume = 0;
      const p = whistleEl.play();
      const reset = function () { try { whistleEl.pause(); whistleEl.currentTime = 0; } catch (_) {} whistleEl.volume = 0.7; };
      if (p && typeof p.then === 'function') p.then(reset).catch(function () { whistleEl.volume = 0.7; });
      else reset();
    } catch (_) { whistleEl.volume = 0.7; }
  }
  function playWhistleSynth() {
    const c = getAudioCtx(); if (!c) return;
    blip(1650, 0.16, 'square', 0.12);
    blip(2100, 0.16, 'square', 0.1, c.currentTime + 0.05);
  }
  function playWhistle() {
    const c = getAudioCtx();
    // Preferred: sample-accurate Web Audio playback, zero start latency.
    if (c && whistleBuf && c.state === 'running') {
      try {
        const src = c.createBufferSource(); src.buffer = whistleBuf;
        const g = c.createGain(); g.gain.value = 0.7;
        src.connect(g); g.connect(c.destination);
        src.start(0, whistleOffset);
        return;
      } catch (_) {}
    }
    // Fallback: the <audio> element.
    if (whistleEl) {
      try {
        whistleEl.currentTime = 0;
        const p = whistleEl.play();
        if (p && typeof p.catch === 'function') p.catch(function () { playWhistleSynth(); });
        return;
      } catch (_) {}
    }
    playWhistleSynth();
  }
  function playFlick() { blip(320, 0.07, 'triangle', 0.2); blip(180, 0.09, 'sine', 0.16); }
  function playClack() { blip(520, 0.04, 'square', 0.09); }
  function playGoal() {
    const c = getAudioCtx(); if (!c) return;
    const base = c.currentTime;
    [523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.35, 'sawtooth', 0.14, base + i * 0.08); });
    try {
      const dur = 1.0;
      const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = c.createBufferSource(); src.buffer = buf;
      const g = c.createGain(); g.gain.value = 0.08;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1000;
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start();
    } catch (_) {}
  }

  // ---------------- Lobby state ----------------
  let lobby = { goalTarget: 3, capacity: 6, perTeam: 3, total: 0, teams: { red: [], blue: [] }, canStart: false };
  const teamOf = {};
  let lastLobbyHumanTotal = -1;
  // Lobby drag state (pointer-based chip drag — see setupLobbyDrag below).
  let suppressClick = false; // swallow the click that trails a real drag
  let dragActive = false;    // a chip is mid-drag; defer lobby rebuilds
  let pendingLobby = null;   // latest snapshot to apply once the drag settles

  function renderQR() {
    fetch('/api/slingsoccer/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        const url = (cfg && cfg.joinUrl) || (window.location.origin + '/slingsoccer/join');
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        return fetch('/api/slingsoccer/qr?url=' + encodeURIComponent(url));
      })
      .then(function (r) { return r.text(); })
      .then(function (svg) { qrSlot.innerHTML = svg; })
      .catch(function () {});
  }

  function chip(p, team) {
    const el = document.createElement('div');
    el.className = 'player-chip' + (p.connected === false ? ' disconnected' : '') + (p.isBot ? ' is-bot' : '');
    el.dataset.pid = p.id;
    const label = document.createElement('span');
    label.className = 'chip-name';
    label.textContent = p.name;
    const kick = document.createElement('button');
    kick.className = 'chip-kick';
    kick.type = 'button';
    kick.textContent = '✕';
    kick.title = p.isBot ? 'Remove CPU' : 'Remove player';
    kick.addEventListener('click', function (e) {
      e.stopPropagation();
      socket.emit('host:kick', { playerId: p.id });
    });
    el.appendChild(label);
    el.appendChild(kick);
    // Click-to-swap (touch-host fallback). A real drag sets suppressClick so the
    // trailing click doesn't also bounce the chip to the other team.
    el.addEventListener('click', function () {
      if (suppressClick) { suppressClick = false; return; }
      const to = team === 'red' ? 'blue' : 'red';
      socket.emit('host:assign', { playerId: p.id, team: to }, function (res) {
        if (res && !res.ok && res.reason === 'team-full') showToast('That team is full (max 3).');
      });
    });
    return el;
  }

  function renderLobby(l) {
    if (!l) return;
    // Don't rebuild the chip list out from under an in-progress drag; apply the
    // latest snapshot once the drag settles.
    if (dragActive) { pendingLobby = l; return; }
    lobby = l;
    const humanTotal = l.teams.red.concat(l.teams.blue).filter(function (p) { return !p.isBot; }).length;
    if (lastLobbyHumanTotal >= 0 && humanTotal > lastLobbyHumanTotal) playJoinDing();
    lastLobbyHumanTotal = humanTotal;
    playerCountEl.textContent = l.total;
    playerCapEl.textContent = l.capacity;
    targetRange.value = l.goalTarget;
    targetVal.textContent = l.goalTarget;
    Object.keys(teamOf).forEach(function (k) { delete teamOf[k]; });
    function fill(slotEl, arr, team) {
      slotEl.innerHTML = '';
      arr.forEach(function (p) { teamOf[p.id] = team; slotEl.appendChild(chip(p, team)); });
      for (let i = arr.length; i < l.perTeam; i++) {
        const e = document.createElement('div');
        e.className = 'slot-empty';
        e.textContent = 'Open spot';
        slotEl.appendChild(e);
      }
    }
    fill(slotsRed, l.teams.red, 'red');
    fill(slotsBlue, l.teams.blue, 'blue');
    startBtn.disabled = !l.canStart;
    if (addBotBtn) addBotBtn.disabled = l.total >= l.capacity;
    if (l.canStart) configHint.textContent = '';
    else {
      const red = l.teams.red.length, blue = l.teams.blue.length;
      if (red === 0 && blue === 0) configHint.textContent = 'Add at least one player to each team.';
      else if (red === 0) configHint.textContent = 'Team Red needs at least one player.';
      else if (blue === 0) configHint.textContent = 'Team Blue needs at least one player.';
      else configHint.textContent = '';
    }
  }

  // ---- Smooth pointer-drag for lobby chips ---------------------------------
  // Lift the grabbed chip so it flies with the pointer while a placeholder holds
  // its drop slot; displaced teammates slide via FLIP. Handles reordering within
  // a team AND moving a chip to the other team (like Rank Five, but two columns).
  (function setupLobbyDrag() {
    let reduceMotion = false;
    try { reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    const slotEls = { red: slotsRed, blue: slotsBlue };
    const colEls = { red: colRed, blue: colBlue };
    let d = null; // active drag: { el, pid, downX, downY, active, team, offX, offY, ph }

    function chipsIn(team) {
      return Array.prototype.slice.call(slotEls[team].querySelectorAll('.player-chip'))
        .filter(function (c) { return !d || c !== d.el; });
    }
    // FLIP: snapshot chip tops, then animate displaced siblings from old → new.
    function measure() {
      const m = [];
      ['red', 'blue'].forEach(function (t) {
        chipsIn(t).forEach(function (c) { m.push([c, c.getBoundingClientRect().top]); });
      });
      return m;
    }
    function flip(prev) {
      if (reduceMotion || !prev) return;
      const moved = [];
      prev.forEach(function (rec) {
        const c = rec[0];
        if (!c.isConnected) return;
        const delta = rec[1] - c.getBoundingClientRect().top;
        if (delta) { c.style.transition = 'none'; c.style.transform = 'translateY(' + delta + 'px)'; moved.push(c); }
      });
      if (!moved.length) return;
      document.body.getBoundingClientRect(); // one sync reflow to commit offsets
      moved.forEach(function (c) {
        c.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)';
        c.style.transform = '';
      });
    }
    // Which team column is the pointer over? Works whether the columns sit
    // side-by-side (wide host screen) or stacked (narrow window): prefer the one
    // whose box contains the pointer, else fall back to the nearest centre.
    function teamAt(x, y) {
      const rr = colEls.red.getBoundingClientRect();
      const br = colEls.blue.getBoundingClientRect();
      function inside(r) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
      const inR = inside(rr), inB = inside(br);
      if (inR && !inB) return 'red';
      if (inB && !inR) return 'blue';
      function dist2(r) { const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2; return (x - cx) * (x - cx) + (y - cy) * (y - cy); }
      return dist2(rr) <= dist2(br) ? 'red' : 'blue';
    }
    // Move the placeholder to the slot the pointer is hovering in `team`.
    function positionPlaceholder(team, y) {
      const slots = slotEls[team];
      const chips = chipsIn(team);
      let before = null;
      for (let i = 0; i < chips.length; i++) {
        const r = chips[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = chips[i]; break; }
      }
      if (!before) before = slots.querySelector('.slot-empty'); // sit above open spots
      if (d.team === team && d.ph.nextElementSibling === before) return; // already there
      const prev = measure();
      slots.insertBefore(d.ph, before); // before === null → append
      d.team = team;
      flip(prev);
    }
    function beginLift() {
      d.active = true;
      dragActive = true;
      const r = d.el.getBoundingClientRect();
      d.offX = d.downX - r.left;
      d.offY = d.downY - r.top;
      // Placeholder keeps the chip's slot in the flow so nothing collapses.
      d.ph = document.createElement('div');
      d.ph.className = 'chip-placeholder';
      d.ph.style.height = r.height + 'px';
      d.el.parentNode.insertBefore(d.ph, d.el);
      // Lift the chip out of flow so it can fly with the pointer.
      d.el.style.position = 'fixed';
      d.el.style.left = '0';
      d.el.style.top = '0';
      d.el.style.width = r.width + 'px';
      d.el.style.margin = '0';
      d.el.style.zIndex = '50';
      d.el.style.pointerEvents = 'none';
      d.el.style.transition = 'none';
      d.el.classList.add('dragging');
    }
    function onMove(e) {
      if (!d) return;
      if (e.cancelable) e.preventDefault();
      const x = e.clientX, y = e.clientY;
      if (!d.active) {
        if (Math.abs(x - d.downX) < 5 && Math.abs(y - d.downY) < 5) return; // a tap, so far
        beginLift();
      }
      d.el.style.transform = 'translate(' + (x - d.offX) + 'px,' + (y - d.offY) + 'px) scale(1.03)';
      const team = teamAt(x, y);
      colEls.red.classList.toggle('drag-over', team === 'red');
      colEls.blue.classList.toggle('drag-over', team === 'blue');
      positionPlaceholder(team, y);
    }
    function onUp() {
      if (!d) return;
      const cur = d;
      d = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!cur.active) return; // never crossed the threshold → a tap (click-to-swap)
      // Swallow the click that trails this drag. Cleared on that click, plus a
      // timer in case the release fired no click (or fired one elsewhere).
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 400);
      colEls.red.classList.remove('drag-over');
      colEls.blue.classList.remove('drag-over');
      let next = cur.ph.nextElementSibling;
      while (next && !next.classList.contains('player-chip')) next = next.nextElementSibling;
      const beforeId = next ? next.dataset.pid : null;
      const team = cur.team;
      const el = cur.el;
      // Settle: slide the lifted chip from the pointer into the placeholder slot.
      const floatRect = el.getBoundingClientRect();
      cur.ph.parentNode.insertBefore(el, cur.ph);
      cur.ph.remove();
      el.style.position = ''; el.style.left = ''; el.style.top = '';
      el.style.width = ''; el.style.margin = ''; el.style.zIndex = '';
      el.style.pointerEvents = '';
      let cleaned = false;
      const done = function () {
        if (cleaned) return; cleaned = true;
        el.classList.remove('dragging');
        el.style.transition = ''; el.style.transform = '';
        el.removeEventListener('transitionend', done);
      };
      if (reduceMotion) { done(); }
      else {
        const dest = el.getBoundingClientRect();
        el.style.transition = 'none';
        el.style.transform = 'translate(' + (floatRect.left - dest.left) + 'px,' + (floatRect.top - dest.top) + 'px) scale(1.03)';
        document.body.getBoundingClientRect();
        el.style.transition = 'transform 0.2s cubic-bezier(0.2,0.7,0.2,1)';
        el.style.transform = '';
        el.addEventListener('transitionend', done);
        setTimeout(done, 260); // fallback if transitionend never fires
      }
      dragActive = false;
      if (pendingLobby) { const pl = pendingLobby; pendingLobby = null; renderLobby(pl); }
      socket.emit('host:assign', { playerId: cur.pid, team: team, beforeId: beforeId }, function (res) {
        if (res && !res.ok) {
          if (res.reason === 'team-full') showToast('That team is full (max 3).');
          renderLobby(lobby);
        }
      });
    }
    function onDown(e) {
      if (e.button != null && e.button !== 0) return; // primary button only
      if (!e.target || e.target.closest('.chip-kick')) return; // kick isn't a handle
      const el = e.target.closest('.player-chip');
      if (!el || d) return;
      d = { el: el, pid: el.dataset.pid, downX: e.clientX, downY: e.clientY, active: false, team: null, offX: 0, offY: 0, ph: null };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    slotsRed.addEventListener('pointerdown', onDown);
    slotsBlue.addEventListener('pointerdown', onDown);
  })();

  addBotBtn && addBotBtn.addEventListener('click', function () {
    socket.emit('host:addBot', {}, function (res) {
      if (res && !res.ok) showToast(res.reason === 'game-full' ? 'The teams are already full.' : 'Could not add a CPU.');
    });
  });

  let targetTimer = null;
  targetRange.addEventListener('input', function () {
    targetVal.textContent = targetRange.value;
    if (targetTimer) clearTimeout(targetTimer);
    targetTimer = setTimeout(function () {
      socket.emit('host:setGoalTarget', { goalTarget: Number(targetRange.value) });
    }, 120);
  });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    primeWhistle();
    socket.emit('host:start', {}, function (res) {
      if (!res || !res.ok) { showToast('Can\'t start yet — each team needs at least one player.'); return; }
      startMatch(res.roster, res.goalTarget, null);
    });
  });

  // ---------------- Match state ----------------
  let world = null, renderer = null, rafId = null, lastFrame = 0, acc = 0;
  let matchState = 'idle';        // idle | aim | sim | goal | ended
  let redScore = 0, blueScore = 0, goalTarget = 3, roster = [];
  let redNames = 'Red', blueNames = 'Blue';
  let currentTeam = null, currentPlayerId = null, currentPlayerName = null;
  let selectedIdx = null;         // token the active player picked (0-4) or null
  let aimVec = null;              // {dx,dy} live pull for the preview or null
  const rrIndex = { red: -1, blue: -1 };
  let turnSeq = 0;                // cancels stale bot timers on turn change
  let simElapsedMs = 0;
  let prevBallSpeed = 0;
  let botTimer = null;
  let countdownTimer = null;

  function rosterNames(team) {
    const names = roster.filter(function (r) { return r.team === team; }).map(function (r) { return r.name; });
    if (!names.length) return team === 'red' ? 'Red' : 'Blue';
    return names.join(' & ');
  }
  function teamMembers(team) { return roster.filter(function (r) { return r.team === team; }); }

  function startMatch(rost, target, initial) {
    roster = rost || [];
    goalTarget = target || 3;
    redScore = initial ? initial.red : 0;
    blueScore = initial ? initial.blue : 0;
    redNames = rosterNames('red');
    blueNames = rosterNames('blue');
    sbRedName.textContent = redNames.length > 20 ? 'Red' : redNames;
    sbBlueName.textContent = blueNames.length > 20 ? 'Blue' : blueNames;
    sbTarget.textContent = 'First to ' + goalTarget;

    world = new window.SlingSoccer.World();
    renderer = new window.SlingSoccerRender.Renderer(canvas, world);
    rrIndex.red = -1; rrIndex.blue = -1;
    selectedIdx = null; aimVec = null;

    if (initial && initial.board) world.restore(initial.board);
    else world.setFormation();

    show('match');
    requestAnimationFrame(function () { renderer.resize(); });
    updateScoreboard();
    startLoop();

    if (initial && initial.currentTeam) {
      // Host refreshed mid-match: resume the exact turn from the cached meta.
      resumeTurn(initial.currentTeam, initial.currentPlayerId, initial.currentPlayerName);
    } else {
      // Fresh match: a random team kicks off.
      const first = Math.random() < 0.5 ? 'red' : 'blue';
      beginKickoff(first);
    }
  }

  function startLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    lastFrame = performance.now();
    acc = 0;
    rafId = requestAnimationFrame(loop);
  }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  // ---------------- Turn management ----------------
  // Round-robin STRICTLY by seat order. A disconnected human is NEVER skipped or
  // replaced (by a teammate or CPU) — the turn is HELD for them until they
  // return. Only bots are ever auto-driven.
  function pickNextMember(team) {
    const members = teamMembers(team);
    if (!members.length) return null;
    rrIndex[team] = (rrIndex[team] + 1) % members.length;
    return members[rrIndex[team]];
  }

  function beginTurn(team) {
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    const member = pickNextMember(team);
    if (!member) {
      // Team somehow has no members — fall back to the other side.
      const alt = pickNextMember(other(team));
      if (!alt) {
        matchState = 'aim';
        currentTeam = team; currentPlayerId = null; currentPlayerName = null;
        setTurnBanner();
        return;
      }
      beginTurnFor(other(team), alt);
      return;
    }
    beginTurnFor(team, member);
  }

  function beginTurnFor(team, member) {
    currentTeam = team;
    currentPlayerId = member.id;
    currentPlayerName = member.name;
    selectedIdx = null;
    aimVec = null;
    matchState = 'aim';
    turnSeq++;
    const waiting = !member.isBot && member.connected === false;
    setTurnBanner(waiting);
    socket.emit('host:turn', {
      team: currentTeam, playerId: currentPlayerId, playerName: currentPlayerName,
      red: redScore, blue: blueScore,
    });
    if (member.isBot) scheduleBotShot(turnSeq, member);
    // A disconnected human just holds the turn — we wait for player:rejoined.
  }

  // Restore the turn after a host refresh (do NOT advance the rotation).
  function resumeTurn(team, playerId, playerName) {
    currentTeam = team;
    currentPlayerId = playerId || null;
    currentPlayerName = playerName || null;
    selectedIdx = null; aimVec = null;
    matchState = 'aim';
    turnSeq++;
    const rmember = roster.find(function (r) { return r.id === currentPlayerId; });
    setTurnBanner(!!(rmember && !rmember.isBot && rmember.connected === false));
    socket.emit('host:turn', {
      team: currentTeam, playerId: currentPlayerId, playerName: currentPlayerName,
      red: redScore, blue: blueScore,
    });
    const member = roster.find(function (r) { return r.id === currentPlayerId; });
    if (member && member.isBot) scheduleBotShot(turnSeq, member);
  }

  function setTurnBanner(waiting) {
    if (!turnBanner) return;
    turnBanner.classList.remove('red', 'blue');
    turnBanner.classList.add(currentTeam === 'blue' ? 'blue' : 'red');
    const teamLabel = currentTeam === 'blue' ? 'Blue' : 'Red';
    if (waiting && currentPlayerName) {
      turnText.innerHTML = 'Waiting for <span class="turn-name">' + escapeHtml(currentPlayerName) + '</span> to reconnect\u2026';
    } else if (currentPlayerName) {
      turnText.innerHTML = '<b>' + teamLabel + '</b> to shoot \u2014 <span class="turn-name">' + escapeHtml(currentPlayerName) + '</span>';
    } else {
      turnText.innerHTML = '<b>' + teamLabel + '</b> to shoot';
    }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------- Kickoff countdown (match start + after every goal) ----------------
  function showCount(n) {
    if (!countOverlay) return;
    countOverlay.hidden = false;
    coNum.textContent = n;
    coNum.style.animation = 'none'; void coNum.offsetWidth; coNum.style.animation = '';
  }
  function hideCount() { if (countOverlay) countOverlay.hidden = true; }
  function playCountBlip(freq) { blip(freq || 440, 0.12, 'square', 0.14); }

  // Show a 3-2-1 count over the formation, then hand the kicking team its turn.
  function beginKickoff(team) {
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    matchState = 'countdown';
    currentTeam = team;
    currentPlayerId = null; currentPlayerName = null;
    selectedIdx = null; aimVec = null;
    if (turnBanner) {
      turnBanner.classList.remove('red', 'blue');
      turnBanner.classList.add(team === 'blue' ? 'blue' : 'red');
      turnText.innerHTML = '<b>Team ' + (team === 'blue' ? 'Blue' : 'Red') + '</b> kicking off\u2026';
    }
    let n = 3;
    showCount(n);
    socket.emit('host:countdown', { n: n });
    playCountBlip(440);
    countdownTimer = setInterval(function () {
      n--;
      if (n >= 1) {
        showCount(n);
        socket.emit('host:countdown', { n: n });
        playCountBlip(440);
      } else {
        clearInterval(countdownTimer); countdownTimer = null;
        hideCount();
        playWhistle();
        beginTurn(team);
      }
    }, 800);
  }

  function commitShot(team, idx, dx, dy) {
    world.applyFlick(team, idx, dx, dy);
    aimVec = null;
    selectedIdx = idx;   // keep highlight on the flicked token during the sim
    matchState = 'sim';
    simElapsedMs = 0;
    prevBallSpeed = 0;
    playFlick();
  }

  function endSim() {
    // Board settled with no goal: respawn any token that ended up in a net,
    // snapshot the resting board, then pass the turn to the other team.
    const respawned = world.respawnTokensInGoal();
    if (respawned.length && renderer) {
      for (const t of respawned) renderer.spawnBurst(t.x, t.y, '#ffffff', 10);
    }
    socket.emit('host:board', world.snapshot());
    beginTurn(other(currentTeam));
  }

  function onGoal(team) {
    matchState = 'goal';
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (team === 'red') redScore++; else blueScore++;
    updateScoreboard();
    if (renderer && world) {
      const col = team === 'red' ? '#ff6a5e' : '#6aa8f2';
      const bx = world.ball.x, by = world.ball.y;
      // Big celebratory splash: a dense team-colour burst + white sparkle from
      // the ball, a burst out of the goal, then a delayed second pop.
      renderer.spawnBurst(bx, by, col, 130);
      renderer.spawnBurst(bx, by, '#ffffff', 46);
      renderer.spawnBurst(team === 'red' ? world.field.W : 0, world.field.H / 2, col, 70);
      setTimeout(function () {
        if (matchState === 'goal' && renderer) {
          renderer.spawnBurst(bx, by, col, 80);
          renderer.spawnBurst(bx, by, '#ffffff', 28);
        }
      }, 170);
    }
    gbText.textContent = (team === 'red' ? redNames : blueNames);
    gbText.style.color = team === 'red' ? 'var(--red-soft)' : 'var(--blue-soft)';
    if (gbSub) gbSub.textContent = 'GOAL!!';
    goalBanner.hidden = false;
    gbText.style.animation = 'none'; void gbText.offsetWidth; gbText.style.animation = '';
    if (gbSub) { gbSub.style.animation = 'none'; void gbSub.offsetWidth; gbSub.style.animation = ''; }
    playGoal();
    socket.emit('host:goal', { team: team, red: redScore, blue: blueScore });

    setTimeout(function () {
      if (matchState !== 'goal') return;
      goalBanner.hidden = true;
      if (redScore >= goalTarget || blueScore >= goalTarget) {
        endMatch(redScore > blueScore ? 'red' : 'blue', true);
        return;
      }
      // Full board reset; the CONCEDING team (other than the scorer) kicks off.
      world.setFormation();
      socket.emit('host:board', world.snapshot());
      beginKickoff(other(team));
    }, GOAL_CELEBRATE_MS);
  }

  function endMatch(winner, afterGoal) {
    matchState = 'ended';
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    hideCount();
    socket.emit('host:matchEnd', { winner: winner, red: redScore, blue: blueScore });
    if (!afterGoal) setTimeout(playGoal, 200);
    setTimeout(function () { stopLoop(); renderFinal({ winner: winner, red: redScore, blue: blueScore }); }, 1500);
  }

  function updateScoreboard() {
    sbRedScore.textContent = redScore;
    sbBlueScore.textContent = blueScore;
    sbTarget.textContent = 'First to ' + goalTarget;
  }

  // ---------------- Main loop ----------------
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0.1) dt = 0.1;

    if (matchState === 'sim' && world) {
      acc += dt;
      simElapsedMs += dt * 1000;
      let scored = null;
      let steps = 0;
      while (acc >= FIXED_DT && steps < MAX_STEPS) {
        scored = world.step(FIXED_DT);
        acc -= FIXED_DT;
        steps++;
        if (scored) break;
      }
      // Ball-contact clack: a sharp jump in ball speed = it got struck.
      const bs = world.ball ? Math.hypot(world.ball.vx, world.ball.vy) : 0;
      if (bs - prevBallSpeed > 380) playClack();
      prevBallSpeed = bs;

      if (scored) { onGoal(scored); }
      else if (world.allAtRest() || simElapsedMs >= SIM_MAX_MS) {
        acc = 0;
        endSim();
      }
    }

    if (renderer) {
      const aim = (selectedIdx != null && aimVec && matchState === 'aim')
        ? { team: currentTeam, idx: selectedIdx, dx: aimVec.dx, dy: aimVec.dy } : null;
      const active = (selectedIdx != null && (matchState === 'aim' || matchState === 'sim'))
        ? { team: currentTeam, idx: selectedIdx } : null;
      renderer.render({ aim: aim, active: active, dt: dt });
    }
  }

  // ---------------- CPU / bot AI ----------------
  function scheduleBotShot(seq, member) {
    if (botTimer) clearTimeout(botTimer);
    // Choose the token + aim now so the preview can "draw back" during the think.
    const plan = botPlan(member.team);
    if (!plan) { botTimer = setTimeout(function () { if (seq === turnSeq && matchState === 'aim') beginTurn(other(currentTeam)); }, 300); return; }
    selectedIdx = plan.idx;
    // Animate the pull growing to full over the think time.
    const startAt = performance.now();
    const anim = function () {
      if (seq !== turnSeq || matchState !== 'aim') return;
      const t = Math.min(1, (performance.now() - startAt) / BOT_THINK_MS);
      aimVec = { dx: plan.dx * t, dy: plan.dy * t };
      if (t < 1) requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
    botTimer = setTimeout(function () {
      if (seq !== turnSeq || matchState !== 'aim') return;
      commitShot(member.team, plan.idx, plan.dx, plan.dy);
    }, BOT_THINK_MS);
  }

  // Add a little human aim wobble to a pull vector so the CPU stays beatable.
  function withNoise(shot, amt) {
    const n = (Math.random() * 2 - 1) * amt;
    const c = Math.cos(n), s = Math.sin(n);
    return { idx: shot.idx, dx: shot.dx * c - shot.dy * s, dy: shot.dx * s + shot.dy * c };
  }

  // Decide the CPU's move by SIMULATING candidate flicks on a throwaway copy of
  // the world and keeping the outcome that helps most. Strategy: if any attacking
  // flick is a genuinely good chance (scores, or drives the ball well up-field),
  // take it (OFFENCE); otherwise place a defender between the ball and our goal
  // (DEFENCE). One token — whichever is rearmost — is always reserved at the back.
  function botPlan(team) {
    if (!world || !window.SlingSoccer) return null;
    const f = world.field;
    const ball = world.ball;
    const opp = other(team);
    const tx = team === 'red' ? f.W : 0;      // opponent goal line
    const ownX = team === 'red' ? 0 : f.W;    // our own goal line
    const goalY = f.H / 2;
    const R = f.BALL_R + f.TOKEN_R + 4;

    // Reserve the rearmost token as the keeper (so a defender always stays back).
    let keeperIdx = 0, keeperDist = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = world.tokenAt(team, i);
      const d = Math.abs(t.x - ownX);
      if (d < keeperDist) { keeperDist = d; keeperIdx = i; }
    }

    // Aim at an OPEN part of the mouth, away from the opponent's rearmost token
    // (their keeper), so shots aren't fired straight down the goalie's throat.
    let gk = null, gkDist = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = world.tokenAt(opp, i);
      const d = Math.abs(t.x - tx);
      if (d < gkDist) { gkDist = d; gk = t; }
    }
    const halfMouth = (f.GOAL_BOT - f.GOAL_TOP) / 2;
    const openY = gk ? goalY + (gk.y >= goalY ? -1 : 1) * halfMouth * 0.55 : goalY;
    const targets = [{ x: tx, y: openY }, { x: tx, y: goalY }];

    // Progress = how close the ball is to SCORING for us (bigger is better).
    const progressOf = function (x) { return team === 'red' ? x : (f.W - x); };
    const baseProgress = progressOf(ball.x);

    // One reusable sim world; reset it to the current resting board each try.
    const board = world.snapshot();
    const sim = new window.SlingSoccer.World();
    const runShot = function (idx, dx, dy) {
      sim.restore(board);
      sim.applyFlick(team, idx, dx, dy);
      for (let s = 0; s < 1200; s++) {
        const g = sim.step(1 / 120);
        if (g) return g;
        if (sim.allAtRest()) break;
      }
      return null;
    };
    // Pull vector that strikes the ball from directly behind toward `target`.
    const shotToward = function (t, target, power) {
      const dgx = target.x - ball.x, dgy = target.y - ball.y;
      const dl = Math.hypot(dgx, dgy) || 1;
      const ux = dgx / dl, uy = dgy / dl;
      const cx = ball.x - ux * R, cy = ball.y - uy * R;   // contact spot behind ball
      let lx = cx - t.x, ly = cy - t.y;
      const ll = Math.hypot(lx, ly) || 1; lx /= ll; ly /= ll;
      return { dx: -lx * power, dy: -ly * power };        // pull is opposite launch
    };
    // Apply human aim wobble, but never one that would sim into our own net —
    // keeps the CPU beatable without gifting own goals.
    const finalize = function (shot, amt) {
      for (let k = 0; k < 3; k++) {
        const s = withNoise(shot, amt);
        if (runShot(s.idx, s.dx, s.dy) !== opp) return s;
      }
      return shot;   // fall back to the clean, already-vetted shot
    };

    // ---- OFFENCE: try every attacker × aim × power, keep the best result. ----
    let bestAtk = null, bestVal = -Infinity;
    const distGoal = Math.hypot(tx - ball.x, goalY - ball.y);
    const pFull = Math.max(0.55, Math.min(1, 0.55 + distGoal / (f.W * 1.1)));
    const powers = [pFull, pFull * 0.82];
    for (let i = 0; i < 5; i++) {
      if (i === keeperIdx) continue;
      const t = world.tokenAt(team, i);
      for (let ti = 0; ti < targets.length; ti++) {
        for (let pi = 0; pi < powers.length; pi++) {
          const v = shotToward(t, targets[ti], powers[pi]);
          const goal = runShot(i, v.dx, v.dy);
          let val;
          if (goal === team) val = 1e6;
          else if (goal === opp) val = -1e6;                 // own goal — never
          else {
            val = progressOf(sim.ball.x) - baseProgress;     // advance up-field
            if (progressOf(sim.ball.x) < f.W * 0.28) val -= 80; // left loose in danger
          }
          if (val > bestVal) { bestVal = val; bestAtk = { idx: i, dx: v.dx, dy: v.dy }; }
        }
      }
    }

    // A "good shot opportunity" = a goal, or a real advance up the pitch.
    const GOOD = f.W * 0.10;
    if (bestAtk && bestVal >= GOOD) return finalize(bestAtk, 0.03);

    // ---- DEFENCE: no good shot — slot a non-keeper token between the ball and
    // our goal to screen it for the opponent's next turn. ----
    const blockX = ownX + (ball.x - ownX) * 0.35;
    const blockY = goalY + (ball.y - goalY) * 0.35;
    let dTok = null, dNear = Infinity;
    for (let i = 0; i < 5; i++) {
      if (i === keeperIdx) continue;
      const t = world.tokenAt(team, i);
      const d = Math.hypot(blockX - t.x, blockY - t.y);
      if (d < dNear) { dNear = d; dTok = { i: i, t: t }; }
    }
    if (dTok) {
      let lx = blockX - dTok.t.x, ly = blockY - dTok.t.y;
      const ll = Math.hypot(lx, ly) || 1; lx /= ll; ly /= ll;
      const power = Math.min(0.6, 0.32 + dNear / (f.W * 1.4));
      const cand = { idx: dTok.i, dx: -lx * power, dy: -ly * power };
      // Never shove the ball into our own net; if this would, take the best shot.
      if (runShot(cand.idx, cand.dx, cand.dy) === opp) return bestAtk ? finalize(bestAtk, 0.04) : null;
      return finalize(cand, 0.05);
    }
    return bestAtk ? finalize(bestAtk, 0.04) : null;
  }

  function renderFinal(d) {
    const winner = d.winner;
    fsRed.textContent = d.red;
    fsBlue.textContent = d.blue;
    if (!winner) { finalTrophy.textContent = '🤝'; finalHeading.textContent = 'It\'s a draw!'; }
    else {
      finalTrophy.textContent = '🏆';
      finalHeading.textContent = 'Team ' + (winner === 'red' ? 'Red' : 'Blue') + ' wins!';
      finalHeading.style.color = winner === 'red' ? 'var(--red-soft)' : 'var(--blue-soft)';
    }
    finalRosters.innerHTML = '';
    ['red', 'blue'].forEach(function (team) {
      const col = document.createElement('div');
      col.className = 'fr-col';
      const title = document.createElement('div');
      title.className = 'fr-title';
      title.style.color = team === 'red' ? 'var(--red-soft)' : 'var(--blue-soft)';
      title.textContent = team === 'red' ? 'Red' : 'Blue';
      col.appendChild(title);
      roster.filter(function (r) { return r.team === team; }).forEach(function (r) {
        const n = document.createElement('div'); n.textContent = r.name; col.appendChild(n);
      });
      finalRosters.appendChild(col);
    });
    show('final');
  }

  playAgainBtn.addEventListener('click', function () {
    socket.emit('host:reset', {});
  });

  // ---------------- Aim relay from the active player ----------------
  function aimAllowed(id) { return matchState === 'aim' && id && id === currentPlayerId; }
  socket.on('aim:select', function (d) {
    if (!d || !aimAllowed(d.id)) return;
    const t = d.token | 0;
    if (t < 0 || t > 4) return;
    selectedIdx = t;
    aimVec = null;
  });
  socket.on('aim:move', function (d) {
    if (!d || !aimAllowed(d.id) || selectedIdx == null) return;
    aimVec = { dx: Number(d.dx) || 0, dy: Number(d.dy) || 0 };
  });
  socket.on('aim:shoot', function (d) {
    if (!d || !aimAllowed(d.id) || selectedIdx == null) return;
    commitShot(currentTeam, selectedIdx, Number(d.dx) || 0, Number(d.dy) || 0);
  });
  socket.on('aim:cancel', function (d) {
    if (!d || !aimAllowed(d.id)) return;
    aimVec = null;
  });

  socket.on('player:dropped', function (d) {
    if (!d) return;
    const m = roster.find(function (r) { return r.id === d.id; });
    if (m) m.connected = false;
    // If the ACTIVE player dropped, HOLD their turn and wait for them to return
    // — never skip to a teammate or hand it to a CPU.
    if (matchState === 'aim' && d.id === currentPlayerId) {
      if (botTimer) { clearTimeout(botTimer); botTimer = null; }
      selectedIdx = null; aimVec = null;
      setTurnBanner(true);
    }
  });
  socket.on('player:rejoined', function (d) {
    if (!d) return;
    const m = roster.find(function (r) { return r.id === d.id; });
    if (m) m.connected = true;
    // The player we were waiting on is back — un-wait + resync their controller.
    if (matchState === 'aim' && d.id === currentPlayerId) {
      setTurnBanner(false);
      socket.emit('host:turn', {
        team: currentTeam, playerId: currentPlayerId, playerName: currentPlayerName,
        red: redScore, blue: blueScore,
      });
    }
  });

  // ---------------- Boot ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      renderQR();
      renderLobby(res.lobby);
      if (res.phase === 'LOBBY') show('lobby');
      else if (res.phase === 'PLAYING' && res.match) {
        startMatch(res.match.roster, res.match.goalTarget, {
          red: res.match.redScore, blue: res.match.blueScore,
          board: res.match.board,
          currentTeam: res.match.currentTeam,
          currentPlayerId: res.match.currentPlayerId,
          currentPlayerName: res.match.currentPlayerName,
        });
      } else if (res.phase === 'FINAL' && res.match) {
        roster = res.match.roster || [];
        redScore = res.match.redScore; blueScore = res.match.blueScore;
        goalTarget = res.match.goalTarget || 3;
        renderFinal({ winner: res.match.winner, red: res.match.redScore, blue: res.match.blueScore });
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
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    hideCount();
    matchState = 'idle';
    world = null; renderer = null;
    redScore = blueScore = 0;
    currentTeam = currentPlayerId = currentPlayerName = null;
    selectedIdx = null; aimVec = null;
    lastLobbyHumanTotal = -1;
    show('lobby');
  });

  window.addEventListener('resize', function () { if (renderer) renderer.resize(); });
})();
