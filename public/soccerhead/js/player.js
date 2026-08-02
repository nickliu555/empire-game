(function () {
  'use strict';

  const playerId = localStorage.getItem('soccerhead.playerId');
  const playerName = localStorage.getItem('soccerhead.playerName') || 'Player';
  if (!playerId) { window.location.replace('/soccerhead/join'); return; }

  // Must match the host's dash cooldown so the on-screen ring is honest.
  const DASH_COOLDOWN_MS = 2200;
  const DASH_TAP_MS = 350;
  // Input codes shared with the server relay + host engine.
  const LEFT = 0, RIGHT = 1, JUMP = 2, KICK = 3;

  const socket = io('/soccerhead', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const body = document.body;
  const views = {
    lobby: document.getElementById('view-lobby'),
    controller: document.getElementById('view-controller'),
    final: document.getElementById('view-final'),
    kicked: document.getElementById('view-kicked'),
  };
  const playerAttribution = document.getElementById('playerAttribution');
  const lobbyTeamBadge = document.getElementById('lobbyTeamBadge');
  const lobbyName = document.getElementById('lobbyName');
  const scoreRed = document.getElementById('scoreRed');
  const scoreBlue = document.getElementById('scoreBlue');
  const hudClock = document.getElementById('hudClock');
  const hudYou = document.getElementById('hudYou');
  const ctrlOverlay = document.getElementById('ctrlOverlay');
  const coCount = document.getElementById('coCount');
  const coText = document.getElementById('coText');
  const flash = document.getElementById('flash');
  const flashText = document.getElementById('flashText');
  const pauseCover = document.getElementById('pauseCover');
  const rotateHint = document.getElementById('rotateHint');
  const finalEmoji = document.getElementById('finalEmoji');
  const finalTitle = document.getElementById('finalTitle');
  const finalScore = document.getElementById('finalScore');
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');
  const pad = document.getElementById('pad');
  const dashLeft = document.getElementById('dashLeft');
  const dashRight = document.getElementById('dashRight');
  const gamepadBadge = document.getElementById('gamepadBadge');
  const emotePanel = document.getElementById('emotePanel');
  const emoteGrid = document.getElementById('emoteGrid');

  // Goal-celebration reactions. Must mirror ALLOWED_EMOTES in server/soccerhead/index.js.
  const EMOTES = ['😀', '😂', '😎', '😭', '😡', '👍', '⚽', '🔥', '💪', '🎉'];

  const btns = {
    0: document.getElementById('btnLeft'),
    1: document.getElementById('btnRight'),
    2: document.getElementById('btnJump'),
    3: document.getElementById('btnKick'),
  };

  // ---------------- State ----------------
  let myTeam = 'red';
  let currentPhase = 'LOBBY';
  let controlsEnabled = false;
  let lastTap = { 0: 0, 1: 0 };
  let dashCooldownUntil = 0;
  let dashRingTimer = null;
  const activePointers = new Map(); // pointerId -> code
  // Once kicked, this screen is terminal — ignore any later lobby/match
  // broadcasts (the socket stays in the room briefly and would otherwise yank
  // us back to the lobby view).
  let kicked = false;

  function showView(name) {
    if (kicked && name !== 'kicked') return;
    Object.keys(views).forEach(function (k) {
      if (views[k]) views[k].style.display = (k === name) ? '' : 'none';
    });
    body.classList.toggle('playing', name === 'controller');
    // Credit belongs on the lobby wait only — never mid-match or on the final.
    if (playerAttribution) playerAttribution.hidden = (name !== 'lobby');
    updateRotateHint();
  }

  function setTeam(team) {
    myTeam = team === 'blue' ? 'blue' : 'red';
    body.setAttribute('data-team', myTeam);
    if (lobbyTeamBadge) lobbyTeamBadge.textContent = myTeam.toUpperCase();
    if (hudYou) hudYou.innerHTML = 'You\'re on <b>' + (myTeam === 'blue' ? 'Blue' : 'Red') + '</b>';
  }
  setTeam(myTeam);
  if (lobbyName) lobbyName.textContent = playerName;

  // ---------------- Host presence ----------------
  function setHostPresent(present) {
    if (hostAbsentOverlay) hostAbsentOverlay.hidden = !!present;
  }
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });

  // ---------------- Boot / reconnect ----------------
  socket.on('connect', function () {
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (!res || !res.ok) {
        localStorage.setItem('soccerhead.rejoinName', playerName);
        localStorage.removeItem('soccerhead.playerId');
        window.location.replace('/soccerhead/join');
        return;
      }
      setHostPresent(res.hostPresent !== false);
      if (res.player && res.player.team) setTeam(res.player.team);
      applyPhase(res);
    });
  });

  function applyPhase(res) {
    currentPhase = res.phase;
    if (res.phase === 'LOBBY') {
      applyLobby(res.lobby);
      showView('lobby');
    } else if (res.phase === 'PLAYING') {
      resumeMatch(res.match);
    } else if (res.phase === 'FINAL') {
      if (res.match) { setScores(res.match.redScore, res.match.blueScore); }
      renderFinal(res.match || {});
    }
  }

  function applyLobby(lobby) {
    if (!lobby) return;
    // Keep my team badge in sync if the host reassigned me in the lobby.
    const all = [].concat(
      (lobby.teams && lobby.teams.red || []).map(function (p) { return { id: p.id, team: 'red' }; }),
      (lobby.teams && lobby.teams.blue || []).map(function (p) { return { id: p.id, team: 'blue' }; })
    );
    const me = all.find(function (p) { return p.id === playerId; });
    if (me) setTeam(me.team);
  }
  socket.on('state:lobby', function (lobby) {
    if (currentPhase === 'LOBBY' || (lobby && lobby.phase === 'LOBBY')) {
      currentPhase = 'LOBBY';
      applyLobby(lobby);
      showView('lobby');
    }
  });
  socket.on('state:reset', function () {
    // Host reset — our session is gone; bounce back to join.
    localStorage.setItem('soccerhead.rejoinName', playerName);
    localStorage.removeItem('soccerhead.playerId');
    window.location.replace('/soccerhead/join');
  });
  socket.on('player:rejected', function (p) {
    if (p && p.reason === 'kicked') {
      kicked = true;
      localStorage.removeItem('soccerhead.playerId');
      releaseAll();
      showView('kicked');
    }
  });

  // ---------------- Match events ----------------
  socket.on('m:start', function (d) {
    currentPhase = 'PLAYING';
    if (d && d.roster) {
      const mine = d.roster.find(function (r) { return r.id === playerId; });
      if (mine) setTeam(mine.team);
    }
    if (pauseCover) pauseCover.hidden = true;
    setScores(0, 0);
    setClock((d && d.durationSec ? d.durationSec : 90) * 1000, false);
    showView('controller');
    setControls(false);
    showOverlay(null, 'Get ready…');
  });
  socket.on('m:countdown', function (d) {
    if (currentPhase !== 'PLAYING') { currentPhase = 'PLAYING'; showView('controller'); }
    hideEmotePanel();
    setControls(false);
    showOverlay(d && d.n != null ? String(d.n) : '', (d && d.note) ? d.note : 'Get ready…');
  });
  socket.on('m:play', function () {
    currentPhase = 'PLAYING';
    hideEmotePanel();
    hideOverlay();
    setControls(true);
  });
  socket.on('m:clock', function (d) { setClock(d && d.ms, !!(d && d.sudden)); });
  socket.on('m:goal', function (d) {
    setControls(false);
    if (d) setScores(d.red, d.blue);
    // No goal banner here — players see the score/celebration on the host
    // screen. Their screen switches to the reaction panel instead.
    showEmotePanel();
  });
  socket.on('m:sudden', function () {
    setClock(0, true);
    showFlash('SUDDEN DEATH', false);
  });
  socket.on('m:pause', function () {
    // Drop any held buttons and lock the pad, then cover it so no touch lands.
    setControls(false);
    if (pauseCover) pauseCover.hidden = false;
  });
  socket.on('m:resume', function (d) {
    if (pauseCover) pauseCover.hidden = true;
    // Re-enable input only if the ball was live when the host paused.
    setControls(!!(d && d.live));
  });
  socket.on('m:end', function (d) {
    currentPhase = 'FINAL';
    hideEmotePanel();
    setControls(false);
    renderFinal(d || {});
  });

  function resumeMatch(match) {
    currentPhase = 'PLAYING';
    showView('controller');
    if (match) {
      setScores(match.redScore, match.blueScore);
      setClock(match.clockMs, !!match.sudden);
    }
    if (pauseCover) pauseCover.hidden = !(match && match.paused);
    if (match && match.paused) { setControls(false); }
    else if (match && match.live) { hideOverlay(); setControls(true); }
    else { setControls(false); showOverlay(null, 'Get ready…'); }
  }

  // ---------------- HUD ----------------
  function setScores(r, b) {
    if (typeof r === 'number') scoreRed.textContent = r;
    if (typeof b === 'number') scoreBlue.textContent = b;
  }
  function setClock(ms, sudden) {
    if (typeof ms === 'number') {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const m = Math.floor(total / 60);
      const s = total % 60;
      hudClock.textContent = sudden ? 'SD' : (m + ':' + (s < 10 ? '0' : '') + s);
      hudClock.classList.toggle('urgent', !sudden && total <= 10);
    }
    hudClock.classList.toggle('sudden', !!sudden);
    if (sudden) hudClock.textContent = 'SD';
  }

  function showOverlay(count, text) {
    if (!ctrlOverlay) return;
    ctrlOverlay.hidden = false;
    if (count && count.length) {
      coCount.style.display = '';
      coCount.textContent = count;
      // Re-trigger the pop animation.
      coCount.style.animation = 'none';
      void coCount.offsetWidth;
      coCount.style.animation = '';
    } else {
      coCount.style.display = 'none';
    }
    coText.textContent = text || '';
  }
  function hideOverlay() { if (ctrlOverlay) ctrlOverlay.hidden = true; }

  let flashTimer = null;
  function showFlash(text, good) {
    if (!flash) return;
    flashText.textContent = text;
    flashText.style.color = good ? 'var(--good)' : 'var(--accent)';
    flash.hidden = false;
    flashText.style.animation = 'none';
    void flashText.offsetWidth;
    flashText.style.animation = '';
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flash.hidden = true; }, 1600);
  }

  // ---------------- Goal reaction panel ----------------
  // Shown during the goal celebration (controls are disabled anyway). Each
  // player may pick ONE emote per goal; after picking, the panel locks.
  let emoteUsed = false;
  const emoteBtns = {}; // emoji char -> button element
  (function buildEmotes() {
    if (!emoteGrid) return;
    EMOTES.forEach(function (e) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emote-btn';
      b.textContent = e;
      b.setAttribute('aria-label', 'React ' + e);
      b.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        pickEmote(e);
      });
      emoteBtns[e] = b;
      emoteGrid.appendChild(b);
    });
  })();
  // True only while the reaction panel is open and this player hasn't reacted.
  function emoteActive() {
    return !!(emotePanel && !emotePanel.hidden && !emoteUsed);
  }
  // Send one emote (touch or gamepad) and lock the panel. No-op if not allowed.
  function pickEmote(e) {
    if (!emoteActive() || EMOTES.indexOf(e) < 0) return;
    emoteUsed = true;
    socket.emit('emote', { e: e });
    const b = emoteBtns[e];
    if (b) b.classList.add('picked');
    if (emotePanel) emotePanel.classList.add('locked');
  }
  function showEmotePanel() {
    if (!emotePanel) return;
    emoteUsed = false;
    emotePanel.classList.remove('locked');
    const picked = emoteGrid ? emoteGrid.querySelectorAll('.picked') : [];
    for (let i = 0; i < picked.length; i++) picked[i].classList.remove('picked');
    emotePanel.hidden = false;
    if (pad) pad.style.display = 'none';
  }
  function hideEmotePanel() {
    if (emotePanel) emotePanel.hidden = true;
    if (pad) pad.style.display = '';
  }

  function renderFinal(d) {
    const r = d.red != null ? d.red : Number(scoreRed.textContent);
    const b = d.blue != null ? d.blue : Number(scoreBlue.textContent);
    finalScore.textContent = 'Red ' + r + ' – ' + b + ' Blue';
    const winner = d.winner;
    if (!winner) {
      finalEmoji.textContent = '🤝';
      finalTitle.textContent = 'Draw!';
    } else if (winner === myTeam) {
      finalEmoji.textContent = '🏆';
      finalTitle.textContent = 'You win!';
    } else {
      finalEmoji.textContent = '😤';
      finalTitle.textContent = 'You lost';
    }
    showView('final');
  }

  // ---------------- Controls (input) ----------------
  function send(code, down) { socket.emit('in', { c: code, d: down ? 1 : 0 }); }

  function press(code, btn) {
    btn.classList.add('pressed');
    // Always give visual feedback, but only transmit input once play is live.
    // Buttons held during the countdown are flushed the moment controls enable.
    if (!controlsEnabled) return;
    send(code, true);
    if (code === LEFT || code === RIGHT) maybeDash(code, btn);
  }
  function releaseCode(code, btn) {
    btn.classList.remove('pressed');
    send(code, false);
  }
  function releaseAll() {
    activePointers.forEach(function (code) {
      const btn = btns[code];
      if (btn) btn.classList.remove('pressed');
      send(code, false);
    });
    activePointers.clear();
  }
  function setControls(enabled) {
    if (!enabled && controlsEnabled) releaseAll();
    const wasEnabled = controlsEnabled;
    controlsEnabled = enabled;
    // Play just started: instantly send any direction the player is already
    // holding so there is zero delay off the countdown.
    if (enabled && !wasEnabled) {
      activePointers.forEach(function (code) { send(code, true); });
    }
    if (pad) pad.style.opacity = enabled ? '1' : '0.55';
  }

  Object.keys(btns).forEach(function (k) {
    const code = Number(k);
    const btn = btns[code];
    if (!btn) return;
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      // Track presses even during the countdown (controls not yet enabled) so a
      // held left/right is ready to fire the instant play begins.
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      activePointers.set(e.pointerId, code);
      press(code, btn);
    });
    function up(e) {
      if (!activePointers.has(e.pointerId)) return;
      const c = activePointers.get(e.pointerId);
      activePointers.delete(e.pointerId);
      releaseCode(c, btns[c]);
    }
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
  });

  // Dash: a fast double-tap of the same movement button.
  function maybeDash(code, btn) {
    const now = Date.now();
    const dir = code === LEFT ? -1 : 1;
    if (now - lastTap[code] <= DASH_TAP_MS) {
      lastTap[code] = 0;
      doDash(dir, btn);
    } else {
      lastTap[code] = now;
    }
  }
  function doDash(dir, btn) {
    const now = Date.now();
    if (now < dashCooldownUntil) return;
    socket.emit('dash', { dir: dir });
    dashCooldownUntil = now + DASH_COOLDOWN_MS;
    if (btn) { btn.classList.remove('dashed'); void btn.offsetWidth; btn.classList.add('dashed'); }
    startDashRing();
  }
  function startDashRing() {
    dashLeft.classList.add('charging');
    dashRight.classList.add('charging');
    if (dashRingTimer) clearInterval(dashRingTimer);
    dashRingTimer = setInterval(function () {
      const remain = dashCooldownUntil - Date.now();
      if (remain <= 0) {
        clearInterval(dashRingTimer); dashRingTimer = null;
        dashLeft.classList.remove('charging');
        dashRight.classList.remove('charging');
        return;
      }
      const deg = (remain / DASH_COOLDOWN_MS) * 360;
      dashLeft.style.setProperty('--pct', deg + 'deg');
      dashRight.style.setProperty('--pct', deg + 'deg');
    }, 60);
  }

  // Release everything if the tab is hidden (finger-lift never arrives).
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseAll();
  });
  window.addEventListener('blur', releaseAll);

  // ---------------- Bluetooth / USB gamepad support ----------------
  // A player can pair a controller to their phone and use it instead of (or
  // alongside) the touch pad. We read the standard Gamepad API and translate it
  // into the SAME send()/doDash() the touch buttons use — so no server/engine
  // changes are needed.
  const GP_DEADZONE = 0.35;

  // Pure: turn a gamepad snapshot into the set of intents we care about.
  // Move = left stick X (axis 0) or d-pad (14/15); A(0)=jump; B(1)=kick;
  // LB(4)=dash left; RB(5)=dash right. Reads raw buttons/axes so it also works
  // for pads the browser doesn't map to the "standard" layout.
  function mapGamepad(gp) {
    const out = { left: false, right: false, jump: false, kick: false, dashLeft: false, dashRight: false };
    if (!gp) return out;
    const b = gp.buttons || [];
    const a = gp.axes || [];
    const down = function (i) { const btn = b[i]; return !!(btn && (btn.pressed || btn.value > 0.5)); };
    const ax = a.length > 0 ? (a[0] || 0) : 0;
    if (ax < -GP_DEADZONE || down(14)) out.left = true;
    if (ax > GP_DEADZONE || down(15)) out.right = true;
    if (down(0)) out.jump = true;   // A / cross
    if (down(1)) out.kick = true;   // B / circle
    if (down(4)) out.dashLeft = true;   // LB
    if (down(5)) out.dashRight = true;  // RB
    return out;
  }

  let gpIndex = null;
  const gpHeld = { 0: false, 1: false, 2: false, 3: false };
  const gpDashLatch = { left: false, right: false };
  // D-pad reactions during the goal window: up=💪, down=🔥, left=😂, right=😡.
  const GP_EMOTE = { 12: '💪', 13: '🔥', 14: '😂', 15: '😡' };
  const gpDpadLatch = { 12: false, 13: false, 14: false, 15: false };

  function anyGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) if (pads[i]) return true;
    return false;
  }
  function activeGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (gpIndex != null && pads[gpIndex]) return pads[gpIndex];
    for (let i = 0; i < pads.length; i++) if (pads[i]) { gpIndex = i; return pads[i]; }
    return null;
  }
  function setGamepadBadge(on) {
    if (gamepadBadge) gamepadBadge.hidden = !on;
    body.classList.toggle('has-gamepad', !!on);
    updateRotateHint();
  }
  function releaseGamepadHeld() {
    [LEFT, RIGHT, JUMP, KICK].forEach(function (code) {
      if (gpHeld[code]) {
        gpHeld[code] = false;
        const btn = btns[code];
        if (btn) btn.classList.remove('pressed');
        send(code, false);
      }
    });
    gpDashLatch.left = gpDashLatch.right = false;
  }

  function pollGamepad() {
    requestAnimationFrame(pollGamepad);
    const gp = activeGamepad();
    if (!gp) return;
    const m = mapGamepad(gp);
    // Movement + jump/kick mirror the touch gating: only transmit while controls
    // are live, and flush a held direction the instant play begins.
    const target = { 0: m.left, 1: m.right, 2: m.jump, 3: m.kick };
    [LEFT, RIGHT, JUMP, KICK].forEach(function (code) {
      const want = controlsEnabled ? target[code] : false;
      if (want !== gpHeld[code]) {
        gpHeld[code] = want;
        const btn = btns[code];
        if (btn) btn.classList.toggle('pressed', want);
        send(code, want);
      }
    });
    // Dash on a fresh bumper press (doDash enforces the cooldown itself).
    if (controlsEnabled) {
      if (m.dashLeft && !gpDashLatch.left) doDash(-1);
      if (m.dashRight && !gpDashLatch.right) doDash(1);
    }
    gpDashLatch.left = m.dashLeft;
    gpDashLatch.right = m.dashRight;
    // D-pad reactions — only while the goal reaction panel is open. The same
    // buttons drive movement during play, but controls are disabled then.
    const b = gp.buttons || [];
    Object.keys(GP_EMOTE).forEach(function (k) {
      const idx = Number(k);
      const btn = b[idx];
      const pressed = !!(btn && (btn.pressed || btn.value > 0.5));
      if (pressed && !gpDpadLatch[idx] && emoteActive()) pickEmote(GP_EMOTE[idx]);
      gpDpadLatch[idx] = pressed;
    });
  }

  window.addEventListener('gamepadconnected', function (e) {
    gpIndex = e.gamepad.index;
    setGamepadBadge(true);
  });
  window.addEventListener('gamepaddisconnected', function (e) {
    if (gpIndex === e.gamepad.index) { releaseGamepadHeld(); gpIndex = null; }
    setGamepadBadge(anyGamepad());
  });
  // A controller already paired before load won't fire 'gamepadconnected' until
  // the first input, so reflect current state on boot too.
  if (anyGamepad()) setGamepadBadge(true);
  pollGamepad();

  // ---------------- Lock zoom ----------------
  // iOS Safari ignores `user-scalable=no`, so pinch- and double-tap-zoom still
  // work and would drift the controller off-screen. Suppress them explicitly so
  // the gamepad stays rock-steady while players hammer the buttons.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (evt) {
    document.addEventListener(evt, function (e) { e.preventDefault(); }, { passive: false });
  });
  let lastTouchEnd = 0;
  document.addEventListener('touchend', function (e) {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault(); // double-tap zoom
    lastTouchEnd = now;
  }, { passive: false });
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault(); // pinch zoom
  }, { passive: false });

  // ---------------- Rotate hint ----------------
  const portraitMq = window.matchMedia('(orientation: portrait)');
  function updateRotateHint() {
    const inController = body.classList.contains('playing');
    const usingGamepad = body.classList.contains('has-gamepad');
    if (rotateHint) rotateHint.hidden = !(inController && portraitMq.matches && !usingGamepad);
  }
  if (portraitMq.addEventListener) portraitMq.addEventListener('change', updateRotateHint);
  else if (portraitMq.addListener) portraitMq.addListener(updateRotateHint);
  window.addEventListener('resize', updateRotateHint);

  // ---------------- Kicked → rejoin ----------------
  if (kickRejoinBtn) {
    kickRejoinBtn.addEventListener('click', function () {
      localStorage.setItem('soccerhead.rejoinName', playerName);
      window.location.replace('/soccerhead/join');
    });
  }
})();
