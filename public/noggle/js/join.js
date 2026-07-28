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

  function ensureOverlay(id, title, sub) {
    let ov = document.getElementById(id);
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = id;
    ov.className = 'host-absent-overlay';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="host-absent-card">' +
        '<div class="icon">🔠</div>' +
        '<div class="title">' + title + '</div>' +
        '<div class="sub"><span class="pulse-dot"></span>' + sub + '</div>' +
        '<a class="overlay-practice-link" href="/noggle/practice?from=join">Practice solo →</a>' +
      '</div>';
    document.body.appendChild(ov);
    return ov;
  }

  let hostPresent = false;
  let roundLocked = false;
  function refreshLockState() {
    const hostOv = ensureOverlay('hostAbsentOverlay', 'No game in progress',
      'The host isn\'t here right now. This page will unlock automatically when they return.');
    const roundOv = ensureOverlay('roundLockedOverlay', 'Round in progress',
      'You can\'t hop in mid-round. This page will unlock as soon as the host starts the next one.');
    hostOv.hidden = hostPresent;
    roundOv.hidden = !(hostPresent && roundLocked);
    submitBtn.disabled = !hostPresent || roundLocked;
  }
  function setHostPresent(p) { hostPresent = !!p; refreshLockState(); }
  function setRoundLocked(l) { roundLocked = !!l; refreshLockState(); }
  setHostPresent(false);
  setRoundLocked(true);

  // If we've joined before, jump straight to the play screen.
  const existing = localStorage.getItem('noggle.playerId');
  if (existing) { window.location.replace('/noggle/play'); return; }

  const rejoinName = localStorage.getItem('noggle.rejoinName');
  if (rejoinName) { nameInput.value = rejoinName; localStorage.removeItem('noggle.rejoinName'); }

  const socket = io('/noggle', { transports: ['polling', 'websocket'] });

  let socketReady = false;
  socket.on('connect', function () {
    socketReady = true;
    errorMsg.textContent = '';
    socket.emit('query:status', {}, function (status) {
      setHostPresent(!!(status && status.hostPresent));
      setRoundLocked(!!(status && status.phase && status.phase !== 'LOBBY'));
    });
  });
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });
  socket.on('state:intro', function () { setRoundLocked(true); });
  socket.on('state:round', function () { setRoundLocked(true); });
  socket.on('state:final', function () { setRoundLocked(true); });
  socket.on('state:lobby', function () { setRoundLocked(false); });
  socket.on('state:reset', function () { setRoundLocked(false); });
  socket.on('connect_error', function (err) {
    errorMsg.textContent = 'Connection error: ' + (err && err.message ? err.message : err);
  });
  socket.on('disconnect', function () { socketReady = false; });

  function showError(msg) { errorMsg.textContent = msg; submitBtn.disabled = false; }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorMsg.textContent = '';
    const name = nameInput.value.trim();
    if (!name) return showError('Please enter a name.');
    if (!socketReady) return showError('Not connected to server yet — please wait a moment and try again.');
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
          'name-too-short': 'Please enter a valid name.',
          'name-taken': (res && res.name ? '"' + res.name + '"' : 'That name') + ' is already taken.',
          'host-absent': 'The host isn\'t here right now. Wait for them to return and try again.',
          'round-in-progress': 'A round is already in progress. Wait for the host to start the next one.',
          'bad-player-id': 'Something went wrong. Please reload the page.',
        }[reason] || 'Could not join. Please try again.';
        return showError(friendly);
      }
      localStorage.setItem('noggle.playerId', pid);
      localStorage.setItem('noggle.playerName', res.player.name);
      window.location.replace('/noggle/play');
    });
  });
})();
