/* ===== Category Clash · Join (mobile) ===== */
(function () {
  'use strict';

  var form = document.getElementById('joinForm');
  var nameInput = document.getElementById('nameInput');
  var errorMsg = document.getElementById('errorMsg');
  var submitBtn = form.querySelector('button[type="submit"]');

  // iOS Safari ignores maximum-scale / user-scalable — block the zoom gestures.
  (function lockZoom() {
    var stop = function (e) { e.preventDefault(); };
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('gestureend', stop, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
  })();

  // Already joined on this device → go straight to the player controller.
  if (localStorage.getItem('catclash.playerId')) {
    window.location.replace('/catclash/play');
    return;
  }

  // Pre-fill the name after a host reset.
  var rejoinName = localStorage.getItem('catclash.rejoinName');
  if (rejoinName) { nameInput.value = rejoinName; localStorage.removeItem('catclash.rejoinName'); }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function showError(msg) {
    errorMsg.textContent = msg;
    submitBtn.disabled = false;
  }

  var socket = io('/catclash', { transports: ['polling', 'websocket'] });
  var socketReady = false;

  function ensureOverlay(id, title, sub) {
    var ov = document.getElementById(id);
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = id;
    ov.className = 'host-absent-overlay';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="host-absent-card">' +
        '<div class="icon">📝</div>' +
        '<div class="title">' + title + '</div>' +
        '<div class="sub"><span class="pulse-dot"></span>' + sub + '</div>' +
      '</div>';
    document.body.appendChild(ov);
    return ov;
  }
  var hostPresent = true, roundLocked = false;
  function setHostPresent(v) {
    hostPresent = !!v;
    ensureOverlay('hostAbsentOverlay', 'No game in progress',
      "The host isn't here right now. This page will unlock automatically when they return.").hidden = hostPresent;
    if (hostPresent && !roundLocked) hideLocked();
  }
  function setRoundLocked(v) {
    roundLocked = !!v;
    var ov = ensureOverlay('roundLockedOverlay', 'Game in progress',
      "You can't hop in mid-game. This page will unlock when the host starts the next game.");
    ov.hidden = !roundLocked || !hostPresent;
  }
  function hideLocked() { var ov = document.getElementById('roundLockedOverlay'); if (ov) ov.hidden = true; }

  socket.on('connect', function () {
    socketReady = true;
    errorMsg.textContent = '';
    socket.emit('query:status', {}, function (status) {
      setHostPresent(!!(status && status.hostPresent));
      setRoundLocked(!!(status && status.phase && status.phase !== 'LOBBY'));
    });
  });
  socket.on('state:lobby', function () { setRoundLocked(false); });
  socket.on('state:reset', function () { setRoundLocked(false); });
  socket.on('state:intro', function () { setRoundLocked(true); });
  socket.on('state:round', function () { setRoundLocked(true); });
  socket.on('state:reviewing', function () { setRoundLocked(true); });
  socket.on('state:review', function () { setRoundLocked(true); });
  socket.on('state:reviewProgress', function () { setRoundLocked(true); });
  socket.on('state:reveal', function () { setRoundLocked(true); });
  socket.on('state:final', function () { setRoundLocked(true); });
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorMsg.textContent = '';
    var name = nameInput.value.trim();
    if (!name) return showError('Please enter a name.');
    if (!socketReady) return showError('Not connected yet — please wait a moment and try again.');
    submitBtn.disabled = true;
    var pid = uuid();
    var acked = false;
    var timeout = setTimeout(function () { if (!acked) showError('Server did not respond. Check your WiFi and try again.'); }, 5000);
    socket.emit('player:join', { playerId: pid, name: name }, function (res) {
      acked = true;
      clearTimeout(timeout);
      if (!res || !res.ok) {
        var reason = res && res.reason;
        var friendly = {
          'lobby-closed': 'The game has already started — sorry, you can\'t join now.',
          'name-too-short': 'Please enter a valid name.',
          'name-taken': (res && res.name ? '"' + res.name + '"' : 'That name') + ' is already taken.',
          'host-absent': 'The host isn\'t here right now. Wait for them to return and try again.',
          'bad-player-id': 'Something went wrong. Please reload the page.',
        }[reason] || 'Could not join. Please try again.';
        return showError(friendly);
      }
      localStorage.setItem('catclash.playerId', pid);
      localStorage.setItem('catclash.playerName', res.player.name);
      window.location.replace('/catclash/play');
    });
  });
})();
