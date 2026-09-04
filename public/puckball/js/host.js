(function () {
  'use strict';

  const socket = io('/puckball', { transports: ['polling', 'websocket'] });

  // ---------------- Tunables ----------------
  const FIXED_DT = 1 / 60;           // HaxBall runs at 60 Hz — this must stay 1/60
  const MAX_STEPS = 8;
  const COUNTDOWN_FROM = 3;
  const COUNTDOWN_START_FROM = 5;    // longer count on the first kickoff
  const COUNTDOWN_STEP_MS = 800;
  const GOAL_CELEBRATE_MS = 4800;
  const CLOCK_EMIT_MS = 250;
  const EMOTE_MS = 2600;

  const TIER_LABEL = { small: 'Rink', classic: 'Classic', big: 'Big', huge: 'Stadium' };

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
  const timeRange = document.getElementById('timeRange');
  const timeVal = document.getElementById('timeVal');
  const pitchNote = document.getElementById('pitchNote');
  const slotsRed = document.getElementById('slotsRed');
  const slotsBlue = document.getElementById('slotsBlue');
  const colRed = document.getElementById('colRed');
  const colBlue = document.getElementById('colBlue');
  const countRed = document.getElementById('countRed');
  const countBlue = document.getElementById('countBlue');
  const configHint = document.getElementById('configHint');
  const startBtn = document.getElementById('startBtn');

  const canvas = document.getElementById('pitch');
  const sbRedScore = document.getElementById('sbRedScore');
  const sbBlueScore = document.getElementById('sbBlueScore');
  const sbClock = document.getElementById('sbClock');
  const countOverlay = document.getElementById('countOverlay');
  const coNum = document.getElementById('coNum');
  const coNote = document.getElementById('coNote');
  const goalBanner = document.getElementById('goalBanner');
  const gbText = document.getElementById('gbText');

  const finalTrophy = document.getElementById('finalTrophy');
  const finalHeading = document.getElementById('finalHeading');
  const fsRed = document.getElementById('fsRed');
  const fsBlue = document.getElementById('fsBlue');
  const finalRosters = document.getElementById('finalRosters');
  const playAgainBtn = document.getElementById('playAgainBtn');

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const emoteBtn = document.getElementById('emoteBtn');
  const resetBtn = document.getElementById('resetBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const pauseOverlay = document.getElementById('pauseOverlay');
  const supersededOverlay = document.getElementById('supersededOverlay');

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
  document.addEventListener('click', function once() {
    document.removeEventListener('click', once);
    if (wakeLock === null) acquireWakeLock();
  });

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

  let emotesMuted = false;
  emoteBtn && emoteBtn.addEventListener('click', function () {
    emotesMuted = !emotesMuted;
    socket.emit('host:muteEmotes', { muted: emotesMuted });
    emoteBtn.textContent = emotesMuted ? '🔊 Unmute reactions' : '🔇 Mute reactions';
  });

  // ---------------- Audio (WebAudio, no external assets) ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    return audioCtx;
  }
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
  function noise(dur, freq, gain, q) {
    const c = getAudioCtx(); if (!c) return;
    try {
      const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = c.createBufferSource(); src.buffer = buf;
      const g = c.createGain(); g.gain.value = gain;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start();
    } catch (_) {}
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
  function playCountBlip(n) { blip(520 + (COUNTDOWN_FROM - Math.min(n, COUNTDOWN_FROM)) * 60, 0.13, 'square', 0.14); }
  function playWhistle() {
    const c = getAudioCtx(); if (!c) return;
    blip(1650, 0.18, 'square', 0.13);
    blip(2100, 0.18, 'square', 0.1, c.currentTime + 0.05);
  }
  function playKickSfx() { blip(180, 0.07, 'triangle', 0.2); noise(0.06, 900, 0.05, 2); }
  function playWallSfx(v) { blip(300, 0.05, 'sine', Math.min(0.14, 0.03 + v * 0.02)); }
  function playPostSfx() { blip(1200, 0.22, 'triangle', 0.16); blip(1800, 0.16, 'sine', 0.08); }
  function playGoalSfx() {
    const c = getAudioCtx(); if (!c) return;
    const base = c.currentTime;
    [523, 659, 784, 1047].forEach(function (f, i) { blip(f, 0.35, 'sawtooth', 0.14, base + i * 0.08); });
    noise(1.1, 1000, 0.09, 1);
  }
  function playApplause() {
    const c = getAudioCtx(); if (!c) return;
    noise(1.6, 1200, 0.11, 0.8);
    [659, 784, 988, 1319].forEach(function (f, i) { blip(f, 0.5, 'triangle', 0.14, c.currentTime + i * 0.13); });
  }
  function playHorn() {
    const c = getAudioCtx(); if (!c) return;
    [330, 262].forEach(function (f, i) { blip(f, 0.6, 'sawtooth', 0.12, c.currentTime + i * 0.22); });
  }

  // ---------------- Lobby ----------------
  let lobby = { capacity: 8, perTeam: 4, total: 0, timeLimitSec: 180, tier: 'small', teams: { red: [], blue: [] }, canStart: false };
  let lastLobbyHumanTotal = -1;
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
    fetch('/api/puckball/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        const url = (cfg && cfg.joinUrl) || (window.location.origin + '/puckball/join');
        joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
        return fetch('/api/puckball/qr?url=' + encodeURIComponent(url));
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
    el.title = 'Drag to reorder or move teams — click to swap sides';
    el.addEventListener('click', function () {
      if (suppressClick) { suppressClick = false; return; }
      const to = team === 'red' ? 'blue' : 'red';
      socket.emit('host:assign', { playerId: p.id, team: to }, function (res) {
        if (res && !res.ok && res.reason === 'team-full') showToast('That team is full (max ' + (lobby.perTeam || 4) + ').');
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
    countRed.textContent = l.teams.red.length + '/' + l.perTeam;
    countBlue.textContent = l.teams.blue.length + '/' + l.perTeam;

    timeRange.value = l.timeLimitSec;
    timeVal.textContent = fmtDur(l.timeLimitSec);

    pitchNote.textContent = l.total
      ? TIER_LABEL[l.tier] + ' pitch — ' + l.teams.red.length + ' v ' + l.teams.blue.length
      : 'Grows with the teams';

    function fill(slotEl, arr, team) {
      slotEl.innerHTML = '';
      arr.forEach(function (p) { slotEl.appendChild(chip(p, team)); });
      if (!arr.length) {
        const e = document.createElement('div');
        e.className = 'slot-empty';
        e.textContent = 'Needs at least one player';
        slotEl.appendChild(e);
      }
    }
    fill(slotsRed, l.teams.red, 'red');
    fill(slotsBlue, l.teams.blue, 'blue');

    startBtn.disabled = !l.canStart;
    if (addBotBtn) addBotBtn.disabled = l.total >= l.capacity;
    if (l.canStart) configHint.textContent = '';
    else if (l.total < 2) configHint.textContent = 'Waiting for players…';
    else configHint.textContent = 'Both teams need at least one player.';
  }

  timeRange && timeRange.addEventListener('input', function () {
    timeVal.textContent = fmtDur(Number(timeRange.value));
  });
  timeRange && timeRange.addEventListener('change', function () {
    socket.emit('host:setTimeLimit', { timeLimitSec: Number(timeRange.value) });
  });
  addBotBtn && addBotBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:addBot', {}, function (res) {
      if (res && !res.ok && res.reason === 'game-full') showToast('The lobby is full.');
    });
  });
  startBtn && startBtn.addEventListener('click', function () {
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (res && !res.ok) showToast('Cannot start yet.');
    });
  });
  playAgainBtn && playAgainBtn.addEventListener('click', function () {
    socket.emit('host:reset', {});
  });

  // ---- Smooth pointer-drag for lobby chips ---------------------------------
  // Lift the grabbed chip so it flies with the pointer while a placeholder holds
  // its drop slot; displaced teammates slide via FLIP. Handles reordering within
  // a team AND moving a chip to the other team.
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
    // Which team column is the pointer over? Prefer the one whose box contains
    // the pointer, else fall back to the nearest centre.
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
      if (!before) before = slots.querySelector('.slot-empty'); // sit above the empty note
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
          if (res.reason === 'team-full') showToast('That team is full (max ' + (lobby.perTeam || 4) + ').');
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
  }());

  // ---------------- Match ----------------
  let world = null;
  let renderer = null;
  let roster = [];
  let botIds = [];
  let timeLimitSec = 180;
  let clockMs = 0;
  let redScore = 0;
  let blueScore = 0;
  let paused = false;
  let matchState = 'idle'; // idle | count | play | goal | over
  let superseded = false;  // another host screen took over the simulation
  let rafId = null;
  let lastFrame = 0;
  let acc = 0;
  let lastClockEmit = 0;

  // Pausable timers: driven by the render loop, so a pause really freezes them.
  let timers = [];
  function after(ms, fn) { const t = { left: ms, fn: fn }; timers.push(t); return t; }
  function clearTimers() { timers = []; }
  function runTimers(dtMs) {
    if (!timers.length) return;
    const due = [];
    for (let i = timers.length - 1; i >= 0; i--) {
      timers[i].left -= dtMs;
      if (timers[i].left <= 0) { due.push(timers[i]); timers.splice(i, 1); }
    }
    for (let i = due.length - 1; i >= 0; i--) due[i].fn();
  }

  function updateScoreboard() {
    sbRedScore.textContent = redScore;
    sbBlueScore.textContent = blueScore;
    sbClock.textContent = fmtClock(Math.max(0, clockMs));
    sbClock.classList.toggle('urgent', clockMs <= 15000);
  }

  function startMatch(data, initial) {
    roster = (data && data.roster) || [];
    timeLimitSec = (data && data.timeLimitSec) || 180;
    const tier = (data && data.tier) || 'classic';
    redScore = initial ? initial.red : 0;
    blueScore = initial ? initial.blue : 0;
    clockMs = initial ? initial.clockMs : timeLimitSec * 1000;

    world = new window.PuckBall.World({ tier: tier });
    world.setRoster(roster);
    world.kickoff(data && data.kickoffTeam === 'blue' ? 'blue' : 'red', true);
    world.frozen = true;
    world.redScore = redScore;
    world.blueScore = blueScore;
    botIds = roster.filter(function (r) { return r.isBot; }).map(function (r) { return r.id; });

    renderer = new window.PuckBallRender.Renderer(canvas, world);
    paused = false;
    clearTimers();
    if (pauseOverlay) pauseOverlay.hidden = true;
    goalBanner.hidden = true;

    show('match');
    requestAnimationFrame(function () { renderer.resize(); });
    updateScoreboard();
    updatePauseBtn();
    startLoop();
    beginCountdown(COUNTDOWN_START_FROM, 'KICK OFF');
  }

  function beginCountdown(from, note) {
    matchState = 'count';
    if (world) world.frozen = true;
    goalBanner.hidden = true;
    countOverlay.hidden = false;
    coNote.hidden = !note;
    coNote.textContent = note || '';
    let n = from || COUNTDOWN_FROM;
    const tick = function () {
      coNum.textContent = n > 0 ? String(n) : 'GO!';
      coNum.style.animation = 'none';
      void coNum.offsetWidth;
      coNum.style.animation = '';
      if (n > 0) playCountBlip(n);
      socket.emit('host:countdown', { n: n, note: note || null });
      if (n <= 0) { after(420, beginPlay); return; }
      n--;
      after(COUNTDOWN_STEP_MS, tick);
    };
    tick();
  }

  function beginPlay() {
    matchState = 'play';
    countOverlay.hidden = true;
    goalBanner.hidden = true;
    if (world) world.frozen = false;
    playWhistle();
    socket.emit('host:play', {});
    updatePauseBtn();
  }

  function onGoal(scored) {
    matchState = 'goal';
    if (world) world.frozen = true;
    const team = scored.team;
    redScore = world.redScore;
    blueScore = world.blueScore;
    updateScoreboard();
    renderer && renderer.goalFlash(team);
    goalSplash(team);
    playGoalSfx();
    gbText.textContent = 'GOAL!';
    gbText.style.color = team === 'red' ? 'var(--red-soft)' : 'var(--blue-soft)';
    goalBanner.hidden = false;
    socket.emit('host:goal', { team: team, red: redScore, blue: blueScore });

    after(GOAL_CELEBRATE_MS, function () {
      goalBanner.hidden = true;
      // The conceding team kicks off.
      world.kickoff(team === 'red' ? 'blue' : 'red');
      beginCountdown(COUNTDOWN_FROM, null);
    });
  }

  // Confetti out of the net: a dense team-colour burst plus a white sparkle at
  // the ball, then a delayed second pop while the banner is still up.
  function goalSplash(team) {
    if (!renderer || !world) return;
    const col = team === 'red' ? '#FF6A5E' : '#6AA8F2';
    const bx = world.ball.x, by = world.ball.y;
    const S = world.stadium;
    const mouthX = team === 'red' ? S.halfW : -S.halfW;
    renderer.spawnBurst(bx, by, col, 90);
    renderer.spawnBurst(bx, by, '#FFFFFF', 34);
    renderer.spawnBurst(mouthX, 0, col, 50);
    after(180, function () {
      if (matchState !== 'goal' || !renderer) return;
      renderer.spawnBurst(bx, by, col, 55);
      renderer.spawnBurst(bx, by, '#FFFFFF', 20);
    });
  }

  function handleTimeUp() {
    endMatch(redScore === blueScore ? null : (redScore > blueScore ? 'red' : 'blue'));
  }

  function endMatch(winner) {
    matchState = 'over';
    if (world) world.frozen = true;
    stopLoop();
    clearTimers();
    playHorn();
    socket.emit('host:matchEnd', { winner: winner, red: redScore, blue: blueScore });

    finalTrophy.textContent = winner ? '🏆' : '🤝';
    finalHeading.innerHTML = '';
    const wrap = document.createElement('span');
    wrap.textContent = winner === 'red' ? 'Team Red wins!' : (winner === 'blue' ? 'Team Blue wins!' : "It's a draw!");
    finalHeading.appendChild(wrap);
    fsRed.textContent = redScore;
    fsBlue.textContent = blueScore;

    finalRosters.innerHTML = '';
    ['red', 'blue'].forEach(function (t) {
      const col = document.createElement('div');
      col.className = 'fr-col';
      const title = document.createElement('div');
      title.className = 'fr-title';
      title.textContent = t === 'red' ? 'Team Red' : 'Team Blue';
      title.style.color = t === 'red' ? 'var(--red-soft)' : 'var(--blue-soft)';
      col.appendChild(title);
      roster.filter(function (r) { return r.team === t; }).forEach(function (r) {
        const n = document.createElement('div');
        n.className = 'fr-name';
        n.textContent = (r.isBot ? '🤖 ' : '') + r.name;
        col.appendChild(n);
      });
      finalRosters.appendChild(col);
    });

    show('final');
    playApplause();
    if (winner) confetti();
    startFinalTicker();
  }

  // The final view has no physics loop, so run a tiny ticker for the timers.
  let finalTicker = null;
  function startFinalTicker() {
    stopFinalTicker();
    let last = performance.now();
    finalTicker = setInterval(function () {
      const now = performance.now();
      runTimers(now - last);
      last = now;
    }, 60);
  }
  function stopFinalTicker() { if (finalTicker) { clearInterval(finalTicker); finalTicker = null; } }

  function confetti() {
    const colors = ['#F5D547', '#E43B3B', '#2F7DE0', '#ffffff', '#7BC96F'];
    for (let i = 0; i < 60; i++) {
      const el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.background = colors[i % colors.length];
      el.style.animationDelay = (Math.random() * 0.9) + 's';
      el.style.animationDuration = (2.4 + Math.random() * 1.6) + 's';
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 5000);
    }
  }

  // ---------------- Pause ----------------
  function updatePauseBtn() {
    if (!pauseBtn) return;
    pauseBtn.hidden = matchState !== 'play' && matchState !== 'count' && matchState !== 'goal';
    pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    pauseBtn.classList.toggle('is-paused', paused);
  }
  function pauseMatch() {
    if (paused || matchState === 'idle' || matchState === 'over') return;
    paused = true;
    if (pauseOverlay) pauseOverlay.hidden = false;
    updatePauseBtn();
    socket.emit('host:pause', {});
  }
  function resumeMatch() {
    if (!paused) return;
    paused = false;
    if (pauseOverlay) pauseOverlay.hidden = true;
    updatePauseBtn();
    socket.emit('host:resume', { live: matchState === 'play' });
  }
  pauseBtn && pauseBtn.addEventListener('click', function () {
    if (paused) resumeMatch(); else pauseMatch();
  });

  // ---------------- Loop ----------------
  function startLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    stopFinalTicker();
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

    // Heartbeat: the full authoritative snapshot, in every state (including
    // paused), so a phone that missed an event re-syncs within 250ms.
    if (matchState !== 'idle' && matchState !== 'over' && now - lastClockEmit >= CLOCK_EMIT_MS) {
      lastClockEmit = now;
      socket.emit('host:clock', {
        ms: Math.max(0, clockMs),
        red: redScore,
        blue: blueScore,
        live: matchState === 'play' && !paused,
        paused: paused,
      });
    }

    if (!paused) {
      runTimers(dt * 1000);

      if (matchState === 'play' && world) {
        acc += dt;
        let steps = 0;
        let scored = null;
        while (acc >= FIXED_DT && steps < MAX_STEPS) {
          world.stepBots();
          scored = world.step();
          acc -= FIXED_DT;
          steps++;
          if (scored) break;
        }
        drainEvents();
        if (scored) {
          acc = 0;
          onGoal(scored);
        } else {
          clockMs -= dt * 1000;
          if (clockMs <= 0) { clockMs = 0; handleTimeUp(); }
          updateScoreboard();
        }
      } else if (world && (matchState === 'count' || matchState === 'goal')) {
        // Keep resolving overlaps so nothing is stuck while frozen.
        acc = 0;
        world.step();
        world.events.length = 0;
      }
    }

    if (renderer) renderer.render(matchState === 'play' ? Math.min(1, acc / FIXED_DT) : 1, dt);
  }

  function drainEvents() {
    if (!world) return;
    const evs = world.events;
    let wall = 0;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.t === 'kick') playKickSfx();
      else if (e.t === 'post') playPostSfx();
      else if (e.t === 'wall' && wall < 2) { playWallSfx(e.v); wall++; }
      else if (e.t === 'bump' && wall < 2) { playWallSfx(e.v * 0.6); wall++; }
    }
    evs.length = 0;
  }

  // ---------------- Socket ----------------
  socket.on('in', function (d) {
    if (!world || !d || paused) return;
    // d.d packs the 8-way stick as (dx+1) + (dy+1)*3.
    const dx = (d.d % 3) - 1;
    const dy = Math.floor(d.d / 3) - 1;
    world.setInput(d.id, dx, dy, d.k === 1);
  });

  socket.on('emote', function (d) {
    if (!world || !d || emotesMuted) return;
    const p = world.byId.get(d.id);
    if (p) p.emote = { e: d.e, until: Date.now() + EMOTE_MS };
  });

  socket.on('player:dropped', function (d) {
    if (world && d) world.setConnected(d.id, false);
  });
  socket.on('player:rejoined', function (d) {
    if (world && d) world.setConnected(d.id, true);
  });

  let authedOnce = false;
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      superseded = false;
      if (supersededOverlay) supersededOverlay.hidden = true;
      emotesMuted = !!res.emotesMuted;
      if (emoteBtn) emoteBtn.textContent = emotesMuted ? '🔊 Unmute reactions' : '🔇 Mute reactions';
      // A dropped-and-restored socket must never restart a match this screen is
      // already simulating — just carry on, the heartbeat re-syncs the players.
      if (authedOnce && matchState !== 'idle') return;
      authedOnce = true;
      renderLobby(res.lobby);
      if (res.phase === 'PLAYING' && res.match) {
        startMatch(res.match, { red: res.match.redScore, blue: res.match.blueScore, clockMs: res.match.clockMs });
      } else if (res.phase === 'FINAL' && res.match) {
        roster = res.match.roster || [];
        redScore = res.match.redScore;
        blueScore = res.match.blueScore;
        endMatch(res.match.winner || (redScore === blueScore ? null : (redScore > blueScore ? 'red' : 'blue')));
      } else {
        show('lobby');
      }
    });
  });

  // Another host screen opened: only one may drive the physics, so stand down.
  socket.on('host:superseded', function () {
    superseded = true;
    stopLoop();
    stopFinalTicker();
    clearTimers();
    world = null;
    renderer = null;
    matchState = 'idle';
    if (supersededOverlay) supersededOverlay.hidden = false;
  });

  socket.on('m:start', function (d) {
    if (superseded) return;
    startMatch(d, null);
  });

  socket.on('state:lobby', function (l) {
    if (l && l.phase === 'LOBBY') renderLobby(l);
  });

  socket.on('state:reset', function () {
    stopLoop();
    stopFinalTicker();
    clearTimers();
    world = null;
    renderer = null;
    roster = [];
    matchState = 'idle';
    paused = false;
    redScore = blueScore = 0;
    lastLobbyHumanTotal = -1;
    goalBanner.hidden = true;
    countOverlay.hidden = true;
    if (pauseOverlay) pauseOverlay.hidden = true;
    show('lobby');
  });

  window.addEventListener('resize', function () { if (renderer) renderer.resize(); });

  renderQR();
}());
