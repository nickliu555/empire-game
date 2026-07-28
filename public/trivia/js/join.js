(function () {
  'use strict';

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  const form = document.getElementById('joinForm');
  const nameInput = document.getElementById('nameInput');
  const errorMsg = document.getElementById('errorMsg');
  const submitBtn = form.querySelector('button[type="submit"]');

  // Host-absent overlay (created on demand, covers the join form).
  function ensureHostAbsentOverlay() {
    let ov = document.getElementById('hostAbsentOverlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'hostAbsentOverlay';
    ov.className = 'host-absent-overlay';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="host-absent-card">' +
        '<div class="icon">🧠</div>' +
        '<div class="title">No game in progress</div>' +
        '<div class="sub">' +
          '<span class="pulse-dot"></span>' +
          'The host isn\'t here right now. This page will unlock automatically when they return.' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    return ov;
  }
  // Separate overlay for the "quiz already started" case so the wording
  // reflects reality (it isn't a host-absence problem — just bad timing).
  function ensureRoundLockedOverlay() {
    let ov = document.getElementById('roundLockedOverlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'roundLockedOverlay';
    ov.className = 'host-absent-overlay';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="host-absent-card">' +
        '<div class="icon">🧠</div>' +
        '<div class="title">Quiz in progress</div>' +
        '<div class="sub">' +
          '<span class="pulse-dot"></span>' +
          'You can\'t hop in mid-quiz. This page will unlock as soon as the host starts the next one.' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    return ov;
  }
  let hostPresent = false;
  let roundLocked = false;
  function refreshLockState() {
    const hostOv = ensureHostAbsentOverlay();
    const roundOv = ensureRoundLockedOverlay();
    // Host-absent takes precedence so we don't tell the player "quiz in
    // progress" when really no one is even running the game.
    hostOv.hidden = hostPresent;
    roundOv.hidden = !(hostPresent && roundLocked);
    submitBtn.disabled = !hostPresent || roundLocked;
    if (hostPresent && errorMsg.textContent && /host/i.test(errorMsg.textContent)) {
      errorMsg.textContent = '';
    }
    if (!roundLocked && errorMsg.textContent && /quiz|started/i.test(errorMsg.textContent)) {
      errorMsg.textContent = '';
    }
  }
  function setHostPresent(present) {
    hostPresent = !!present;
    refreshLockState();
  }
  function setRoundLocked(locked) {
    roundLocked = !!locked;
    refreshLockState();
  }
  // Default to absent + locked until the server confirms otherwise so we
  // never flash an enabled Join button before we know the real state.
  setHostPresent(false);
  setRoundLocked(true);

  // If we already have a playerId, go straight to /trivia/play
  const existing = localStorage.getItem('trivia.playerId');
  if (existing) {
    window.location.replace('/trivia/play');
    return;
  }

  // Pre-fill name if the host just reset the game.
  const rejoinName = localStorage.getItem('trivia.rejoinName');
  if (rejoinName) {
    nameInput.value = rejoinName;
    localStorage.removeItem('trivia.rejoinName');
  }

  const socket = io('/trivia', { transports: ['polling', 'websocket'] });

  let socketReady = false;
  socket.on('connect', function () {
    socketReady = true;
    errorMsg.textContent = '';
    // Ask the server whether a host is currently present. Until we hear back,
    // the form stays disabled (default state set above).
    socket.emit('query:status', {}, function (status) {
      setHostPresent(!!(status && status.hostPresent));
      setRoundLocked(!!(status && status.phase && status.phase !== 'LOBBY'));
    });
  });
  socket.on('state:hostPresence', function (p) {
    setHostPresent(!(p && p.present === false));
  });
  // Quiz lifecycle is broadcast across the namespace, so even though we
  // haven't joined yet we still hear when a quiz starts/ends/resets.
  socket.on('state:lobby', function () { setRoundLocked(false); });
  socket.on('state:reset', function () { setRoundLocked(false); });
  socket.on('state:intro', function () { setRoundLocked(true); });
  socket.on('state:prompt', function () { setRoundLocked(true); });
  socket.on('state:question', function () { setRoundLocked(true); });
  socket.on('state:reveal', function () { setRoundLocked(true); });
  socket.on('state:final', function () { setRoundLocked(true); });
  socket.on('connect_error', function (err) {
    errorMsg.textContent = 'Connection error: ' + (err && err.message ? err.message : err);
  });
  socket.on('disconnect', function () {
    socketReady = false;
  });

  function showError(msg) {
    errorMsg.textContent = msg;
    submitBtn.disabled = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorMsg.textContent = '';
    const name = nameInput.value.trim();
    if (!name) return showError('Please enter a name.');
    if (!socketReady) {
      return showError('Not connected to server yet — please wait a moment and try again.');
    }
    submitBtn.disabled = true;
    const pid = uuid();
    let acked = false;
    const timeout = setTimeout(function () {
      if (acked) return;
      showError('Server did not respond. Check your WiFi and try again.');
    }, 5000);
    socket.emit('player:join', { playerId: pid, name: name }, function (res) {
      acked = true;
      clearTimeout(timeout);
      if (!res || !res.ok) {
        const reason = res && res.reason;
        const friendly = {
          'lobby-closed': 'The quiz has already started — sorry, you cannot join now.',
          'name-too-short': 'Please enter a valid name.',
          'name-taken': (res && res.name ? '"' + res.name + '"' : 'That name') + ' is already another player\'s name.',
          'host-absent': 'The host isn\'t here right now. Wait for them to return and try again.',
          'bad-player-id': 'Something went wrong. Please reload the page.',
        }[reason] || 'Could not join. Please try again.';
        return showError(friendly);
      }
      localStorage.setItem('trivia.playerId', pid);
      localStorage.setItem('trivia.playerName', res.player.name);
      window.location.replace('/trivia/play');
    });
  });
})();
