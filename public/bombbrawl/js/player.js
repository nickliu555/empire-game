(function () {
  'use strict';

  // ============================================================
  // Bomb Brawl — phone controller.
  //
  // The phone is a dumb input device: it streams a normalised thumbstick
  // vector (`in`) and discrete bomb presses (`bomb`) to the host, and mirrors
  // whatever match state the host broadcasts. All simulation lives on the host.
  // ============================================================

  const PID = localStorage.getItem('bombbrawl.playerId');
  if (!PID) { window.location.replace('/bombbrawl/join'); return; }

  // ---------------- Kill all zoom / gesture behaviour ----------------
  // This is a fixed fullscreen gamepad — it must NEVER zoom or pan. iOS Safari
  // ignores maximum-scale/user-scalable, and driving the stick and the bomb
  // button together is a two-finger gesture the browser would read as a pinch,
  // so block it explicitly:
  //   • pinch (iOS gesture events + any multi-touch move)
  //   • double-tap-to-zoom
  (function lockZoom() {
    const stop = function (e) { e.preventDefault(); };
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('gestureend', stop, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
    let lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      const now = Date.now();
      if (now - lastTouchEnd <= 350) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
  }());

  const FALLBACK_COLORS = ['#FF4D4D', '#3DA5FF', '#3DDC84', '#FFD23F'];

  // ---------- DOM ----------
  const el = function (id) { return document.getElementById(id); };
  const seatEl = el('pSeat');
  const nameEl = el('pName');
  const scoreEl = el('pScore');
  const waitTitle = el('waitTitle');
  const waitSub = el('waitSub');
  const powerRow = el('powerRow');
  const stickZone = el('stickZone');
  const stickBase = el('stickBase');
  const stickKnob = el('stickKnob');
  const bombBtn = el('bombBtn');
  const bombBadge = el('bombBadge');
  const countOverlay = el('countOverlay');
  const pcNote = el('pcNote');
  const pcNum = el('pcNum');
  const pausedOverlay = el('pausedOverlay');
  const finalEmoji = el('finalEmoji');
  const finalTitle = el('finalTitle');
  const finalList = el('finalList');
  const rotateHint = el('rotateHint');
  const gamepadBadge = el('gamepadBadge');
  const playerAttribution = el('playerAttribution');

  const VIEWS = ['wait', 'play', 'out', 'final'];
  let currentView = 'wait';
  function showView(name) {
    currentView = name;
    for (let i = 0; i < VIEWS.length; i++) {
      const v = el('view-' + VIEWS[i]);
      if (v) v.classList.toggle('active', VIEWS[i] === name);
    }
    // Credit only belongs on the pre-game lobby wait. The 'wait' view is reused
    // for the countdown, between-round recaps and the kick notice, so hide it by
    // default here and let enterWaiting() turn it back on.
    if (playerAttribution) playerAttribution.hidden = true;
    // Releasing the stick whenever the controller leaves the screen prevents a
    // "stuck walking" bomber if a round ends mid-drag.
    if (name !== 'play') releaseStick(true);
    updateRotateHint();
  }

  // The pad is built for landscape, so nag (and block input) while the phone is
  // held upright with the controller live.
  const portraitMq = window.matchMedia('(orientation: portrait)');
  function updateRotateHint() {
    const usingGamepad = document.body.classList.contains('has-gamepad');
    if (rotateHint) rotateHint.hidden = !(currentView === 'play' && portraitMq.matches && !usingGamepad);
  }
  if (portraitMq.addEventListener) portraitMq.addEventListener('change', updateRotateHint);
  else if (portraitMq.addListener) portraitMq.addListener(updateRotateHint);
  window.addEventListener('resize', updateRotateHint);

  // ---------- Local state ----------
  let me = null;                 // roster entry for this phone
  let roster = [];
  let gamePoints = {};
  let roundsToWin = 3;
  let alive = true;
  let paused = false;
  let live = false;
  let hud = { bombs: 1, fire: 1, speed: 0, kick: false, out: 0 };

  function vibrate(pattern) {
    if (!('vibrate' in navigator)) return;
    try { navigator.vibrate(pattern); } catch (e) { /* some browsers throw when backgrounded */ }
  }

  function colorOf(id) {
    for (let i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i].color;
    return '#ffffff';
  }
  function nameOf(id) {
    for (let i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i].name;
    return 'Player';
  }

  function applyIdentity() {
    if (!me) return;
    const seat = typeof me.seat === 'number' ? me.seat : 0;
    const color = me.color || FALLBACK_COLORS[seat % 4];
    document.body.style.setProperty('--pc', color);
    seatEl.textContent = String(seat + 1);
    nameEl.textContent = me.name || 'Player';
    updateScore();
  }

  /** Rounds won, mirrored from the host's score cards: one pip per round needed,
   *  lit up to the number already won — same read as the host strip. */
  function updateScore() {
    if (!scoreEl) return;
    if (!me) { scoreEl.innerHTML = ''; return; }
    const want = Math.max(1, roundsToWin);
    const have = gamePoints[PID] || 0;
    if (scoreEl.children.length !== want) {
      scoreEl.innerHTML = '';
      for (let i = 0; i < want; i++) {
        const d = document.createElement('span');
        d.className = 'pip';
        scoreEl.appendChild(d);
      }
    }
    for (let i = 0; i < scoreEl.children.length; i++) {
      scoreEl.children[i].classList.toggle('on', i < have);
    }
    scoreEl.setAttribute('aria-label', have + ' of ' + want + ' rounds won');
  }

  function setRoster(list) {
    roster = Array.isArray(list) ? list : [];
    for (let i = 0; i < roster.length; i++) {
      if (roster[i].id === PID) { me = roster[i]; break; }
    }
    applyIdentity();
  }

  // ============================================================
  // Power-up chips
  // ============================================================
  const chips = {};
  (function indexChips() {
    const list = powerRow.querySelectorAll('.pw');
    for (let i = 0; i < list.length; i++) chips[list[i].getAttribute('data-pw')] = list[i];
  })();

  function bump(chip) {
    if (!chip) return;
    chip.classList.remove('bump');
    // Force a reflow so the animation restarts on repeat pickups.
    void chip.offsetWidth;
    chip.classList.add('bump');
  }

  function setHud(next, animate) {
    const prev = hud;
    hud = {
      bombs: typeof next.bombs === 'number' ? next.bombs : prev.bombs,
      fire: typeof next.fire === 'number' ? next.fire : prev.fire,
      speed: typeof next.speed === 'number' ? next.speed : prev.speed,
      kick: typeof next.kick === 'boolean' ? next.kick : prev.kick,
      out: typeof next.out === 'number' ? next.out : prev.out,
    };
    chips.bombs.textContent = '💣 ' + hud.bombs;
    chips.fire.textContent = '🔥 ' + hud.fire;
    chips.speed.textContent = '👟 ' + hud.speed;
    chips.speed.classList.toggle('off', hud.speed <= 0);
    chips.kick.classList.toggle('off', !hud.kick);
    updateBombBtn();
    if (animate) {
      let gained = false;
      if (hud.bombs > prev.bombs) { bump(chips.bombs); gained = true; }
      if (hud.fire > prev.fire) { bump(chips.fire); gained = true; }
      if (hud.speed > prev.speed) { bump(chips.speed); gained = true; }
      if (hud.kick && !prev.kick) { bump(chips.kick); gained = true; }
      if (gained) vibrate(30);
    }
  }

  function remainingBombs() {
    return Math.max(0, hud.bombs - hud.out);
  }
  function updateBombBtn() {
    const left = remainingBombs();
    bombBadge.textContent = String(left);
    const usable = left > 0 && alive && live && !paused;
    bombBtn.classList.toggle('empty', left <= 0);
    bombBtn.disabled = !usable;
  }

  // ============================================================
  // Networking
  // ============================================================
  const socket = io('/bombbrawl', { transports: ['polling', 'websocket'] });

  function bailToJoin(keepName) {
    if (keepName) {
      const n = localStorage.getItem('bombbrawl.playerName');
      if (n) localStorage.setItem('bombbrawl.rejoinName', n);
    }
    localStorage.removeItem('bombbrawl.playerId');
    localStorage.removeItem('bombbrawl.playerName');
    window.location.replace('/bombbrawl/join');
  }

  socket.on('connect', function () {
    socket.emit('player:reconnect', { playerId: PID }, function (res) {
      if (!res || !res.ok) return bailToJoin(true);
      if (res.player && res.player.name) localStorage.setItem('bombbrawl.playerName', res.player.name);
      if (res.lobby) applyLobby(res.lobby);
      if (res.match) applyMatchSnapshot(res.match);
      else if (res.phase === 'LOBBY') enterWaiting();
    });
  });

  socket.on('player:rejected', function (p) {
    if (p && p.reason === 'kicked') {
      waitTitle.textContent = 'Removed from the game';
      waitSub.innerHTML = 'The host removed you. Sending you back…';
      showView('wait');
      setTimeout(function () { bailToJoin(true); }, 1400);
    }
  });

  socket.on('state:reset', function () {
    // A reset wipes the whole roster server-side, so this phone is no longer in
    // the game — send it back to join instead of leaving a stale "You're in!".
    bailToJoin(true);
  });

  socket.on('state:lobby', function (l) { applyLobby(l); });

  function applyLobby(l) {
    if (!l) return;
    if (l.players) setRoster(l.players);
    if (typeof l.roundsToWin === 'number') roundsToWin = l.roundsToWin;
    updateScore();
    if (l.phase === 'LOBBY' && currentView !== 'wait') enterWaiting();
  }

  function enterWaiting() {
    waitTitle.textContent = "You're in!";
    waitSub.innerHTML = '<span class="pulse-dot"></span>Waiting for the host to start…';
    showView('wait');
    if (playerAttribution) playerAttribution.hidden = false;
  }

  // ---- Match lifecycle ----
  socket.on('m:start', function (p) {
    if (p && p.roster) setRoster(p.roster);
    if (p && typeof p.roundsToWin === 'number') roundsToWin = p.roundsToWin;
    gamePoints = {};
    waitTitle.textContent = 'Get ready!';
    waitSub.innerHTML = '<span class="pulse-dot"></span>The first round is starting…';
    updateScore();
    showView('wait');
  });

  socket.on('m:roundStart', function (p) {
    alive = true;
    live = false;
    paused = false;
    if (p && typeof p.roundsToWin === 'number') roundsToWin = p.roundsToWin;
    const mine = p && p.hud && p.hud[PID];
    setHud(mine || { bombs: 1, fire: 1, speed: 0, kick: false, out: 0 }, false);
    updateScore();
    pausedOverlay.hidden = true;
    pcNote.textContent = 'Round ' + ((p && p.round) || 1);
    pcNum.textContent = '…';
    countOverlay.hidden = false;
    showView('play');
  });

  socket.on('m:countdown', function (p) {
    if (!alive) return;
    countOverlay.hidden = false;
    pcNote.textContent = (p && p.note) || 'Get ready';
    const n = p && p.n;
    pcNum.textContent = (n === 0 || n === 'GO') ? 'GO!' : String(n);
    // Restart the pop animation on every tick.
    pcNum.style.animation = 'none';
    void pcNum.offsetWidth;
    pcNum.style.animation = '';
    vibrate(10);
  });

  socket.on('m:play', function () {
    live = true;
    paused = false;
    countOverlay.hidden = true;
    pausedOverlay.hidden = true;
    updateBombBtn();
    resendStick();
  });

  socket.on('m:pause', function () {
    paused = true;
    pausedOverlay.hidden = false;
    updateBombBtn();
  });

  socket.on('m:resume', function (p) {
    paused = false;
    live = !!(p && p.live);
    pausedOverlay.hidden = true;
    updateBombBtn();
    resendStick();
  });

  socket.on('m:hud', function (p) {
    if (!p || p.id !== PID) return;
    setHud(p, true);
  });

  socket.on('m:eliminated', function (p) {
    if (!p || p.id !== PID) return;
    alive = false;
    live = false;
    releaseStick(true);
    updateBombBtn();
    vibrate([40, 60, 40]);
    showView('out');
  });

  socket.on('m:roundEnd', function (p) {
    live = false;
    paused = false;
    if (!p) return;
    gamePoints = p.gamePoints || gamePoints;
    if (typeof p.roundsToWin === 'number') roundsToWin = p.roundsToWin;
    updateScore();
    const won = p.winnerId === PID;
    if (won) vibrate([20, 50, 20, 50, 60]);
    waitTitle.textContent = won ? 'You won the round! 🎉' : nameOf(p.winnerId) + ' won the round';
    waitSub.innerHTML = '<span class="pulse-dot"></span>Next round coming up…';
    showView('wait');
  });

  socket.on('m:end', function (p) {
    live = false;
    releaseStick(true);
    if (!p) return;
    gamePoints = p.gamePoints || gamePoints;
    const winners = p.winnerIds || [];
    const iWon = winners.indexOf(PID) !== -1;
    updateScore();
    finalEmoji.textContent = iWon ? '🏆' : '💥';
    finalTitle.textContent = iWon
      ? (winners.length > 1 ? 'You tied for the win!' : 'You win!')
      : (winners.length ? winners.map(nameOf).join(' & ') + ' wins!' : 'Game over');
    renderStandings(finalList, winners);
    showView('final');
  });

  /** Standings list — final view only; a dead player just waits it out. */
  function renderStandings(target, winners) {
    if (!target) return;
    const list = roster.slice().sort(function (a, b) {
      return (gamePoints[b.id] || 0) - (gamePoints[a.id] || 0) || a.seat - b.seat;
    });
    target.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const row = document.createElement('div');
      row.className = 'out-row' + (r.id === PID ? ' me' : '') +
        (winners && winners.indexOf(r.id) !== -1 ? ' win' : '');
      const dot = document.createElement('span');
      dot.className = 'out-dot';
      dot.style.background = r.color || colorOf(r.id);
      const nm = document.createElement('span');
      nm.className = 'out-name';
      nm.textContent = r.name + (r.isBot ? ' 🤖' : '');
      const gp = document.createElement('span');
      gp.className = 'out-gp';
      gp.textContent = (gamePoints[r.id] || 0) + '/' + roundsToWin;
      row.appendChild(dot);
      row.appendChild(nm);
      row.appendChild(gp);
      target.appendChild(row);
    }
  }

  /** Rebuild the controller from a mid-match reconnect snapshot. */
  function applyMatchSnapshot(m) {
    setRoster(m.roster || []);
    gamePoints = m.gamePoints || {};
    roundsToWin = typeof m.roundsToWin === 'number' ? m.roundsToWin : roundsToWin;
    paused = !!m.paused;
    live = !!m.live;
    alive = !(m.alive && m.alive[PID] === false);
    setHud((m.hud && m.hud[PID]) || { bombs: 1, fire: 1, speed: 0, kick: false, out: 0 }, false);
    updateScore();

    if (m.winnerIds && m.winnerIds.length) {
      const iWon = m.winnerIds.indexOf(PID) !== -1;
      finalEmoji.textContent = iWon ? '🏆' : '💥';
      finalTitle.textContent = iWon ? 'You win!' : m.winnerIds.map(nameOf).join(' & ') + ' wins!';
      renderStandings(finalList, m.winnerIds);
      return showView('final');
    }
    if (!alive) {
      return showView('out');
    }
    countOverlay.hidden = live;
    pausedOverlay.hidden = !paused;
    if (!live) { pcNote.textContent = 'Round ' + (m.round || 1); pcNum.textContent = '…'; }
    updateBombBtn();
    showView('play');
  }

  // ============================================================
  // Thumbstick
  // ============================================================
  const DEADZONE = 0.18;
  const SEND_MS = 50;           // ~20 Hz upstream
  let stickId = null;           // active pointer id
  const zonePointers = new Map(); // every finger currently down in the stick zone
  let originX = 0, originY = 0; // where the finger first landed
  let radius = 70;              // px travel before the stick is fully deflected
  let vx = 0, vy = 0;           // current normalised vector
  let sentX = 0, sentY = 0;
  let lastSend = 0;
  let sendTimer = null;

  function canControl() {
    return alive && live && !paused && currentView === 'play';
  }

  /**
   * Steering opens a little earlier than control: the stick can be grabbed
   * during the countdown, so a thumb that is already pushing a direction is
   * moving the instant the round goes live instead of having to lift and press
   * again. The host throws the early input away and resendStick() replays it.
   */
  function canSteer() {
    return alive && currentView === 'play';
  }

  function measureRadius() {
    const r = stickBase.getBoundingClientRect();
    if (r.width) radius = r.width * 0.42;
  }
  window.addEventListener('resize', measureRadius);
  window.addEventListener('orientationchange', measureRadius);
  measureRadius();

  function setKnob(px, py) {
    stickKnob.style.transform = 'translate(-50%, -50%) translate(' + px + 'px, ' + py + 'px)';
  }

  /** Emit at most every SEND_MS, but never drop the final resting value. */
  function queueSend() {
    const now = Date.now();
    const dx = Math.abs(vx - sentX);
    const dy = Math.abs(vy - sentY);
    const resting = vx === 0 && vy === 0;
    if (!resting && dx < 0.03 && dy < 0.03) return;
    const wait = SEND_MS - (now - lastSend);
    if (wait > 0) {
      if (sendTimer) return;
      sendTimer = setTimeout(function () { sendTimer = null; flushSend(); }, wait);
      return;
    }
    flushSend();
  }
  function flushSend() {
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    if (vx === sentX && vy === sentY) return;
    sentX = vx; sentY = vy;
    lastSend = Date.now();
    socket.emit('in', { x: Math.round(vx * 100) / 100, y: Math.round(vy * 100) / 100 });
  }

  /**
   * Send the stick's current value again, ignoring the de-duplication. The host
   * drops any input that arrives before the round is live or while it is
   * paused, so a thumb that is holding a direction and never moves again would
   * otherwise sit there doing nothing once play resumes.
   */
  function resendStick() {
    sentX = NaN; sentY = NaN;
    lastSend = 0;
    flushSend();
  }

  function updateVector(clientX, clientY) {
    let dx = clientX - originX;
    let dy = clientY - originY;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) { dx = (dx / dist) * radius; dy = (dy / dist) * radius; }
    setKnob(dx, dy);
    const nx = dx / radius;
    const ny = dy / radius;
    const mag = Math.hypot(nx, ny);
    if (mag < DEADZONE) { vx = 0; vy = 0; } else { vx = nx; vy = ny; }
    queueSend();
  }

  /** Drive the stick from an already-normalised vector (used by the gamepad). */
  function applyVector(nx, ny) {
    const mag = Math.hypot(nx, ny);
    if (mag > 1) { nx /= mag; ny /= mag; }
    if (mag < DEADZONE) { vx = 0; vy = 0; } else { vx = nx; vy = ny; }
    setKnob(vx * radius, vy * radius);
    queueSend();
  }

  /**
   * Anchor the stick to a pointer at (x, y): the visible base jumps under the
   * finger and the origin is pinned to it. Used both for a fresh grab and when
   * control is handed to another finger that is still down.
   */
  function anchorStick(id, x, y) {
    stickId = id;
    // Recentre the visible base under the finger so the stick always starts
    // exactly where the thumb landed. The base is kept inside its half of the
    // pad, but the ORIGIN stays on the finger — otherwise planting a thumb near
    // the edge would read as a full deflection nobody asked for.
    const zone = stickZone.getBoundingClientRect();
    const half = stickBase.getBoundingClientRect().width / 2;
    const bx = Math.min(Math.max(x, zone.left + half), zone.right - half);
    const by = Math.min(Math.max(y, zone.top + half), zone.bottom - half);
    stickBase.style.position = 'absolute';
    stickBase.style.left = (bx - zone.left - half) + 'px';
    stickBase.style.top = (by - zone.top - half) + 'px';
    originX = x; originY = y;
    stickBase.classList.add('active');
    measureRadius();
    updateVector(x, y);
  }

  function grabStick(e) {
    if (!canSteer()) return;
    // Remember every finger that lands in the zone, so control can be handed
    // over if the one that happens to be steering lifts first.
    zonePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // The NEWEST finger takes the stick. A finger already resting in the left
    // half (palm, spare thumb) must never lock out the thumb that arrives after
    // it to actually play — that reads as a completely dead stick.
    anchorStick(e.pointerId, e.clientX, e.clientY);
    e.preventDefault();
  }

  function moveStick(e) {
    const tracked = zonePointers.get(e.pointerId);
    if (tracked) { tracked.x = e.clientX; tracked.y = e.clientY; }
    if (stickId !== e.pointerId) return;
    updateVector(e.clientX, e.clientY);
    e.preventDefault();
  }

  /** A pointer ended. Hand the stick to another finger still down, or let go. */
  function endPointer(e) {
    zonePointers.delete(e.pointerId);
    if (stickId !== e.pointerId) return;
    const next = zonePointers.entries().next();
    if (!next.done && canSteer()) {
      const [id, pos] = next.value;
      anchorStick(id, pos.x, pos.y);   // re-anchored, so the stick can't jump
      return;
    }
    releaseStick(true);
  }

  function releaseStick(force, e) {
    if (!force && (!e || stickId !== e.pointerId)) return;
    stickId = null;
    zonePointers.clear();
    stickBase.classList.remove('active');
    stickBase.style.position = '';
    stickBase.style.left = '';
    stickBase.style.top = '';
    setKnob(0, 0);
    if (vx !== 0 || vy !== 0 || sentX !== 0 || sentY !== 0) {
      vx = 0; vy = 0;
      flushSend();
    }
  }

  // The move/end listeners live on WINDOW, not on the stick zone. The zone is
  // only the left half of the pad, and a thumb at full deflection routinely
  // travels outside it — bound to the zone, the pointerup then lands on another
  // element and never reaches releaseStick, which leaves the bomber walking in
  // the last direction forever AND wedges stickId so no later grab is accepted.
  // (setPointerCapture was meant to cover this, but it fails silently on some
  // mobile browsers, which is exactly when the stick died.)
  stickZone.addEventListener('pointerdown', grabStick);
  window.addEventListener('pointermove', moveStick, { passive: false });
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);
  // Backstop for browsers that drop a pointerup entirely (iOS Safari does this
  // under multi-touch): when the last finger leaves the glass, nothing can
  // still be steering, so let go unconditionally.
  window.addEventListener('touchend', function (e) {
    if (stickId !== null && e.touches && e.touches.length === 0) releaseStick(true);
  });
  window.addEventListener('touchcancel', function (e) {
    if (stickId !== null && e.touches && e.touches.length === 0) releaseStick(true);
  });
  // Losing focus mid-drag (call, notification, tab switch) must not leave the
  // bomber walking into a blast.
  window.addEventListener('blur', function () { releaseStick(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') releaseStick(true);
  });

  // ============================================================
  // Bomb button
  // ============================================================
  function dropBomb() {
    if (!canControl() || remainingBombs() <= 0) return;
    socket.emit('bomb', {});
    vibrate(12);
    // Optimistic: assume the drop lands so the badge reacts instantly. The
    // host's next m:hud is authoritative and will correct any mismatch.
    hud.out = Math.min(hud.bombs, hud.out + 1);
    updateBombBtn();
    const ripple = document.createElement('span');
    ripple.className = 'bb-ripple';
    bombBtn.appendChild(ripple);
    setTimeout(function () { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 460);
  }

  bombBtn.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    bombBtn.classList.add('pressed');
    dropBomb();
  });
  function unpress() { bombBtn.classList.remove('pressed'); }
  bombBtn.addEventListener('pointerup', unpress);
  bombBtn.addEventListener('pointercancel', unpress);
  bombBtn.addEventListener('pointerleave', unpress);
  // Suppress the synthesised click so a tap never fires the bomb twice.
  bombBtn.addEventListener('click', function (e) { e.preventDefault(); });

  // ============================================================
  // Bluetooth / USB gamepad
  // ============================================================
  // A controller paired to the phone drives the same stick vector and bomb
  // button the touch pad does, so nothing on the server or the host changes.
  // Reads raw axes/buttons from the standard Gamepad API layout, which every
  // brand (Xbox, PlayStation, Switch Pro, 8BitDo) reports the same way.
  const GP_DEADZONE = 0.3;      // ignore analog-stick drift near centre
  let gpIndex = null;           // index of the active pad, or null
  let gpBombLatch = false;      // last frame's bomb-button state (edge trigger)
  let gpSteering = false;       // the pad is currently driving the stick

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

  /**
   * Left stick (axes 0/1) or D-pad (12–15) steers; the D-pad wins when held so
   * it always gives a clean full-speed direction. Every face button and the
   * right shoulder/trigger drop a bomb — with only one action in the game there
   * is no reason to make players hunt for the right one.
   */
  function mapGamepad(gp) {
    const a = gp.axes || [];
    const b = gp.buttons || [];
    const down = function (i) { const btn = b[i]; return !!(btn && (btn.pressed || btn.value > 0.5)); };
    let ax = a.length > 0 ? (a[0] || 0) : 0;
    let ay = a.length > 1 ? (a[1] || 0) : 0;
    if (Math.abs(ax) < GP_DEADZONE) ax = 0;
    if (Math.abs(ay) < GP_DEADZONE) ay = 0;
    if (down(14)) ax = -1; else if (down(15)) ax = 1;
    if (down(12)) ay = -1; else if (down(13)) ay = 1;
    return {
      x: ax,
      y: ay,
      bomb: down(0) || down(1) || down(2) || down(3) || down(5) || down(7),
    };
  }

  function pollGamepad() {
    requestAnimationFrame(pollGamepad);
    const gp = activeGamepad();
    if (!gp) return;
    const m = mapGamepad(gp);

    // Bomb fires on a fresh press, exactly like tapping the button.
    if (m.bomb && !gpBombLatch) dropBomb();
    gpBombLatch = m.bomb;

    // A thumb on the touch stick always wins; the pad only steers when the
    // stick is free, and lets go of it as soon as the sticks centre.
    if (stickId !== null) { gpSteering = false; return; }
    const pushing = m.x !== 0 || m.y !== 0;
    if (!pushing && !gpSteering) return;
    if (!canSteer()) { if (gpSteering) { gpSteering = false; applyVector(0, 0); } return; }
    gpSteering = pushing;
    applyVector(m.x, m.y);
  }

  function setGamepadBadge(on) {
    if (gamepadBadge) gamepadBadge.hidden = !on;
    document.body.classList.toggle('has-gamepad', !!on);
    updateRotateHint();
  }
  window.addEventListener('gamepadconnected', function (e) {
    gpIndex = e.gamepad.index;
    setGamepadBadge(true);
  });
  window.addEventListener('gamepaddisconnected', function (e) {
    if (gpIndex === e.gamepad.index) {
      gpIndex = null;
      if (gpSteering) { gpSteering = false; applyVector(0, 0); }
    }
    setGamepadBadge(anyGamepad());
  });
  // A pad paired before the page loaded won't fire 'gamepadconnected' until its
  // first input, so reflect the current state on boot too.
  if (anyGamepad()) setGamepadBadge(true);
  pollGamepad();

  // ---------- Boot ----------
  setHud(hud, false);
  showView('wait');
})();
