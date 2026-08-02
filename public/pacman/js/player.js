(function () {
  'use strict';

  const playerId = localStorage.getItem('pacman.playerId');
  const playerName = localStorage.getItem('pacman.playerName') || 'Player';
  if (!playerId) { window.location.replace('/pacman/join'); return; }

  // Direction codes shared with the server relay + host engine.
  const UP = 0, DOWN = 1, LEFT = 2, RIGHT = 3;

  // ---------------- Kill all zoom / gesture behaviour ----------------
  // This is a fixed fullscreen gamepad — it must NEVER zoom or pan. iOS Safari
  // ignores maximum-scale/user-scalable, so belt-and-suspenders in JS:
  //   • block pinch (iOS gesture events + any multi-touch move)
  //   • block double-tap-to-zoom
  (function lockZoom() {
    const stop = function (e) { e.preventDefault(); };
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('gestureend', stop, { passive: false });
    // Any 2+ finger move = a pinch; cancel it.
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
    // Double-tap zoom: swallow the default on a quick second tap.
    let lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      const now = Date.now();
      if (now - lastTouchEnd <= 350) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
  })();

  const socket = io('/pacman', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const body = document.body;
  const views = {
    lobby: document.getElementById('view-lobby'),
    controller: document.getElementById('view-controller'),
    eliminated: document.getElementById('view-eliminated'),
    final: document.getElementById('view-final'),
    kicked: document.getElementById('view-kicked'),
  };
  const lobbyName = document.getElementById('lobbyName');
  const hudName = document.getElementById('hudName');
  const hudScore = document.getElementById('hudScore');
  const hudPips = document.getElementById('hudPips');
  const ctrlOverlay = document.getElementById('ctrlOverlay');
  const coCount = document.getElementById('coCount');
  const coText = document.getElementById('coText');
  const poweredBadge = document.getElementById('poweredBadge');
  const flash = document.getElementById('flash');
  const flashText = document.getElementById('flashText');
  const pad = document.getElementById('pad');
  const finalEmoji = document.getElementById('finalEmoji');
  const finalTitle = document.getElementById('finalTitle');
  const finalSub = document.getElementById('finalSub');
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');
  const pauseCover = document.getElementById('pauseCover');
  const playerAttribution = document.getElementById('playerAttribution');
  const elimIcon = document.getElementById('elimIcon');
  const elimTitle = document.getElementById('elimTitle');
  const elimSub = document.getElementById('elimSub');
  const swipeArrow = document.getElementById('swipeArrow');
  const gamepadBadge = document.getElementById('gamepadBadge');
  const gearBtn = document.getElementById('gearBtn');
  const ctrlPopover = document.getElementById('ctrlPopover');
  const modeToggle = document.getElementById('modeToggle');
  const ctrlSettings = document.getElementById('ctrlSettings');
  const dpad = document.getElementById('dpad');
  const swipeHint = document.getElementById('swipeHint');
  const stickLayer = document.getElementById('stickLayer');
  const stickBase = document.getElementById('stickBase');
  const stickKnob = document.getElementById('stickKnob');

  // ---------------- State ----------------
  let currentPhase = 'LOBBY';
  let controlsEnabled = false;
  let eliminated = false;
  let roundsToWin = 3;
  let myGamePoints = 0;
  let kicked = false;

  function showView(name) {
    if (kicked && name !== 'kicked') return;
    Object.keys(views).forEach(function (k) { if (views[k]) views[k].style.display = (k === name) ? '' : 'none'; });
    body.classList.toggle('playing', name === 'controller');
    // Attribution only shows on the lobby (waiting) screen, never in-game.
    if (playerAttribution) playerAttribution.style.display = (name === 'lobby') ? '' : 'none';
    // The control-scheme picker stays available while playing AND while
    // eliminated, so a dead player can pre-pick their controls for next round.
    if (ctrlSettings) {
      var showSettings = (name === 'controller' || name === 'eliminated');
      ctrlSettings.style.display = showSettings ? '' : 'none';
      if (!showSettings && ctrlPopover) {
        ctrlPopover.hidden = true;
        if (gearBtn) gearBtn.setAttribute('aria-expanded', 'false');
      }
    }
  }
  if (lobbyName) lobbyName.textContent = playerName;
  if (hudName) hudName.textContent = playerName;

  // ---------------- Host presence ----------------
  function setHostPresent(present) { if (hostAbsentOverlay) hostAbsentOverlay.hidden = !!present; }
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });

  // ---------------- Boot / reconnect ----------------
  socket.on('connect', function () {
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (!res || !res.ok) {
        localStorage.setItem('pacman.rejoinName', playerName);
        localStorage.removeItem('pacman.playerId');
        window.location.replace('/pacman/join');
        return;
      }
      setHostPresent(res.hostPresent !== false);
      applyPhase(res);
    });
  });

  function applyPhase(res) {
    currentPhase = res.phase;
    if (res.match) { roundsToWin = res.match.roundsToWin || roundsToWin; myGamePoints = (res.match.gamePoints || {})[playerId] || 0; }
    if (res.phase === 'LOBBY') { showView('lobby'); }
    else if (res.phase === 'PLAYING') {
      showView('controller');
      const alive = res.match && res.match.alive ? res.match.alive[playerId] !== false : true;
      eliminated = !alive;
      updateHud(res.match ? (res.match.scores || {})[playerId] : 0);
      const isPaused = !!(res.match && res.match.paused);
      if (pauseCover) pauseCover.hidden = !isPaused;
      if (eliminated) showEliminated();
      else if (isPaused) { setControls(false); }
      else { setControls(!!(res.match && res.match.live)); if (!(res.match && res.match.live)) showOverlay('', 'Get ready…'); else hideOverlay(); }
    } else if (res.phase === 'FINAL') {
      renderFinal(res.match || {});
    }
  }

  socket.on('state:lobby', function () {
    if (currentPhase === 'LOBBY') showView('lobby');
  });
  socket.on('state:reset', function () {
    localStorage.setItem('pacman.rejoinName', playerName);
    localStorage.removeItem('pacman.playerId');
    window.location.replace('/pacman/join');
  });
  socket.on('player:rejected', function (p) {
    if (p && p.reason === 'kicked') { kicked = true; localStorage.removeItem('pacman.playerId'); showView('kicked'); }
  });

  // ---------------- Match events ----------------
  socket.on('m:start', function (d) {
    currentPhase = 'PLAYING';
    if (d) { roundsToWin = d.roundsToWin || roundsToWin; }
    myGamePoints = 0; eliminated = false;
    updateHud(0);
    hideFlash();
    showView('controller');
    setControls(false);
    showOverlay('', 'Get ready…');
  });
  socket.on('m:roundStart', function (d) {
    currentPhase = 'PLAYING';
    eliminated = false;
    if (d) roundsToWin = d.roundsToWin || roundsToWin;
    if (poweredBadge) poweredBadge.hidden = true;
    body.classList.remove('powered');
    hideFlash();
    showView('controller');
    setControls(false);
    showOverlay('', 'Round ' + (d && d.round ? d.round : '') + '…');
  });
  socket.on('m:countdown', function (d) {
    if (eliminated) return;
    hideFlash();
    setControls(false);
    showOverlay(d && d.n != null ? String(d.n) : '', 'Get ready…');
  });
  socket.on('m:play', function () {
    if (eliminated) return;
    hideFlash();
    hideOverlay();
    setControls(true);
  });
  socket.on('m:clock', function (d) {
    if (d && d.scores) updateHud(d.scores[playerId]);
  });
  socket.on('m:powered', function (d) {
    if (!d || d.id !== playerId) return;
    body.classList.toggle('powered', !!d.on);
    if (poweredBadge) poweredBadge.hidden = !d.on;
  });
  socket.on('m:eliminated', function (d) {
    if (!d || d.id !== playerId) return;
    eliminated = true;
    setControls(false);
    showEliminated();
  });
  socket.on('m:roundOver', function (d) {
    setControls(false);
    if (d && d.gamePoints) { myGamePoints = d.gamePoints[playerId] || 0; updateHud(d.scores ? d.scores[playerId] : undefined); }
    const won = d && d.winnerIds && d.winnerIds.indexOf(playerId) >= 0;
    if (eliminated) {
      // Dead players can still WIN the round on score — surface it on the out
      // screen (they never see the controller flash).
      if (elimIcon) elimIcon.textContent = won ? '🏆' : '💀';
      if (elimTitle) { elimTitle.textContent = won ? 'Round won!' : 'Round over'; elimTitle.style.color = won ? 'var(--good)' : ''; }
      if (elimSub) elimSub.textContent = won ? 'Top score even after going out!' : 'Back in the next round.';
    } else {
      // Persist the result until the next round begins (cleared on m:roundStart).
      showFlash(won ? 'Round won!' : 'Round over', !!won, true);
    }
  });
  socket.on('m:pause', function () {
    setControls(false);
    if (pauseCover) pauseCover.hidden = false;
  });
  socket.on('m:resume', function (d) {
    if (pauseCover) pauseCover.hidden = true;
    setControls(!!(d && d.live) && !eliminated);
  });
  socket.on('m:end', function (d) {
    currentPhase = 'FINAL';
    setControls(false);
    hideFlash();
    renderFinal(d || {});
  });

  // ---------------- HUD ----------------
  function updateHud(score) {
    if (typeof score === 'number' && hudScore) hudScore.textContent = score;
    if (!hudPips) return;
    if (hudPips.children.length !== roundsToWin) {
      hudPips.innerHTML = '';
      for (let k = 0; k < roundsToWin; k++) { const d = document.createElement('span'); d.className = 'pip'; hudPips.appendChild(d); }
    }
    for (let k = 0; k < hudPips.children.length; k++) hudPips.children[k].classList.toggle('on', k < myGamePoints);
  }

  function showOverlay(count, text) {
    if (!ctrlOverlay) return;
    ctrlOverlay.hidden = false;
    if (count && count.length) { coCount.style.display = ''; coCount.textContent = count; coCount.style.animation = 'none'; void coCount.offsetWidth; coCount.style.animation = ''; }
    else coCount.style.display = 'none';
    coText.textContent = text || '';
  }
  function hideOverlay() { if (ctrlOverlay) ctrlOverlay.hidden = true; }

  let flashTimer = null;
  function showFlash(text, good, persist) {
    if (!flash) return;
    flashText.textContent = text;
    flashText.style.color = good ? 'var(--good)' : 'var(--warn)';
    flash.hidden = false;
    flashText.style.animation = 'none'; void flashText.offsetWidth; flashText.style.animation = '';
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    if (!persist) flashTimer = setTimeout(function () { flash.hidden = true; }, 1600);
  }
  function hideFlash() { if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; } if (flash) flash.hidden = true; }

  function showEliminated() {
    hideOverlay();
    // Reset to the default "out" message (m:roundOver may later flip it to a win).
    if (elimIcon) elimIcon.textContent = '💀';
    if (elimTitle) { elimTitle.textContent = "You're out!"; elimTitle.style.color = ''; }
    if (elimSub) elimSub.textContent = "Sit tight — you're back in next round.";
    showView('eliminated');
  }

  function renderFinal(d) {
    const champs = (d && d.winnerIds) || [];
    const iWon = champs.indexOf(playerId) >= 0;
    if (iWon) { finalEmoji.textContent = '🏆'; finalTitle.textContent = 'You win!'; }
    else { finalEmoji.textContent = '👻'; finalTitle.textContent = 'Game over'; }
    finalSub.textContent = 'Look up at the host screen for the results.';
    showView('final');
  }

  // ---------------- Controls ----------------
  // Three control schemes the player can switch between via the ⚙️ gear:
  //   • Joystick (default): a thumbstick appears wherever the thumb lands;
  //     pushing it past a small deadzone steers, and the heading sticks after
  //     letting go while the knob springs back to centre.
  //   • Swipe: the WHOLE screen is a pad — flick a direction anywhere and the
  //     Pac-Man turns that way and keeps going until the next flick.
  //   • Tap zones: the screen splits along its diagonals into 4 triangles
  //     (top=up, bottom=down, left=left, right=right); tap a zone to steer.
  // A tiny haptic buzz confirms each turn; a big central arrow (swipe) or the
  // lit-up zone (tap) shows the current heading.
  const SWIPE_THRESHOLD = 22;      // px of drag before a direction registers
  const ARROW_DEG = { 0: 0, 1: 180, 2: 270, 3: 90 }; // base arrow points UP; rotate to dir
  let currentDir = -1;
  let touch = null;                // active gesture: { id, x, y }
  const controllerView = views.controller;

  // Persisted control scheme: 'stick' (default), 'swipe' or 'tap'.
  const savedMode = localStorage.getItem('pacman.controlMode');
  let controlMode = (savedMode === 'tap' || savedMode === 'swipe') ? savedMode : 'stick';
  const dpadZones = dpad ? Array.prototype.slice.call(dpad.querySelectorAll('.dpad-zone')) : [];

  function send(dir) { socket.emit('in', { dir: dir }); }
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} }
  function highlightZone(dir) {
    dpadZones.forEach(function (z) { z.classList.toggle('active', Number(z.getAttribute('data-dir')) === dir); });
  }
  function showDir(dir) {
    highlightZone(dir);
    if (!swipeArrow) return;
    if (dir < 0) { swipeArrow.style.opacity = '0.25'; return; }
    swipeArrow.style.opacity = '1';
    swipeArrow.style.transform = 'rotate(' + (ARROW_DEG[dir] - 90) + 'deg)'; // '➤' points RIGHT at 0°
  }
  function setDir(dir) {
    if (!controlsEnabled || eliminated || dir < 0) return;
    if (dir !== currentDir) { currentDir = dir; vibrate(14); showDir(dir); }
    send(dir); // Pac-Man buffers the desired heading; re-sending the same one is harmless.
  }
  function setControls(enabled) {
    controlsEnabled = enabled && !eliminated;
    if (pad) pad.style.opacity = controlsEnabled ? '1' : '0.5';
    if (!controlsEnabled) { currentDir = -1; showDir(-1); touch = null; releaseStick(true); }
  }

  // In Tap mode, the direction is the triangle the touch lands in: measured from
  // the pad's centre, a mostly-horizontal offset is left/right, otherwise up/down
  // — which is exactly the diagonal split the visible zones draw.
  function zoneDirFromPoint(x, y) {
    const r = (pad || controllerView).getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    if (dx === 0 && dy === 0) return -1;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : (dy > 0 ? DOWN : UP);
  }

  // ---------------- Joystick mode ----------------
  // A floating thumbstick: the base jumps to wherever the thumb lands, the knob
  // follows the drag, and the dominant axis past the deadzone is the heading.
  // Steering stays discrete like the other schemes — the heading is latched, so
  // letting go keeps the last direction (classic Pac-Man) while the knob springs
  // back to centre the way a real stick does.
  const STICK_DEADZONE = 0.34;     // fraction of the radius before a turn registers
  let stickId = null;              // active pointer id, or null
  let stickOriginX = 0, stickOriginY = 0;
  let stickRadius = 70;            // px of travel to full deflection

  function measureStickRadius() {
    if (!stickBase) return;
    const r = stickBase.getBoundingClientRect();
    if (r.width) stickRadius = r.width * 0.42;
  }
  window.addEventListener('resize', measureStickRadius);
  window.addEventListener('orientationchange', measureStickRadius);

  function setKnob(px, py) {
    if (stickKnob) stickKnob.style.transform = 'translate(-50%, -50%) translate(' + px + 'px, ' + py + 'px)';
  }

  function updateStick(clientX, clientY) {
    let dx = clientX - stickOriginX;
    let dy = clientY - stickOriginY;
    const dist = Math.hypot(dx, dy);
    if (dist > stickRadius) { dx = (dx / dist) * stickRadius; dy = (dy / dist) * stickRadius; }
    setKnob(dx, dy);
    if (dist < stickRadius * STICK_DEADZONE) return;  // a nudge/tap is not a turn
    setDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : (dy > 0 ? DOWN : UP));
  }

  function grabStick(e) {
    if (stickId !== null || !stickBase || !stickLayer) return;
    stickId = e.pointerId;
    // Recentre the visible base under the thumb, but keep it fully on-screen.
    // The ORIGIN stays on the finger, so planting a thumb near the edge doesn't
    // read as a deflection nobody asked for.
    measureStickRadius();
    const zone = stickLayer.getBoundingClientRect();
    const half = stickBase.getBoundingClientRect().width / 2;
    const x = Math.min(Math.max(e.clientX, zone.left + half), zone.right - half);
    const y = Math.min(Math.max(e.clientY, zone.top + half), zone.bottom - half);
    stickBase.style.position = 'absolute';
    stickBase.style.left = (x - zone.left - half) + 'px';
    stickBase.style.top = (y - zone.top - half) + 'px';
    stickOriginX = e.clientX; stickOriginY = e.clientY;
    stickBase.classList.add('active');
    try { controllerView.setPointerCapture(e.pointerId); } catch (_) {}
    updateStick(e.clientX, e.clientY);
  }

  function moveStick(e) {
    if (stickId === null || e.pointerId !== stickId) return;
    updateStick(e.clientX, e.clientY);
  }

  function releaseStick(force, e) {
    if (!force && (stickId === null || !e || e.pointerId !== stickId)) return;
    stickId = null;
    if (!stickBase) return;
    stickBase.classList.remove('active');
    stickBase.style.position = '';
    stickBase.style.left = '';
    stickBase.style.top = '';
    setKnob(0, 0);   // springs back to centre; the heading itself persists
  }

  // A drag interrupted by a call / notification / tab switch must not leave the
  // stick stuck to a dead pointer.
  window.addEventListener('blur', function () { releaseStick(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') releaseStick(true);
  });

  function applyControlMode(mode) {
    controlMode = (mode === 'tap' || mode === 'swipe') ? mode : 'stick';
    localStorage.setItem('pacman.controlMode', controlMode);
    body.classList.toggle('mode-tap', controlMode === 'tap');
    body.classList.toggle('mode-swipe', controlMode === 'swipe');
    body.classList.toggle('mode-stick', controlMode === 'stick');
    if (swipeHint) {
      swipeHint.textContent = controlMode === 'tap' ? 'Tap a zone to move'
        : controlMode === 'swipe' ? 'Swipe anywhere to move'
        : 'Drag the stick to move';
    }
    if (modeToggle) {
      modeToggle.querySelectorAll('.mode-opt').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === controlMode);
      });
    }
    touch = null;
    releaseStick(true);
    // The stick is only laid out once its mode is on, so measure after the class
    // flip.
    measureStickRadius();
  }
  applyControlMode(controlMode);

  // Gear button toggles a small popover holding the control-scheme picker. Its taps
  // must never steer the Pac-Man, so they stop propagation before the pad sees
  // them and don't count as a control gesture.
  function stopControl(e) { e.stopPropagation(); }
  if (gearBtn && ctrlPopover) {
    gearBtn.addEventListener('pointerdown', stopControl);
    gearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      const open = ctrlPopover.hidden;
      ctrlPopover.hidden = !open;
      gearBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    ctrlPopover.addEventListener('pointerdown', stopControl);
  }
  if (modeToggle) {
    modeToggle.addEventListener('pointerdown', stopControl);
    modeToggle.addEventListener('click', function (e) {
      const btn = e.target.closest('.mode-opt');
      if (!btn) return;
      e.stopPropagation();
      applyControlMode(btn.getAttribute('data-mode'));
    });
  }
  // Tapping anywhere else closes the popover.
  document.addEventListener('pointerdown', function () {
    if (ctrlPopover && !ctrlPopover.hidden) { ctrlPopover.hidden = true; if (gearBtn) gearBtn.setAttribute('aria-expanded', 'false'); }
  });

  if (controllerView) {
    controllerView.addEventListener('pointerdown', function (e) {
      if (!controlsEnabled || eliminated) return;
      e.preventDefault();
      if (controlMode === 'tap') { setDir(zoneDirFromPoint(e.clientX, e.clientY)); return; }
      if (controlMode === 'stick') { grabStick(e); return; }
      try { controllerView.setPointerCapture(e.pointerId); } catch (_) {}
      touch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    controllerView.addEventListener('pointermove', function (e) {
      if (controlMode === 'tap') return;   // discrete taps only — sliding does nothing
      if (controlMode === 'stick') { moveStick(e); return; }
      if (!touch || e.pointerId !== touch.id) return;
      const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx, ady) < SWIPE_THRESHOLD) return;
      setDir(adx > ady ? (dx > 0 ? RIGHT : LEFT) : (dy > 0 ? DOWN : UP));
      touch.x = e.clientX; touch.y = e.clientY;   // re-anchor → fluid direction changes
    });
    const endTouch = function (e) {
      releaseStick(false, e);
      if (!touch || (e && e.pointerId !== touch.id)) return;
      touch = null;
    };
    controllerView.addEventListener('pointerup', endTouch);
    controllerView.addEventListener('pointercancel', endTouch);
    controllerView.addEventListener('lostpointercapture', endTouch);
  }

  // Keyboard support (arrows / WASD) for host-side desktop testing.
  document.addEventListener('keydown', function (e) {
    let dir = -1;
    if (e.key === 'ArrowUp' || e.key === 'w') dir = UP;
    else if (e.key === 'ArrowDown' || e.key === 's') dir = DOWN;
    else if (e.key === 'ArrowLeft' || e.key === 'a') dir = LEFT;
    else if (e.key === 'ArrowRight' || e.key === 'd') dir = RIGHT;
    if (dir >= 0 && controlsEnabled && !eliminated) { e.preventDefault(); setDir(dir); }
  });

  // ---------------- Gamepad (Bluetooth controller) support ----------------
  // Any controller paired to the phone — Xbox, PlayStation, or Switch Pro —
  // drives Pac-Man via the standard Gamepad API layout, so the same left-stick
  // and D-pad indices work across all brands (no per-brand code). Steering is
  // discrete like the swipe pad: pushing a direction just calls setDir(), which
  // is gated + de-duped + re-send-safe; letting go keeps the last heading
  // (classic Pac-Man). Runs alongside touch — either input works at any time.
  const GP_DEADZONE = 0.35;          // ignore analog-stick drift near centre
  let gpIndex = null;                // index of the active gamepad, or null

  function anyGamepad() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    for (let i = 0; i < pads.length; i++) { if (pads[i]) return true; }
    return false;
  }
  function activeGamepad() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    if (gpIndex !== null && pads[gpIndex]) return pads[gpIndex];
    for (let i = 0; i < pads.length; i++) { if (pads[i]) { gpIndex = i; return pads[i]; } }
    return null;
  }
  function gpDown(gp, i) { const b = gp.buttons && gp.buttons[i]; return !!(b && (b.pressed || b.value > 0.5)); }
  // Translate a gamepad's stick/D-pad into a single direction, or -1 for none.
  function mapGamepad(gp) {
    const a = gp.axes || [];
    const ax = a.length > 0 ? (a[0] || 0) : 0;   // left stick X (− left, + right)
    const ay = a.length > 1 ? (a[1] || 0) : 0;   // left stick Y (− up,   + down)
    if (Math.abs(ax) > GP_DEADZONE || Math.abs(ay) > GP_DEADZONE) {
      return Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? LEFT : RIGHT) : (ay < 0 ? UP : DOWN);
    }
    if (gpDown(gp, 12)) return UP;      // D-pad up
    if (gpDown(gp, 13)) return DOWN;    // D-pad down
    if (gpDown(gp, 14)) return LEFT;    // D-pad left
    if (gpDown(gp, 15)) return RIGHT;   // D-pad right
    return -1;
  }
  function pollGamepad() {
    requestAnimationFrame(pollGamepad);
    if (!controlsEnabled || eliminated) return;
    const gp = activeGamepad();
    if (!gp) return;
    const dir = mapGamepad(gp);
    if (dir >= 0) setDir(dir);   // setDir de-dupes; neutral (-1) keeps last heading
  }
  function setGamepadBadge(on) {
    if (gamepadBadge) gamepadBadge.hidden = !on;
    body.classList.toggle('has-gamepad', !!on);
  }
  window.addEventListener('gamepadconnected', function (e) {
    gpIndex = e.gamepad.index;
    setGamepadBadge(true);
  });
  window.addEventListener('gamepaddisconnected', function (e) {
    if (gpIndex === e.gamepad.index) gpIndex = null;
    setGamepadBadge(anyGamepad());
  });
  // A controller paired before the page loaded won't fire 'gamepadconnected'
  // until its first input, so reflect current state on boot too.
  if (anyGamepad()) setGamepadBadge(true);
  pollGamepad();

  kickRejoinBtn && kickRejoinBtn.addEventListener('click', function () {
    localStorage.setItem('pacman.rejoinName', playerName);
    localStorage.removeItem('pacman.playerId');
    window.location.replace('/pacman/join');
  });
})();
