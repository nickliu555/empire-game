(function () {
  'use strict';

  const socket = io('/soccerhead', { transports: ['polling', 'websocket'] });

  // ---------------- Tunables ----------------
  const FIXED_DT = 1 / 120;          // physics step
  const MAX_STEPS = 20;              // guard against long frames
  const COUNTDOWN_FROM = 3;
  const COUNTDOWN_START_FROM = 5;    // longer count on the very first kickoff so players can settle in
  const COUNTDOWN_STEP_MS = 850;
  const GOAL_CELEBRATE_MS = 3600;
  // Emotes normally clear when the next kickoff goes live; this is just a safety
  // cap so a bubble can never get stuck if play never resumes.
  const EMOTE_MAX_MS = 12000;
  const EMOTE_FADE_MS = 300;
  const CLOCK_EMIT_MS = 250;
  // If nobody touches the ball for this long during live play, reset the point
  // (neutral centre drop + 3-2-1) so a stranded ball can never stall the match.
  const BALL_IDLE_RESET_MS = 10000;

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
  const modeSeg = document.getElementById('modeSeg');
  const durRange = document.getElementById('durRange');
  const durVal = document.getElementById('durVal');
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
  const sbClock = document.getElementById('sbClock');
  const sbTag = document.getElementById('sbTag');
  const countOverlay = document.getElementById('countOverlay');
  const coNum = document.getElementById('coNum');
  const coNote = document.getElementById('coNote');
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
  const pauseBtn = document.getElementById('pauseBtn');
  const pauseOverlay = document.getElementById('pauseOverlay');

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
  // First interaction anywhere unlocks audio so the lobby join ding can play.
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  // A friendly two-note ding when a new player joins the lobby (matches the
  // other games' host lobby ding).
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
  const WHISTLE_URL = '/soccerhead/assets/sounds/whistle.mp3';
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
  function playKick() { blip(150, 0.09, 'triangle', 0.22); }
  function playGoal() {
    const c = getAudioCtx(); if (!c) return;
    const base = c.currentTime;
    [523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.35, 'sawtooth', 0.14, base + i * 0.08); });
    // crowd noise burst
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
  let lobby = { mode: '1v1', durationSec: 90, capacity: 2, perTeam: 1, total: 0, teams: { red: [], blue: [] }, canStart: false };
  const teamOf = {}; // pid -> 'red'|'blue'
  let lastLobbyHumanTotal = -1; // for the join ding (edge-detect new arrivals)
  // Lobby drag state (pointer-based chip drag — see setupLobbyDrag below).
  let suppressClick = false; // swallow the click that trails a real drag
  let dragActive = false;    // a chip is mid-drag; defer lobby rebuilds
  let pendingLobby = null;   // latest snapshot to apply once the drag settles

  function fmtClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtDur(sec) { const m = Math.floor(sec / 60); const s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  function renderQR() {
    fetch('/api/soccerhead/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        const url = (cfg && cfg.joinUrl) || (window.location.origin + '/soccerhead/join');
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        return fetch('/api/soccerhead/qr?url=' + encodeURIComponent(url));
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
        if (res && !res.ok && res.reason === 'team-full') showToast('That team is full (max ' + (lobby.perTeam || 2) + ').');
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
    // Ding when a new (human) player joins the lobby.
    const humanTotal = l.teams.red.concat(l.teams.blue).filter(function (p) { return !p.isBot; }).length;
    if (lastLobbyHumanTotal >= 0 && humanTotal > lastLobbyHumanTotal) playJoinDing();
    lastLobbyHumanTotal = humanTotal;
    // Counts.
    playerCountEl.textContent = l.total;
    playerCapEl.textContent = l.capacity;
    // Duration.
    durRange.value = l.durationSec;
    durVal.textContent = fmtDur(l.durationSec);
    // Teams.
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
    // Mode toggle active state.
    if (modeSeg) {
      modeSeg.querySelectorAll('.seg-opt').forEach(function (b) {
        b.classList.toggle('active', b.dataset.mode === l.mode);
      });
    }
    // Start + hint.
    startBtn.disabled = !l.canStart;
    if (addBotBtn) addBotBtn.disabled = l.total >= l.capacity;
    if (l.canStart) { configHint.textContent = ''; }
    else if (l.mode === '2v2') {
      configHint.textContent = l.total < 3
        ? 'Add at least 3 players (max 2 per team).'
        : 'Each team needs 1–2 players.';
    } else if (l.total < l.capacity) { configHint.textContent = ''; }
    else { configHint.textContent = 'Teams must be even to start.'; }
  }

  // ---- Smooth pointer-drag for lobby chips ---------------------------------
  // Lift the grabbed chip so it flies with the pointer while a placeholder holds
  // its drop slot; displaced teammates slide via FLIP. Handles reordering within
  // a team AND moving a chip to the other team (like Ranking, but two columns).
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
          if (res.reason === 'team-full') showToast('That team is full (max ' + (lobby.perTeam || 2) + ').');
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
      if (res && !res.ok) showToast(res.reason === 'game-full' ? 'The match is already full.' : 'Could not add a CPU.');
    });
  });
  if (modeSeg) {
    modeSeg.addEventListener('click', function (e) {
      const btn = e.target.closest('.seg-opt');
      if (!btn) return;
      socket.emit('host:setMode', { mode: btn.dataset.mode }, function (res) {
        if (res && !res.ok) {
          showToast(res.reason === 'too-many-players'
            ? 'Remove players first to switch to 1v1.'
            : 'Could not change mode.');
        }
      });
    });
  }
  let durTimer = null;
  durRange.addEventListener('input', function () {
    durVal.textContent = fmtDur(Number(durRange.value));
    if (durTimer) clearTimeout(durTimer);
    durTimer = setTimeout(function () {
      socket.emit('host:setDuration', { durationSec: Number(durRange.value) });
    }, 120);
  });

  startBtn.addEventListener('click', function () {
    unlockAudio();
    primeWhistle();
    socket.emit('host:start', {}, function (res) {
      if (!res || !res.ok) { showToast('Can\'t start yet — teams must be full and even.'); return; }
      startMatch(res.roster, res.durationSec, res.mode, null);
    });
  });

  // ---------------- Match engine ----------------
  let world = null, renderer = null, rafId = null, lastFrame = 0, acc = 0;
  let matchState = 'idle'; // idle | countdown | play | goal | ended
  let redScore = 0, blueScore = 0, clockMs = 0, sudden = false;
  let durationSec = 90, mode = '1v1', roster = [];
  let redNames = 'Red', blueNames = 'Blue';
  let lastClockEmit = 0;
  // Time (ms) since the ball was last touched during live play (idle watchdog).
  let untouchedMs = 0;
  // Player ids that have already emoted during the current goal celebration
  // (enforces one emote per player per goal, regardless of client behaviour).
  const emotedThisGoal = new Set();
  let countdownTimer = null;
  let prevKick = {}; // pid -> bool (kick-sound edge detection)
  let botIds = [];   // roster ids driven locally by the CPU AI
  let botState = {}; // per-bot AI scratch state

  // ---------------- Pause ----------------
  // The whole match lives on this browser, so pausing means: stop stepping the
  // physics/clock in loop(), freeze the world, and freeze every wall-clock timer
  // (countdown / goal celebration / sudden-death announce) so the sequence picks
  // up exactly where it left off. Players get covered + input-blocked via the
  // server relay (m:pause / m:resume).
  let paused = false;

  // Pausable wall-clock timers. On pause each remembers how much time was left;
  // on resume it re-arms with exactly that remainder.
  const pausableTimers = new Set();
  function pTimeout(fn, ms) {
    const rec = { fn: fn, remaining: ms, startedAt: performance.now(), handle: null, repeat: false, interval: 0 };
    rec.handle = setTimeout(function () { pausableTimers.delete(rec); fn(); }, ms);
    pausableTimers.add(rec);
    return rec;
  }
  function pInterval(fn, ms) {
    const rec = { fn: fn, remaining: ms, startedAt: performance.now(), handle: null, repeat: true, interval: ms };
    rec.handle = setInterval(function () { rec.startedAt = performance.now(); rec.remaining = ms; fn(); }, ms);
    pausableTimers.add(rec);
    return rec;
  }
  function pClear(rec) {
    if (!rec) return;
    if (rec.repeat) clearInterval(rec.handle); else clearTimeout(rec.handle);
    pausableTimers.delete(rec);
  }
  function pClearAll() {
    pausableTimers.forEach(function (rec) {
      if (rec.repeat) clearInterval(rec.handle); else clearTimeout(rec.handle);
    });
    pausableTimers.clear();
  }
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
        // Finish the remainder of the current cycle, then fall back to the
        // regular interval cadence.
        rec.handle = setTimeout(function () {
          rec.fn();
          // rec.fn() may have cleared this timer (e.g. the countdown hit 0 and
          // called pClear + beginPlay). If so, do NOT re-arm the interval —
          // otherwise it fires forever (repeating beginPlay: echoing whistle,
          // constant re-kickoff, extreme jank).
          if (!pausableTimers.has(rec)) return;
          rec.startedAt = performance.now();
          rec.remaining = rec.interval;
          rec.handle = setInterval(function () { rec.startedAt = performance.now(); rec.remaining = rec.interval; rec.fn(); }, rec.interval);
        }, rec.remaining);
      } else {
        rec.handle = setTimeout(function () { pausableTimers.delete(rec); rec.fn(); }, rec.remaining);
      }
    });
  }

  function updatePauseBtn() {
    if (!pauseBtn) return;
    const ongoing = matchState === 'countdown' || matchState === 'play' || matchState === 'goal';
    pauseBtn.hidden = !ongoing;
    pauseBtn.classList.toggle('is-paused', paused);
    pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
  }

  function pauseMatch() {
    if (paused) return;
    const ongoing = matchState === 'countdown' || matchState === 'play' || matchState === 'goal';
    if (!ongoing) return;
    paused = true;
    if (world) {
      world.frozen = true;
      // Drop any held directions so nobody is "stuck running" on resume (their
      // screen is covered anyway). In-flight jumps/falls are velocity-based and
      // survive the freeze untouched.
      for (const p of world.players) world.clearInputs(p.id);
    }
    freezeTimers();
    if (pauseOverlay) pauseOverlay.hidden = false;
    updatePauseBtn();
    socket.emit('host:pause', {});
  }

  function resumeMatch() {
    if (!paused) return;
    paused = false;
    // Only active play unfreezes the ball; countdown/goal keep it frozen.
    if (world && matchState === 'play') world.frozen = false;
    // Restart the frame clock so the first resumed frame has a normal dt.
    lastFrame = performance.now();
    acc = 0;
    lastClockEmit = 0;
    thawTimers();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    socket.emit('host:resume', { live: matchState === 'play' });
  }

  pauseBtn && pauseBtn.addEventListener('click', function () {
    if (paused) resumeMatch(); else pauseMatch();
  });

  function rosterNames(team) {
    const names = roster.filter(function (r) { return r.team === team; }).map(function (r) { return r.name; });
    if (!names.length) return team === 'red' ? 'Red' : 'Blue';
    return names.join(' & ');
  }

  function startMatch(rost, durSec, m, initial) {
    roster = rost || [];
    mode = m || '1v1';
    durationSec = durSec || 90;
    redScore = initial ? initial.red : 0;
    blueScore = initial ? initial.blue : 0;
    clockMs = initial ? initial.clockMs : durationSec * 1000;
    sudden = initial ? !!initial.sudden : false;
    redNames = rosterNames('red');
    blueNames = rosterNames('blue');
    sbRedName.textContent = redNames.length > 18 ? 'Red' : redNames;
    sbBlueName.textContent = blueNames.length > 18 ? 'Blue' : blueNames;

    world = new window.SoccerHead.World({ mode: mode });
    world.setRoster(roster);
    world.frozen = true;
    renderer = new window.SoccerHeadRender.Renderer(canvas, world);
    prevKick = {};
    // Any roster entry flagged isBot is driven locally by the CPU AI.
    botIds = roster.filter(function (r) { return r.isBot; }).map(function (r) { return r.id; });
    botState = {};
    botIds.forEach(function (id) { botState[id] = { jumpCd: 0, holdJump: 0 }; });

    // Fresh match: clear any leftover pause state / stray timers.
    paused = false;
    pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;

    show('match');
    // Canvas now has layout size — size the renderer to it.
    requestAnimationFrame(function () { renderer.resize(); });
    updateScoreboard();
    startLoop();
    beginCountdown(null, COUNTDOWN_START_FROM);
  }

  function startLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    lastFrame = performance.now();
    acc = 0;
    rafId = requestAnimationFrame(loop);
  }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0.1) dt = 0.1;

    if (matchState === 'play' && !paused && world) {
      driveBots(dt);
      acc += dt;
      let steps = 0;
      let scored = null;
      let touched = false;
      while (acc >= FIXED_DT && steps < MAX_STEPS) {
        scored = world.step(FIXED_DT);
        if (world.ball && world.ball.touchedThisStep) touched = true;
        acc -= FIXED_DT;
        steps++;
        if (scored) break;
      }
      detectKickSfx();
      if (scored) { onGoal(scored); }
      else {
        // Idle-ball watchdog: nobody has touched the ball for a while -> reset
        // the point like a fresh kickoff (neutral centre drop + 3-2-1). Score
        // and match clock are preserved (beginCountdown doesn't touch them).
        if (touched) untouchedMs = 0;
        else untouchedMs += dt * 1000;
        if (untouchedMs >= BALL_IDLE_RESET_MS) {
          untouchedMs = 0;
          beginCountdown(null, null, 'BALL INACTIVITY RESET');
        }
        // Only keep the match clock running while play is still live (the idle
        // reset above may have switched us into the countdown this frame).
        if (matchState === 'play') {
          // Advance the match clock in real time.
          clockMs -= dt * 1000;
          if (!sudden && clockMs <= 0) { clockMs = 0; handleTimeUp(); }
          updateScoreboard();
          const t = now;
          if (t - lastClockEmit >= CLOCK_EMIT_MS) {
            lastClockEmit = t;
            socket.emit('host:clock', { ms: Math.max(0, clockMs), sudden: sudden });
          }
        }
      }
    }

    // While paused, freeze the emote-bubble timeline. Their fade/expiry is driven
    // by the renderer's wall clock (em.until vs performance.now()), which keeps
    // ticking during a pause — so without this a bubble would fade out mid-pause.
    // Pushing the deadlines forward by the elapsed frame keeps them steady until
    // the next kickoff goes live (beginPlay fades them then).
    if (paused && world) {
      const shift = dt * 1000;
      for (const p of world.players) {
        if (p.emote) {
          p.emote.until += shift;
          if (p.emote.born != null) p.emote.born += shift;
        }
      }
    }

    if (renderer) renderer.render(dt);
  }

  function detectKickSfx() {
    if (!world) return;
    for (const p of world.players) {
      const on = p.kick > 0;
      if (on && !prevKick[p.id]) {
        playKick();
        renderer && renderer.spawnKick(p.x + p.facing * 44, p.y - 26);
      }
      prevKick[p.id] = on;
    }
  }

  // ---------------- CPU / bot AI (driven locally on the host) ----------------
  function driveBots(dt) {
    if (!world || !botIds.length) return;
    for (let i = 0; i < botIds.length; i++) {
      const p = world.byId.get(botIds[i]);
      if (!p) continue;
      botThink(p, botState[p.id] || (botState[p.id] = { jumpCd: 0, holdJump: 0 }), dt);
    }
  }
  function botThink(p, st, dt) {
    // Human-like reaction: refresh the decision every ~70–130ms and hold it in
    // between (so the bot isn't a frame-perfect wall — it's beatable and reads
    // as "thinking"). Timers still tick every frame.
    if (st.holdJump > 0) st.holdJump -= dt;
    if (st.jumpCd > 0) st.jumpCd -= dt;
    st.react = (st.react || 0) - dt;
    if (st.react <= 0) {
      st.react = 0.07 + Math.random() * 0.06;
      botDecide(p, st);
    }
    world.setInput(p.id, 0, st.moveDir < 0);
    world.setInput(p.id, 1, st.moveDir > 0);
    world.setInput(p.id, 3, !!st.kick);
    if (st.wantJump && p.grounded && st.jumpCd <= 0) { st.holdJump = 0.22; st.jumpCd = 0.6; st.wantJump = false; }
    world.setInput(p.id, 2, st.holdJump > 0);
    if (st.wantDash && p.dashCd <= 0 && p.dash <= 0) { world.dash(p.id, p.facing); st.wantDash = false; }
  }

  function botDecide(p, st) {
    const b = world.ball;
    const Wd = world.field.W;
    const facing = p.facing;                 // red +1 attacks right, blue -1 attacks left
    const ownGoalX = facing === 1 ? 0 : Wd;

    // Who is closer to the ball? (press vs hold)
    let opp = null;
    for (let i = 0; i < world.players.length; i++) {
      const q = world.players[i];
      if (q.team !== p.team) { opp = q; break; }
    }
    const dist = Math.abs(b.x - p.x);
    const oppDist = opp ? Math.abs(b.x - opp.x) : 9999;
    const amCloser = dist <= oppDist + 20;

    // Forwardness: 0 at our own goal, Wd at the opponent's goal.
    const ballFwd = facing * (b.x - ownGoalX);
    const ballOnOwnHalf = ballFwd < Wd * 0.5;
    // 2v2 role bias by spawn seat: seat 0 spawns nearer the CENTRE -> attack-
    // leaning; seat 1 spawns nearer our GOAL -> defend-leaning. Both still do
    // everything; it's only a focus. In 1v1 there is only seat 0 AND mode is not
    // '2v2', so both stay false and 1v1 CPUs are COMPLETELY UNCHANGED.
    const attack = mode === '2v2' && p.seat === 0;
    const defend = mode === '2v2' && p.seat === 1;
    // Press if we can win it OR it threatens our half; else retreat and guard.
    // Attacker presses higher up the pitch; defender mostly holds and only
    // engages when it's a genuine chance or a threat on our side.
    let commit = amCloser || ballOnOwnHalf;
    if (attack) commit = amCloser || ballFwd < Wd * 0.66;
    else if (defend) commit = ballOnOwnHalf || (amCloser && ballFwd < Wd * 0.42);

    // ---- Aerial read: predict the ball's flight so we can get under a lob and
    // head it clear (the CPU used to ignore balls sailing over its head). ----
    const G = 2100;                          // ball gravity (engine BALL_G)
    const aboveNow = p.y - b.y;              // ball height above our feet right now
    const towardOwnGoal = facing * b.vx < -40;
    // A high ball on our half or driving at our goal is a header threat.
    const highThreat = aboveNow > 70 && (ballOnOwnHalf || towardOwnGoal);
    // Where will the ball drop back to a good heading height? Solve
    // b.y + b.vy·t + ½G·t² = headY for the descending (larger) root.
    const headY = p.y - 190;
    let interceptX = b.x, tHead = null;
    {
      const disc = b.vy * b.vy - 2 * G * (b.y - headY);
      if (disc >= 0) { const t = (-b.vy + Math.sqrt(disc)) / G; if (t > 0) { tHead = t; interceptX = b.x + b.vx * t; } }
    }

    // ---- Positioning ----
    let desiredX;
    if (highThreat && tHead != null) {
      // Camp under the drop point so we can rise and head it away.
      desiredX = interceptX + (Math.random() * 2 - 1) * 8;
    } else {
      // How far goal-side of the ball to sit: the attacker hugs the ball more
      // (tighter, aggressive), the defender sits further back to cover.
      const goalSideOffset = attack ? 24 : defend ? 70 : 44;
      let desiredFwd = ballFwd - goalSideOffset;
      if (!commit) {
        // Resting shape: attacker holds ADVANCED (ready to counter), defender
        // holds DEEP (guards the goal), balanced/1v1 sits in its own third.
        if (attack) { desiredFwd = Math.min(desiredFwd, Wd * 0.48); desiredFwd = Math.max(desiredFwd, Wd * 0.24); }
        else if (defend) { desiredFwd = Math.min(desiredFwd, Wd * 0.22); desiredFwd = Math.max(desiredFwd, Wd * 0.10); }
        else { desiredFwd = Math.min(desiredFwd, Wd * 0.30); desiredFwd = Math.max(desiredFwd, Wd * 0.14); }
      }
      const fwdCap = attack ? 0.88 : defend ? 0.60 : 0.78;
      desiredFwd = Math.max(12, Math.min(Wd * fwdCap, desiredFwd));
      desiredX = ownGoalX + facing * desiredFwd + (Math.random() * 2 - 1) * 12; // small aim error
    }
    const dx = desiredX - p.x;
    st.moveDir = dx < -10 ? -1 : dx > 10 ? 1 : 0;

    const inFront = facing * (b.x - p.x) > -16;
    const reachable = b.y > p.y - 150;
    st.kick = dist < 82 && inFront && reachable && Math.random() < 0.9; // occasional mistime

    // ---- Jump to HEAD a ball coming down overhead ----
    // Leap ~a jump's rise-time early so the head actually meets the ball. The
    // head can reach ~110–400px above the feet, so jump when the ball will be
    // overhead within that band. Far more reliable than the old "only if the ball
    // is already within 105px" rule, which whiffed on most lobs.
    const lead = 0.22;                       // ~time for the head to rise to heading height
    const fx = b.x + b.vx * lead;
    const fy = b.y + b.vy * lead + 0.5 * G * lead * lead;
    const headableH = p.y - fy;
    const leapToHead = Math.abs(fx - p.x) < 82 && headableH > 110 && headableH < 380;
    const overheadNow = Math.abs(b.x - p.x) < 100 && aboveNow > 100 && aboveNow < 400 && b.vy > -90;
    // Ball is behind us (on our OWN-goal side), low, and we're heading back to
    // get goal-side of it: JUMP OVER the ball instead of walking into it.
    // Walking would shove the ball back toward our own goal; an airborne leap
    // clears it (raised feet don't touch a grounded ball) so we land goal-side
    // and can then push it forward.
    const ballBehindGoalSide = facing * (b.x - p.x) < -12; // ball toward our own goal
    const ballLow = (p.y - b.y) < 70;                      // near foot height (not a header)
    const closeToBall = Math.abs(b.x - p.x) < 100;
    const headingGoalSide = st.moveDir === -facing;        // moving back to get behind it
    const jumpOverBall = ballBehindGoalSide && ballLow && closeToBall && headingGoalSide;
    st.wantJump = leapToHead || overheadNow || jumpOverBall;

    const ahead = facing * (b.x - p.x);
    const inAtkHalf = ballFwd > Wd * 0.5;
    if (defend) {
      // Defender only lunges to CLEAR a ball on our own half — never to push up.
      st.wantDash = amCloser && ballOnOwnHalf && ahead > 40 && ahead < 170 && Math.abs(b.y - p.y) < 120;
    } else if (attack) {
      // Attacker dashes more readily to drive at goal (wider window).
      st.wantDash = amCloser && ahead > 45 && ahead < 210 && Math.abs(b.y - p.y) < 140 && ballFwd > Wd * 0.42;
    } else {
      st.wantDash = commit && amCloser && inAtkHalf && ahead > 55 && ahead < 190 && Math.abs(b.y - p.y) < 130;
    }
  }

  function beginCountdown(concedeTeam, fromN, note) {
    matchState = 'countdown';
    updatePauseBtn();
    if (world) { world.kickoff(concedeTeam); world.frozen = true; }
    goalBanner.hidden = true;
    updateScoreboard();
    if (countdownTimer) pClear(countdownTimer);
    const label = note || '';
    if (coNote) { coNote.textContent = label; coNote.hidden = !label; }
    let n = fromN || COUNTDOWN_FROM;
    function showN(v) {
      countOverlay.hidden = false;
      coNum.textContent = v;
      coNum.style.animation = 'none'; void coNum.offsetWidth; coNum.style.animation = '';
      socket.emit('host:countdown', { n: v, note: label });
      blip(440, 0.1, 'square', 0.12);
    }
    showN(n);
    countdownTimer = pInterval(function () {
      n--;
      if (n >= 1) { showN(n); }
      else { pClear(countdownTimer); countdownTimer = null; beginPlay(); }
    }, COUNTDOWN_STEP_MS);
  }

  function beginPlay() {
    countOverlay.hidden = true;
    matchState = 'play';
    updatePauseBtn();
    if (world) world.frozen = false;
    // The ball is live again: fade out any goal-celebration emote bubbles.
    if (world) {
      const t = performance.now() + EMOTE_FADE_MS;
      for (const p of world.players) { if (p.emote && p.emote.until > t) p.emote.until = t; }
    }
    acc = 0;
    lastFrame = performance.now();
    lastClockEmit = 0;
    untouchedMs = 0;   // fresh point: restart the idle-ball watchdog
    socket.emit('host:play', {});
    playWhistle();
  }

  function onGoal(team) {
    matchState = 'goal';
    updatePauseBtn();
    if (world) world.frozen = true;
    // New goal: everyone may emote once again.
    emotedThisGoal.clear();
    // CPUs react automatically: the scorer's team celebrates, the conceding
    // side sulks. Bubbles clear when the next kickoff goes live, like players'.
    if (world && botIds.length) {
      const now = performance.now();
      const CELEBRATE = ['😎', '🔥', '💪', '🎉', '😂'];
      const CONCEDE = ['😭', '😡', '⚽', '👍'];
      for (const id of botIds) {
        const bp = world.byId.get(id);
        if (!bp) continue;
        const set = bp.team === team ? CELEBRATE : CONCEDE;
        emotedThisGoal.add(id);
        bp.emote = { char: set[(Math.random() * set.length) | 0], born: now, until: now + EMOTE_MAX_MS };
      }
    }
    if (team === 'red') redScore++; else blueScore++;
    updateScoreboard();
    // Banner + fx: the scorer's name is the headline; "GOAL!!" is the topper.
    gbText.textContent = (team === 'red' ? redNames : blueNames);
    gbText.style.color = team === 'red' ? 'var(--red-soft)' : 'var(--blue-soft)';
    if (gbSub) gbSub.textContent = 'GOAL!!';
    goalBanner.hidden = false;
    gbText.style.animation = 'none'; void gbText.offsetWidth; gbText.style.animation = '';
    if (gbSub) { gbSub.style.animation = 'none'; void gbSub.offsetWidth; gbSub.style.animation = ''; }
    if (renderer && world) {
      const col = team === 'red' ? '#E43B3B' : '#2F7DE0';
      renderer.spawnGoal(world.ball.x, world.ball.y, col);
    }
    playGoal();
    socket.emit('host:goal', { team: team, red: redScore, blue: blueScore });

    pTimeout(function () {
      goalBanner.hidden = true;
      // The goal fanfare already played in onGoal, so end the match without a
      // second one (pass afterGoal=true) to avoid a doubled goal sound.
      if (sudden) { endMatch(team, true); return; }
      if (clockMs <= 0) { endMatch(redScore > blueScore ? 'red' : blueScore > redScore ? 'blue' : null, true); return; }
      const concede = team === 'red' ? 'blue' : 'red';
      beginCountdown(concede);
    }, GOAL_CELEBRATE_MS);
  }

  function handleTimeUp() {
    if (redScore === blueScore) {
      // Golden goal: freeze + announce, then restart the ball and ALL players
      // with a fresh (neutral) kickoff + countdown — just like after a goal.
      sudden = true;
      matchState = 'goal';
      updatePauseBtn();
      if (world) world.frozen = true;
      socket.emit('host:sudden', {});
      socket.emit('host:clock', { ms: 0, sudden: true });
      updateScoreboard();
      playWhistle();
      // Brief announce banner.
      gbText.textContent = 'SUDDEN DEATH';
      gbText.style.color = 'var(--accent)';
      if (gbSub) gbSub.textContent = '';
      goalBanner.hidden = false;
      gbText.style.animation = 'none'; void gbText.offsetWidth; gbText.style.animation = '';
      pTimeout(function () {
        if (matchState !== 'ended') beginCountdown(null);
      }, GOAL_CELEBRATE_MS);
    } else {
      endMatch(redScore > blueScore ? 'red' : 'blue');
    }
  }

  function endMatch(winner, afterGoal) {
    matchState = 'ended';
    paused = false;
    pClearAll();
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    if (world) world.frozen = true;
    socket.emit('host:matchEnd', { winner: winner, red: redScore, blue: blueScore });
    playWhistle();
    // Only play the victory fanfare when the match ends on the clock; if it
    // ended on a goal, onGoal already played it (avoids a double goal sound).
    if (!afterGoal) setTimeout(playGoal, 200);
    setTimeout(function () { stopLoop(); renderFinal({ winner: winner, red: redScore, blue: blueScore }); }, 1600);
  }

  function updateScoreboard() {
    sbRedScore.textContent = redScore;
    sbBlueScore.textContent = blueScore;
    sbClock.textContent = sudden ? '0:00' : fmtClock(clockMs);
    sbClock.classList.toggle('urgent', !sudden && clockMs <= 10000);
    sbTag.hidden = !sudden;
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

  // ---------------- Input relay from players ----------------
  socket.on('in', function (d) { if (paused) return; if (world && d) world.setInput(d.id, d.c, d.d === 1); });
  socket.on('dash', function (d) { if (paused) return; if (world && d) world.dash(d.id, d.dir); });
  // Goal-celebration emotes: one per player per goal, shown as a bubble above
  // that player's character. Purely visual — never touches physics.
  socket.on('emote', function (d) {
    if (!world || !d || !d.id || !d.e) return;
    if (emotedThisGoal.has(d.id)) return;
    const p = world.byId.get(d.id);
    if (!p) return;
    emotedThisGoal.add(d.id);
    const now = performance.now();
    p.emote = { char: String(d.e), born: now, until: now + EMOTE_MAX_MS };
  });
  socket.on('player:dropped', function (d) {
    if (!world || !d) return;
    const p = world.byId.get(d.id);
    if (p) { p.connected = false; world.clearInputs(d.id); }
  });
  socket.on('player:rejoined', function (d) {
    if (!world || !d) return;
    const p = world.byId.get(d.id);
    if (p) p.connected = true;
  });

  // ---------------- Boot ----------------
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      renderQR();
      renderLobby(res.lobby);
      if (res.phase === 'LOBBY') show('lobby');
      else if (res.phase === 'PLAYING' && res.match) {
        // Host refreshed mid-match: resume from a fresh kickoff, preserving
        // the cached score + clock (physics positions can't be restored).
        startMatch(res.match.roster, res.match.durationSec, res.match.mode, {
          red: res.match.redScore, blue: res.match.blueScore,
          clockMs: res.match.clockMs, sudden: res.match.sudden,
        });
      } else if (res.phase === 'FINAL' && res.match) {
        roster = res.match.roster || [];
        redScore = res.match.redScore; blueScore = res.match.blueScore;
        renderFinal({ winner: res.match.winner, red: res.match.redScore, blue: res.match.blueScore });
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
    paused = false;
    if (pauseOverlay) pauseOverlay.hidden = true;
    matchState = 'idle';
    updatePauseBtn();
    world = null; renderer = null;
    redScore = blueScore = 0; sudden = false;
    lastLobbyHumanTotal = -1;
    show('lobby');
  });

  // ---------------- Resize ----------------
  window.addEventListener('resize', function () { if (renderer) renderer.resize(); });
})();
