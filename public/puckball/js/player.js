(function () {
  'use strict';

  const playerId = localStorage.getItem('puckball.playerId');
  const playerName = localStorage.getItem('puckball.playerName') || 'Player';
  if (!playerId) { window.location.replace('/puckball/join'); return; }

  const EMOTES = ['😂', '🔥', '👏', '😱', '😭', '😡'];
  const EMOTE_COOLDOWN_MS = 2000;
  const SEND_MIN_MS = 40;          // don't flood the relay
  const STICK_DEADZONE = 0.28;

  // ---------------- Kill all zoom / scroll / selection behaviour ----------------
  // A two-thumb controller (stick + kick) reads as a pinch to the browser, and
  // iOS Safari ignores maximum-scale/user-scalable — so lock it in JS too. The
  // page never scrolls, so every touch move is swallowed outright.
  (function lockZoom() {
    const stop = function (e) { e.preventDefault(); };
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('gestureend', stop, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    let lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      const now = Date.now();
      if (now - lastTouchEnd <= 350) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
    document.addEventListener('contextmenu', stop, { passive: false });
    document.addEventListener('selectstart', stop, { passive: false });
    document.addEventListener('dragstart', stop, { passive: false });
    // iOS still scrolls the document behind a fixed body on some versions.
    window.addEventListener('scroll', function () { window.scrollTo(0, 0); }, { passive: true });
  })();

  const socket = io('/puckball', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const body = document.body;
  const views = {
    lobby: document.getElementById('view-lobby'),
    controller: document.getElementById('view-controller'),
    final: document.getElementById('view-final'),
    kicked: document.getElementById('view-kicked'),
  };
  const lobbyName = document.getElementById('lobbyName');
  const lobbyTeam = document.getElementById('lobbyTeam');
  const hudName = document.getElementById('hudName');
  const hudRed = document.getElementById('hudRed');
  const hudBlue = document.getElementById('hudBlue');
  const hudClock = document.getElementById('hudClock');
  const emoteBar = document.getElementById('emoteBar');
  const stickLayer = document.getElementById('stickLayer');
  const stickBase = document.getElementById('stickBase');
  const stickKnob = document.getElementById('stickKnob');
  const stickHint = document.getElementById('stickHint');
  const kickBtn = document.getElementById('kickBtn');
  const ctrlOverlay = document.getElementById('ctrlOverlay');
  const coNote = document.getElementById('coNote');
  const coCount = document.getElementById('coCount');
  const finalEmoji = document.getElementById('finalEmoji');
  const finalTitle = document.getElementById('finalTitle');
  const finalSub = document.getElementById('finalSub');
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');
  const reconnectOverlay = document.getElementById('reconnectOverlay');
  const pauseCover = document.getElementById('pauseCover');
  const playerAttribution = document.getElementById('playerAttribution');
  const gamepadBadge = document.getElementById('gamepadBadge');

  // ---------------- State ----------------
  let myTeam = 'red';
  // The controller accepts touches through the countdown and goal celebration:
  // the host freezes the world, so a pre-loaded stick only takes effect on the
  // whistle — but it takes effect instantly, with no lift-and-press first.
  let armed = false;
  let kicked = false;
  let paused = false;

  function showView(name) {
    if (kicked && name !== 'kicked') return;
    Object.keys(views).forEach(function (k) {
      if (views[k]) views[k].style.display = (k === name) ? '' : 'none';
    });
    armed = name === 'controller';
    if (!armed) { resetStick(); setKick(false); }
    body.classList.toggle('playing', name === 'controller');
    // Attribution only shows while waiting in the lobby, never in-game.
    if (playerAttribution) playerAttribution.style.display = (name === 'lobby') ? '' : 'none';
  }
  if (lobbyName) lobbyName.textContent = playerName;
  if (hudName) hudName.textContent = playerName;

  function setTeam(team) {
    myTeam = team === 'blue' ? 'blue' : 'red';
    body.classList.toggle('team-blue', myTeam === 'blue');
    body.classList.toggle('team-red', myTeam === 'red');
    if (lobbyTeam) {
      lobbyTeam.textContent = myTeam === 'blue' ? 'Team Blue' : 'Team Red';
      lobbyTeam.className = 'lc-team ' + (myTeam === 'blue' ? 'is-blue' : 'is-red');
    }
  }
  setTeam('red');

  function fmtClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {}
  }

  // ---------------- Host presence / pause ----------------
  function setHostPresent(present) { if (hostAbsentOverlay) hostAbsentOverlay.hidden = !!present; }
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });
  function setPaused(on) {
    paused = !!on;
    if (pauseCover) pauseCover.hidden = !paused;
    if (paused) { resetStick(); setKick(false); }
  }

  // ---------------- Input ----------------
  // The stick is quantised to the eight compass directions and packed with the
  // kick flag into a single tiny message, sent only when something changes.
  let dirX = 0, dirY = 0, kicking = false;
  let touchKicking = false, gamepadKicking = false;
  let lastSentCode = -1, lastSentKick = -1, lastSendAt = 0;
  let sendTimer = null;

  function code() { return (dirX + 1) + (dirY + 1) * 3; }

  function flush() {
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    const c = code();
    const k = kicking ? 1 : 0;
    if (c === lastSentCode && k === lastSentKick) return;
    lastSentCode = c;
    lastSentKick = k;
    lastSendAt = Date.now();
    socket.emit('in', { d: c, k: k });
  }
  function queueSend() {
    if (!armed || paused) return;
    const since = Date.now() - lastSendAt;
    if (since >= SEND_MIN_MS) { flush(); return; }
    if (sendTimer) return;
    sendTimer = setTimeout(function () { sendTimer = null; flush(); }, SEND_MIN_MS - since);
  }

  // A kickoff wipes every input on the host, so the cached "already sent" state
  // is stale: push the stick's real position again or a held thumb does nothing.
  function resendInput() {
    lastSentCode = -1;
    lastSentKick = -1;
    queueSend();
  }

  function setDir(x, y) {
    if (x === dirX && y === dirY) return;
    dirX = x; dirY = y;
    queueSend();
  }
  function setKick(on, source) {
    if (source === 'gamepad') gamepadKicking = !!on;
    else touchKicking = !!on;
    const next = touchKicking || gamepadKicking;
    if (next === kicking) return;
    kicking = next;
    if (kickBtn) kickBtn.classList.toggle('held', kicking);
    if (kicking) vibrate(12);
    queueSend();
  }

  // ---- Floating thumbstick ----
  let stickId = null;
  let stickOX = 0, stickOY = 0;
  let stickRadius = 70;

  function measureStick() {
    if (!stickBase) return;
    const r = stickBase.getBoundingClientRect();
    if (r.width) stickRadius = r.width * 0.42;
  }
  window.addEventListener('resize', measureStick);
  window.addEventListener('orientationchange', measureStick);

  function moveKnob(px, py) {
    if (stickKnob) stickKnob.style.transform = 'translate(-50%, -50%) translate(' + px + 'px, ' + py + 'px)';
  }

  function updateStick(cx, cy) {
    let dx = cx - stickOX;
    let dy = cy - stickOY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0;
    let kx = dx, ky = dy;
    if (dist > stickRadius) { kx = (dx / dist) * stickRadius; ky = (dy / dist) * stickRadius; }
    moveKnob(kx, ky);
    if (dist < stickRadius * STICK_DEADZONE) { setDir(0, 0); return; }
    // Snap the heading to one of 8 directions (45° sectors).
    const ang = Math.atan2(dy, dx);
    const sector = Math.round(ang / (Math.PI / 4));
    const table = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const t = table[((sector % 8) + 8) % 8];
    setDir(t[0], t[1]);
  }

  function grabStick(e) {
    if (stickId !== null || !stickBase || !stickLayer) return;
    stickId = e.pointerId;
    measureStick();
    const zone = stickLayer.getBoundingClientRect();
    const half = stickBase.getBoundingClientRect().width / 2;
    const x = Math.min(Math.max(e.clientX, zone.left + half), zone.right - half);
    const y = Math.min(Math.max(e.clientY, zone.top + half), zone.bottom - half);
    stickBase.style.left = (x - zone.left - half) + 'px';
    stickBase.style.top = (y - zone.top - half) + 'px';
    stickOX = x; stickOY = y;
    stickBase.classList.add('active');
    if (stickHint) stickHint.classList.add('faded');
    updateStick(e.clientX, e.clientY);
  }
  function dragStick(e) {
    if (stickId === null || e.pointerId !== stickId) return;
    updateStick(e.clientX, e.clientY);
  }
  function resetStick(e) {
    if (e && (stickId === null || e.pointerId !== stickId)) return;
    stickId = null;
    if (stickBase) {
      stickBase.classList.remove('active');
      stickBase.style.left = '';
      stickBase.style.top = '';
    }
    moveKnob(0, 0);
    if (stickHint) stickHint.classList.remove('faded');
    setDir(0, 0);
  }

  if (stickLayer) {
    stickLayer.addEventListener('pointerdown', function (e) {
      if (paused || !armed) return;
      e.preventDefault();
      try { stickLayer.setPointerCapture(e.pointerId); } catch (_) {}
      grabStick(e);
    });
    stickLayer.addEventListener('pointermove', function (e) { e.preventDefault(); dragStick(e); });
    stickLayer.addEventListener('pointerup', function (e) { resetStick(e); });
    stickLayer.addEventListener('pointercancel', function (e) { resetStick(e); });
  }
  if (kickBtn) {
    kickBtn.addEventListener('pointerdown', function (e) {
      if (paused || !armed) return;
      e.preventDefault();
      try { kickBtn.setPointerCapture(e.pointerId); } catch (_) {}
      setKick(true);
    });
    kickBtn.addEventListener('pointerup', function (e) { e.preventDefault(); setKick(false); });
    kickBtn.addEventListener('pointercancel', function () { setKick(false); });
    kickBtn.addEventListener('lostpointercapture', function () { setKick(false); });
  }
  // A backgrounded phone must not leave a direction / kick stuck on.
  window.addEventListener('blur', function () { resetStick(); setKick(false); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { resetStick(); setKick(false); }
  });

  // ---------------- Bluetooth / USB gamepad support ----------------
  const GP_DEADZONE = 0.35;
  let gpIndex = null;
  let gpSteering = false;

  function anyGamepad() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    for (let i = 0; i < pads.length; i++) if (pads[i]) return true;
    return false;
  }
  function activeGamepad() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    if (gpIndex !== null && pads[gpIndex]) return pads[gpIndex];
    for (let i = 0; i < pads.length; i++) if (pads[i]) { gpIndex = i; return pads[i]; }
    return null;
  }
  function mapGamepad(gp) {
    const axes = gp.axes || [];
    const buttons = gp.buttons || [];
    const down = function (index) {
      const button = buttons[index];
      return !!(button && (button.pressed || button.value > 0.5));
    };
    let x = Math.abs(axes[0] || 0) >= GP_DEADZONE ? axes[0] : 0;
    let y = Math.abs(axes[1] || 0) >= GP_DEADZONE ? axes[1] : 0;
    if (down(14)) x = -1; else if (down(15)) x = 1;
    if (down(12)) y = -1; else if (down(13)) y = 1;
    if (x || y) {
      const sector = Math.round(Math.atan2(y, x) / (Math.PI / 4));
      const directions = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
      const direction = directions[((sector % 8) + 8) % 8];
      x = direction[0]; y = direction[1];
    }
    return {
      x: x,
      y: y,
      kick: down(0) || down(1) || down(2) || down(3) || down(4) || down(5) || down(6) || down(7),
    };
  }
  function releaseGamepadInput() {
    if (gpSteering && stickId === null) setDir(0, 0);
    gpSteering = false;
    moveKnob(0, 0);
    setKick(false, 'gamepad');
  }
  function setGamepadBadge(on) {
    if (gamepadBadge) gamepadBadge.hidden = !on;
    body.classList.toggle('has-gamepad', !!on);
  }
  function pollGamepad() {
    requestAnimationFrame(pollGamepad);
    const gp = activeGamepad();
    if (!gp) return;
    const mapped = mapGamepad(gp);
    const canControl = armed && !paused;
    setKick(canControl && mapped.kick, 'gamepad');
    if (stickId !== null) { gpSteering = false; return; }
    const pushing = canControl && (mapped.x !== 0 || mapped.y !== 0);
    if (pushing || gpSteering) {
      gpSteering = pushing;
      setDir(pushing ? mapped.x : 0, pushing ? mapped.y : 0);
      moveKnob(pushing ? mapped.x * stickRadius * 0.7 : 0, pushing ? mapped.y * stickRadius * 0.7 : 0);
    }
  }
  window.addEventListener('gamepadconnected', function (e) {
    gpIndex = e.gamepad.index;
    setGamepadBadge(true);
  });
  window.addEventListener('gamepaddisconnected', function (e) {
    if (gpIndex === e.gamepad.index) { gpIndex = null; releaseGamepadInput(); }
    setGamepadBadge(anyGamepad());
  });
  if (anyGamepad()) setGamepadBadge(true);
  pollGamepad();

  // ---------------- Reactions ----------------
  let lastEmoteAt = 0;
  EMOTES.forEach(function (e) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emote-btn';
    b.textContent = e;
    b.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      const now = Date.now();
      if (now - lastEmoteAt < EMOTE_COOLDOWN_MS) return;
      lastEmoteAt = now;
      socket.emit('emote', { e: e });
      b.classList.add('sent');
      vibrate(10);
      setTimeout(function () { b.classList.remove('sent'); }, EMOTE_COOLDOWN_MS);
    });
    emoteBar.appendChild(b);
  });

  // ---------------- Match state ----------------
  function setLive(on) {
    const live = !!on;
    if (ctrlOverlay) ctrlOverlay.hidden = live;
    if (live && stickHint) stickHint.classList.remove('faded');
  }

  function applyMatch(m) {
    if (!m) return;
    if (hudRed) hudRed.textContent = m.redScore;
    if (hudBlue) hudBlue.textContent = m.blueScore;
    if (hudClock) hudClock.textContent = fmtClock(m.clockMs);
    setPaused(!!m.paused);
    setLive(!!m.live && !m.paused);
  }

  socket.on('m:start', function (d) {
    if (d && d.roster) {
      const mine = d.roster.filter(function (r) { return r.id === playerId; })[0];
      if (mine) setTeam(mine.team);
    }
    if (hudRed) hudRed.textContent = '0';
    if (hudBlue) hudBlue.textContent = '0';
    if (hudClock) hudClock.textContent = fmtClock((d && d.timeLimitSec ? d.timeLimitSec : 180) * 1000);
    setPaused(false);
    setLive(false);
    showView('controller');
    vibrate(30);
  });

  socket.on('m:countdown', function (d) {
    setLive(false);
    resendInput();
    if (ctrlOverlay) ctrlOverlay.hidden = false;
    if (coCount) coCount.textContent = (d && d.n > 0) ? String(d.n) : 'GO!';
    if (coNote) {
      coNote.textContent = (d && d.note) || '';
      coNote.hidden = !(d && d.note);
    }
  });
  socket.on('m:play', function () { setLive(true); resendInput(); vibrate(20); });
  socket.on('m:clock', function (d) {
    if (!d) return;
    if (hudClock) {
      hudClock.textContent = fmtClock(d.ms);
      hudClock.classList.toggle('urgent', d.ms <= 15000);
    }
    // The clock is also the match heartbeat — trust it over any event we may
    // have missed while the phone was asleep or the signal dropped.
    if (typeof d.red === 'number' && hudRed) hudRed.textContent = d.red;
    if (typeof d.blue === 'number' && hudBlue) hudBlue.textContent = d.blue;
    if (typeof d.paused === 'boolean') setPaused(d.paused);
    if (typeof d.live === 'boolean') setLive(d.live && !paused);
  });
  socket.on('m:goal', function (d) {
    if (!d) return;
    setLive(false);
    if (hudRed) hudRed.textContent = d.red;
    if (hudBlue) hudBlue.textContent = d.blue;
    if (coNote) { coNote.textContent = d.team === myTeam ? 'GOAL! 🎉' : 'They scored'; coNote.hidden = false; }
    if (coCount) coCount.textContent = d.red + ' – ' + d.blue;
    if (ctrlOverlay) ctrlOverlay.hidden = false;
    vibrate(d.team === myTeam ? [30, 60, 30] : 60);
  });
  socket.on('m:pause', function () { setPaused(true); });
  socket.on('m:resume', function (d) { setPaused(false); setLive(!!(d && d.live)); });
  socket.on('m:end', function (d) {
    setLive(false);
    setPaused(false);
    const drew = d && !d.winner;
    const won = d && d.winner === myTeam;
    if (finalEmoji) finalEmoji.textContent = drew ? '🤝' : (won ? '🏆' : '😤');
    if (finalTitle) finalTitle.textContent = drew ? "It's a draw!" : (won ? 'Your team wins!' : 'Your team lost');
    if (finalSub) finalSub.textContent = d ? (d.red + ' – ' + d.blue) : '';
    showView('final');
    vibrate(won ? [40, 80, 40] : 120);
  });

  socket.on('state:lobby', function (l) {
    if (!l || l.phase !== 'LOBBY') return;
    const all = l.teams.red.concat(l.teams.blue);
    const mineRed = l.teams.red.some(function (p) { return p.id === playerId; });
    const mine = all.filter(function (p) { return p.id === playerId; })[0];
    if (!mine) return;
    setTeam(mineRed ? 'red' : 'blue');
    showView('lobby');
  });

  socket.on('state:reset', function () {
    setLive(false);
    setPaused(false);
    localStorage.removeItem('puckball.playerId');
    localStorage.setItem('puckball.rejoinName', playerName);
    window.location.replace('/puckball/join');
  });

  socket.on('player:rejected', function () {
    kicked = true;
    setLive(false);
    localStorage.removeItem('puckball.playerId');
    showView('kicked');
  });

  kickRejoinBtn && kickRejoinBtn.addEventListener('click', function () {
    localStorage.setItem('puckball.rejoinName', playerName);
    window.location.replace('/puckball/join');
  });

  // ---------------- Boot / reconnect ----------------
  // A dropped phone is never a forfeit: if the server can't place us we keep
  // retrying behind a "Reconnecting" cover instead of throwing the player back
  // to the join page, which would lock them out for the rest of the match.
  let reconnectTries = 0;
  function setReconnecting(on) { if (reconnectOverlay) reconnectOverlay.hidden = !on; }

  function backToJoin() {
    localStorage.setItem('puckball.rejoinName', playerName);
    localStorage.removeItem('puckball.playerId');
    window.location.replace('/puckball/join');
  }

  function attemptReconnect() {
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (!res || !res.ok) {
        reconnectTries++;
        // Only give up once the server is clearly in a fresh lobby (restarted or
        // reset) — then rejoining is possible and is the right thing to do.
        if (res && res.reason === 'unknown-player' && reconnectTries >= 3) return backToJoin();
        setReconnecting(true);
        setTimeout(function () { if (socket.connected) attemptReconnect(); }, 1500);
        return;
      }
      reconnectTries = 0;
      setReconnecting(false);
      kicked = false;
      setHostPresent(res.hostPresent !== false);
      setTeam(res.player && res.player.team);
      // A fresh socket has no input state on the host — force the next send.
      lastSentCode = -1; lastSentKick = -1;
      if (res.phase === 'PLAYING' && res.match) {
        showView('controller');
        // Clear any stale countdown text; the heartbeat repaints within 250ms.
        if (coNote) { coNote.textContent = 'Get ready…'; coNote.hidden = false; }
        if (coCount) coCount.textContent = '';
        applyMatch(res.match);
      } else if (res.phase === 'FINAL' && res.match) {
        const drew = !res.match.winner;
        const won = res.match.winner === (res.player && res.player.team);
        if (finalEmoji) finalEmoji.textContent = drew ? '🤝' : (won ? '🏆' : '😤');
        if (finalTitle) finalTitle.textContent = drew ? "It's a draw!" : (won ? 'Your team wins!' : 'Your team lost');
        if (finalSub) finalSub.textContent = res.match.redScore + ' – ' + res.match.blueScore;
        showView('final');
      } else {
        showView('lobby');
      }
    });
  }

  socket.on('connect', function () { attemptReconnect(); });
  socket.on('disconnect', function () { setReconnecting(true); resetStick(); setKick(false); });

  showView('lobby');
  measureStick();
})();
