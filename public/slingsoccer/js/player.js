(function () {
  'use strict';

  const playerId = localStorage.getItem('slingsoccer.playerId');
  const playerName = localStorage.getItem('slingsoccer.playerName') || 'Player';
  if (!playerId) { window.location.replace('/slingsoccer/join'); return; }

  const socket = io('/slingsoccer', { transports: ['polling', 'websocket'] });

  const DEADZONE = 0.18;       // large dead-centre zone: easy to return to zero / cancel
  const MOVE_THROTTLE_MS = 40;

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
  const hudTarget = document.getElementById('hudTarget');
  const hudTurn = document.getElementById('hudTurn');
  const tokenRow = document.getElementById('tokenRow');
  const tokBtns = Array.prototype.slice.call(tokenRow.querySelectorAll('.tok-btn'));
  const slingPad = document.getElementById('slingPad');
  const slingKnob = document.getElementById('slingKnob');
  const slingBand = document.getElementById('slingBand');
  const slingHint = document.getElementById('slingHint');
  const waitCover = document.getElementById('waitCover');
  const waitText = document.getElementById('waitText');
  const flash = document.getElementById('flash');
  const flashText = document.getElementById('flashText');
  const finalEmoji = document.getElementById('finalEmoji');
  const finalTitle = document.getElementById('finalTitle');
  const finalScore = document.getElementById('finalScore');
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');

  // ---------------- State ----------------
  let myTeam = 'red';
  let currentPhase = 'LOBBY';
  let myTurn = false;
  let selectedToken = null;
  let aiming = false;
  let padCx = 0, padCy = 0, padR = 1;
  let aimPointerId = null;
  let lastMoveAt = 0;
  let lastPower = 0;
  let kicked = false;

  function showView(name) {
    if (kicked && name !== 'kicked') return;
    Object.keys(views).forEach(function (k) {
      if (views[k]) views[k].style.display = (k === name) ? '' : 'none';
    });
    body.classList.toggle('playing', name === 'controller');
    // Credit belongs on the lobby wait only — never mid-match or on the final.
    if (playerAttribution) playerAttribution.hidden = (name !== 'lobby');
  }

  function setTeam(team) {
    myTeam = team === 'blue' ? 'blue' : 'red';
    body.setAttribute('data-team', myTeam);
    if (lobbyTeamBadge) lobbyTeamBadge.textContent = myTeam.toUpperCase();
    // Top-right HUD badge always shows the player's own team, in its colour.
    if (hudTurn) hudTurn.textContent = 'Team ' + (myTeam === 'blue' ? 'Blue' : 'Red');
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
        localStorage.setItem('slingsoccer.rejoinName', playerName);
        localStorage.removeItem('slingsoccer.playerId');
        window.location.replace('/slingsoccer/join');
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
      if (res.match) setScores(res.match.redScore, res.match.blueScore);
      renderFinal(res.match || {});
    }
  }

  function applyLobby(lobby) {
    if (!lobby) return;
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
    localStorage.setItem('slingsoccer.rejoinName', playerName);
    localStorage.removeItem('slingsoccer.playerId');
    window.location.replace('/slingsoccer/join');
  });
  socket.on('player:rejected', function (p) {
    if (p && p.reason === 'kicked') {
      kicked = true;
      localStorage.removeItem('slingsoccer.playerId');
      cancelAim(true);
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
    setScores(0, 0);
    if (d && d.goalTarget) hudTarget.textContent = 'First to ' + d.goalTarget;
    showView('controller');
    setMyTurn(false, null, null);
    if (waitText) waitText.textContent = 'Get ready…';
    if (waitCover) waitCover.hidden = false;
  });
  socket.on('m:countdown', function (d) {
    currentPhase = 'PLAYING';
    if (views.controller.style.display === 'none') showView('controller');
    // Lock the controller during the kickoff count.
    myTurn = false;
    cancelAim(true);
    selectedToken = null;
    tokBtns.forEach(function (b) { b.classList.remove('selected'); b.disabled = true; });
    resetSling();
    hideFlash();
    if (waitCover) waitCover.hidden = false;
    const n = d && d.n;
    if (waitCover) waitCover.classList.remove('goal-hide');
    if (waitText) waitText.textContent = 'Kickoff in ' + (n || 3) + '…';
  });
  socket.on('m:turn', function (d) {
    if (!d) return;
    currentPhase = 'PLAYING';
    if (views.controller.style.display === 'none') showView('controller');
    setScores(d.red, d.blue);
    if (d.goalTarget) hudTarget.textContent = 'First to ' + d.goalTarget;
    hideFlash();
    setMyTurn(d.playerId === playerId, d.team, d.playerName);
  });
  socket.on('m:goal', function (d) {
    if (d) setScores(d.red, d.blue);
    setMyTurn(false, null, null);
    // Whose goal? d.team scored. Both cases use the animated flash overlay.
    const mineScored = d && d.team === myTeam;
    showFlash(mineScored ? 'GOAL!' : 'Opponent scored!', mineScored);
    if (waitCover) { waitCover.hidden = false; waitCover.classList.add('goal-hide'); }
  });
  socket.on('m:end', function (d) {
    currentPhase = 'FINAL';
    setMyTurn(false, null, null);
    renderFinal(d || {});
  });

  function resumeMatch(match) {
    currentPhase = 'PLAYING';
    showView('controller');
    if (match) {
      setScores(match.redScore, match.blueScore);
      if (match.goalTarget) hudTarget.textContent = 'First to ' + match.goalTarget;
      setMyTurn(match.currentPlayerId === playerId, match.currentTeam, match.currentPlayerName);
    } else {
      setMyTurn(false, null, null);
    }
  }

  // ---------------- Turn / controls ----------------
  function setMyTurn(isMine, team, name) {
    myTurn = !!isMine;
    cancelAim(true);
    selectedToken = null;
    tokBtns.forEach(function (b) { b.classList.remove('selected'); b.disabled = !myTurn; });
    resetSling();
    if (waitCover) waitCover.classList.remove('goal-hide');
    if (myTurn) {
      if (waitCover) waitCover.hidden = true;
      slingHint.textContent = 'Tap a token, then pull back to aim';
      slingPad.classList.remove('armed');
    } else {
      if (waitCover) waitCover.hidden = false;
      if (team) {
        const teamLabel = team === 'blue' ? 'Blue' : 'Red';
        const nameCol = team === 'blue' ? 'var(--blue-soft)' : 'var(--red-soft)';
        if (waitText) {
          waitText.textContent = '';
          const nameEl = name ? document.createElement('span') : null;
          if (nameEl) { nameEl.textContent = name; nameEl.style.color = nameCol; nameEl.style.fontWeight = '800'; }
          if (team === myTeam) {
            waitText.appendChild(document.createTextNode('Teammate '));
            if (nameEl) { waitText.appendChild(nameEl); waitText.appendChild(document.createTextNode(' ')); }
            waitText.appendChild(document.createTextNode('is shooting'));
          } else {
            waitText.appendChild(document.createTextNode(teamLabel + ' is shooting'));
            if (nameEl) { waitText.appendChild(document.createTextNode(' \u2014 ')); waitText.appendChild(nameEl); }
          }
        }
      } else if (waitText) {
        waitText.textContent = 'Waiting\u2026';
      }
    }
  }

  // Token pick.
  tokBtns.forEach(function (b) {
    b.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (!myTurn) return;
      const idx = Number(b.dataset.token);
      selectedToken = idx;
      tokBtns.forEach(function (o) { o.classList.toggle('selected', o === b); });
      socket.emit('aim:select', { token: idx });
      resetSling();
      slingPad.classList.add('armed');
      slingHint.textContent = 'Pull back & release to flick';
    });
  });

  // ---------------- Slingshot pad ----------------
  function measurePad() {
    const r = slingPad.getBoundingClientRect();
    padCx = r.left + r.width / 2;
    padCy = r.top + r.height / 2;
    padR = Math.max(30, Math.min(r.width, r.height) / 2 - 26);
  }

  function padDown(e) {
    if (!myTurn || selectedToken == null) {
      if (myTurn && selectedToken == null) pulseHint();
      return;
    }
    e.preventDefault();
    measurePad();
    aiming = true;
    aimPointerId = e.pointerId;
    try { slingPad.setPointerCapture(e.pointerId); } catch (_) {}
    updateAim(e.clientX, e.clientY, true);
  }
  function padMove(e) {
    if (!aiming || e.pointerId !== aimPointerId) return;
    e.preventDefault();
    updateAim(e.clientX, e.clientY, false);
  }
  function padUp(e) {
    if (!aiming || e.pointerId !== aimPointerId) return;
    e.preventDefault();
    aiming = false;
    aimPointerId = null;
    if (lastPower >= DEADZONE) {
      const v = currentVec(e.clientX, e.clientY);
      socket.emit('aim:shoot', { dx: v.dx, dy: v.dy });
      // Shot committed — lock until the next turn broadcast.
      myTurn = false;
      tokBtns.forEach(function (b) { b.disabled = true; });
      resetSling();
      if (waitCover) waitCover.hidden = false;
      if (waitText) waitText.textContent = 'Shot away! 🎯';
    } else {
      socket.emit('aim:cancel', {});
      resetSling();
      slingHint.textContent = 'Pull back & release to flick';
    }
  }

  // Raw offset -> pull vector. Returns the knob px offset (cdx,cdy), the RAW
  // pull fraction (0..1) and the EFFECTIVE emit vector after the dead-centre
  // zone is remapped to 0 — so a big central area reads as no power (and full
  // power is still reachable at the edge), making it easy to return to zero.
  function currentVec(clientX, clientY) {
    let dx = clientX - padCx, dy = clientY - padCy;
    let dist = Math.hypot(dx, dy);
    if (dist > padR) { dx = dx / dist * padR; dy = dy / dist * padR; dist = padR; }
    const raw = dist / padR;
    const eff = raw <= DEADZONE ? 0 : (raw - DEADZONE) / (1 - DEADZONE);
    const k = raw > 0 ? eff / raw : 0;   // scale unit*raw -> unit*eff
    return { cdx: dx, cdy: dy, raw: raw, eff: eff, dx: (dx / padR) * k, dy: (dy / padR) * k };
  }
  function updateAim(clientX, clientY, immediate) {
    const v = currentVec(clientX, clientY);
    lastPower = v.raw;
    // Move the knob (follows the finger) + band (reflects effective power).
    slingKnob.style.transform = 'translate(-50%,-50%) translate(' + v.cdx + 'px,' + v.cdy + 'px)';
    slingKnob.classList.add('active');
    const ang = Math.atan2(v.cdy, v.cdx) * 180 / Math.PI;
    const len = Math.hypot(v.cdx, v.cdy);
    slingBand.style.width = len + 'px';
    slingBand.style.transform = 'translateY(-50%) rotate(' + ang + 'deg)';
    slingBand.style.opacity = v.eff > 0 ? '1' : '0';
    // Throttled relay (the pull vector; host launches the opposite way).
    const now = Date.now();
    if (immediate || now - lastMoveAt >= MOVE_THROTTLE_MS) {
      lastMoveAt = now;
      socket.emit('aim:move', { dx: v.dx, dy: v.dy });
    }
  }
  function resetSling() {
    lastPower = 0;
    slingKnob.style.transform = 'translate(-50%,-50%)';
    slingKnob.classList.remove('active');
    slingBand.style.width = '0px';
    slingBand.style.opacity = '0';
  }
  function cancelAim(silent) {
    if (aiming) {
      aiming = false;
      if (aimPointerId != null) { try { slingPad.releasePointerCapture(aimPointerId); } catch (_) {} }
      aimPointerId = null;
      if (!silent) socket.emit('aim:cancel', {});
    }
  }
  function pulseHint() {
    slingHint.classList.remove('pulse');
    void slingHint.offsetWidth;
    slingHint.classList.add('pulse');
  }

  slingPad.addEventListener('pointerdown', padDown);
  slingPad.addEventListener('pointermove', padMove);
  slingPad.addEventListener('pointerup', padUp);
  slingPad.addEventListener('pointercancel', padUp);
  window.addEventListener('resize', measurePad);

  // ---------------- HUD ----------------
  function setScores(r, b) {
    if (typeof r === 'number') scoreRed.textContent = r;
    if (typeof b === 'number') scoreBlue.textContent = b;
  }

  let flashTimer = null;
  function showFlash(text, good) {
    if (!flash) return;
    flashText.textContent = text;
    flashText.style.color = good ? 'var(--good)' : '#ffd0d0';
    flash.hidden = false;
    flashText.style.animation = 'none';
    void flashText.offsetWidth;
    flashText.style.animation = '';
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flash.hidden = true; }, 1600);
  }
  function hideFlash() { if (flash) flash.hidden = true; }

  function renderFinal(d) {
    const r = d.red != null ? d.red : Number(scoreRed.textContent);
    const b = d.blue != null ? d.blue : Number(scoreBlue.textContent);
    finalScore.innerHTML = '<span style="color:var(--red-soft)">Red</span> ' + r + ' \u2013 ' + b + ' <span style="color:var(--blue-soft)">Blue</span>';
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

  // ---------------- Kicked rejoin ----------------
  kickRejoinBtn && kickRejoinBtn.addEventListener('click', function () {
    localStorage.setItem('slingsoccer.rejoinName', playerName);
    window.location.replace('/slingsoccer/join');
  });

  // Cancel aim if the tab is hidden (finger-lift may never arrive).
  document.addEventListener('visibilitychange', function () { if (document.hidden) { cancelAim(false); resetSling(); } });
  window.addEventListener('blur', function () { cancelAim(false); resetSling(); });

  // ---------------- Lock zoom (iOS ignores user-scalable) ----------------
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (evt) {
    document.addEventListener(evt, function (e) { e.preventDefault(); }, { passive: false });
  });
  let lastTouchEnd = 0;
  document.addEventListener('touchend', function (e) {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
})();
