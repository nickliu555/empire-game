/* ===== Camo · Host ===== */
(function () {
  'use strict';

  var socket = io('/camo', { transports: ['polling', 'websocket'] });

  // ---- Clock sync ----
  var clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }
  function syncClock(p) { if (p && typeof p.serverNow === 'number') clockOffset = p.serverNow - Date.now(); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- Views ----
  var views = {
    lobby: document.getElementById('view-lobby'),
    intro: document.getElementById('view-intro'),
    role: document.getElementById('view-role'),
    clues: document.getElementById('view-clues'),
    vote: document.getElementById('view-vote'),
    guess: document.getElementById('view-guess'),
    reveal: document.getElementById('view-reveal'),
    final: document.getElementById('view-final'),
  };
  var showTimer = null;
  var pendingView = null;
  function show(name) {
    var incoming = views[name];
    if (!incoming) return;
    // Leaving the reveal: kill any pending zoom-out so its timer can't fire
    // over a later phase.
    if (name !== 'reveal') clearRevealZoom();
    if (pendingView === name) return;
    // Phases can change faster than the 350ms crossfade (vote → guess → reveal
    // in one tick), so always sweep every other view, not just the one that
    // happened to be active when this call started.
    var stale = Object.keys(views).filter(function (k) {
      return k !== name && (views[k].classList.contains('active') || views[k].classList.contains('fading-out'));
    });
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (!stale.length) {
      pendingView = null;
      incoming.classList.add('active');
      return;
    }
    pendingView = name;
    stale.forEach(function (k) { views[k].classList.add('fading-out'); });
    showTimer = setTimeout(function () {
      showTimer = null;
      pendingView = null;
      stale.forEach(function (k) {
        views[k].classList.remove('active');
        views[k].classList.remove('fading-out');
      });
      incoming.classList.add('active');
    }, 350);
  }

  // ---- Element refs ----
  var qrImg = document.getElementById('qrImg');
  var joinUrlEl = document.getElementById('joinUrl');
  var playerList = document.getElementById('playerList');
  var playerCount = document.getElementById('playerCount');
  var playerMax = document.getElementById('playerMax');
  var startBtn = document.getElementById('startBtn');
  var startError = document.getElementById('startError');
  var targetSelect = document.getElementById('targetSelect');
  var autoAdvanceCheck = document.getElementById('autoAdvanceCheck');

  var MIN_PLAYERS = 3;
  var MAX_PLAYERS = 8;

  // ---- QR ----
  function renderQR() {
    fetch('/api/camo/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var url = (cfg && cfg.joinUrl) || (window.location.origin + '/camo/join');
      if (cfg && cfg.maxPlayers) { MAX_PLAYERS = cfg.maxPlayers; playerMax.textContent = MAX_PLAYERS; }
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      qrImg.src = '/api/camo/qr?url=' + encodeURIComponent(url);
    }).catch(function () {
      var url = window.location.origin + '/camo/join';
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      qrImg.src = '/api/camo/qr?url=' + encodeURIComponent(url);
    });
  }

  // ---- The 4x4 grid ----
  function renderGrid(el, grid, opts) {
    if (!el) return;
    var words = (grid && grid.words) || [];
    var o = opts || {};
    el.innerHTML = words.map(function (w, i) {
      var cls = 'word-cell';
      if (o.secretIndex === i) cls += ' secret';
      if (o.guessIndex === i) cls += ' guessed';
      return '<div class="' + cls + '">' + escapeHtml(w) + '</div>';
    }).join('');
  }

  function renderOrder(el, order, currentIndex) {
    if (!el) return;
    el.innerHTML = (order || []).map(function (p, i) {
      var cls = 'order-row';
      if (typeof currentIndex === 'number') {
        if (i === currentIndex) cls += ' current';
        else if (i < currentIndex) cls += ' done';
      }
      if (!p.connected) cls += ' disconnected';
      var tag = '';
      if (typeof currentIndex === 'number') {
        if (i === currentIndex) tag = 'Now';
        else if (i < currentIndex) tag = '✓';
      }
      return '<div class="' + cls + '">' +
        '<div class="num">' + (i + 1) + '</div>' +
        '<div class="name">' + escapeHtml(p.name) + '</div>' +
        '<div class="tag">' + tag + '</div>' +
        '</div>';
    }).join('');
  }

  function renderTally(el, tally, opts) {
    if (!el) return;
    var o = opts || {};
    var rows = tally || [];
    var max = rows.reduce(function (m, r) { return Math.max(m, r.votes || 0); }, 0) || 1;
    el.innerHTML = rows.map(function (r) {
      var cls = 'tally-row';
      if (o.accusedId && r.id === o.accusedId) cls += ' accused';
      if (o.chameleonId && r.id === o.chameleonId) cls += ' chameleon';
      var pct = Math.round(((r.votes || 0) / max) * 100);
      return '<div class="' + cls + '">' +
        '<div class="tally-fill" style="width:' + pct + '%"></div>' +
        '<div class="label">' + escapeHtml(r.name) + '</div>' +
        '<div class="votes">' + (r.votes || 0) + '</div>' +
        '</div>';
    }).join('');
  }

  function renderLeaderboardInto(el, rows, chameleonId, scorers) {
    if (!el) return;
    var gained = {};
    (scorers || []).forEach(function (s) { if (s && s.playerId) gained[s.playerId] = s.points; });
    var showDelta = !!(scorers && scorers.length);
    el.classList.toggle('no-delta', !showDelta);
    el.innerHTML = (rows || []).map(function (r) {
      var cls = 'lb-row' + (chameleonId && r.id === chameleonId ? ' is-chameleon' : '');
      // Always emit the delta cell, so a player who scored nothing doesn't pull
      // their total out of the score column.
      var delta = !showDelta ? ''
        : gained[r.id] ? '<div class="delta">+' + gained[r.id] + '</div>'
        : '<div class="delta empty"></div>';
      return '<div class="' + cls + '">' +
        '<div class="rank">' + r.rank + '</div>' +
        '<div class="name">' + escapeHtml(r.name) + '</div>' +
        delta +
        '<div class="score">' + r.score + '</div>' +
        '</div>';
    }).join('');
  }

  // ---- Lobby ----
  var lastLobbyCount = -1;
  function renderLobby(s) {
    var players = (s && s.players) || [];
    if (lastLobbyCount >= 0 && players.length > lastLobbyCount) playDing();
    lastLobbyCount = players.length;
    playerCount.textContent = players.length;
    if (s && s.max) { MAX_PLAYERS = s.max; playerMax.textContent = MAX_PLAYERS; }
    playerList.innerHTML = players.map(function (p) {
      var cls = 'player-chip' + (p.connected ? '' : ' disconnected');
      return '<div class="' + cls + '" data-pid="' + escapeHtml(p.id) + '" title="Click to remove">' + escapeHtml(p.name) + '</div>';
    }).join('');
    startBtn.disabled = players.length < MIN_PLAYERS;
  }
  playerList.addEventListener('click', function (e) {
    var chip = e.target.closest('.player-chip');
    if (!chip) return;
    var pid = chip.getAttribute('data-pid');
    showConfirm('Remove this player?', 'Remove', { danger: true }).then(function (ok) {
      if (ok) socket.emit('host:kick', { playerId: pid });
    });
  });

  startBtn.addEventListener('click', function () {
    startError.hidden = true;
    startBtn.disabled = true;
    unlockAudio();
    socket.emit('host:start', {
      targetScore: parseInt(targetSelect.value, 10),
      autoAdvance: !!(autoAdvanceCheck && autoAdvanceCheck.checked),
    }, function (res) {
      startBtn.disabled = false;
      if (!res || !res.ok) {
        startError.textContent = (res && res.reason === 'not-enough-players')
          ? 'Need at least ' + MIN_PLAYERS + ' players to start'
          : 'Could not start. Please try again.';
        startError.hidden = false;
      } else {
        playStartFanfare();
      }
    });
  });

  // ---- Intro ----
  var introTimer = null;
  function stopIntroTimer() { if (introTimer) { clearInterval(introTimer); introTimer = null; } }
  function renderIntro(p) {
    syncClock(p);
    show('intro');
    var el = document.getElementById('introCountdown');
    var endsAt = (p && p.endsAt) || (serverNow() + 4000);
    function tick() {
      var left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (el) el.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    stopIntroTimer();
    introTimer = setInterval(tick, 200);
  }

  // ---- Role ----
  var lastRoleRound = -1;
  function renderRole(r) {
    if (!r) return;
    show('role');
    stopIntroTimer();
    document.getElementById('roleRound').textContent = r.round || 1;
    document.getElementById('roleTarget').textContent = r.target || 5;
    document.getElementById('roleTopic').textContent = (r.grid && r.grid.topic) || '';
    renderGrid(document.getElementById('roleGrid'), r.grid, {});
    document.getElementById('roleAcked').textContent = r.acked || 0;
    document.getElementById('roleTotal').textContent = r.total || 0;
    if (r.round !== lastRoleRound) {
      lastRoleRound = r.round;
      playNewRoundCue();
    }
  }
  socket.on('host:roleAckCount', function (p) {
    if (!p) return;
    document.getElementById('roleAcked').textContent = p.acked || 0;
    document.getElementById('roleTotal').textContent = p.total || 0;
  });

  // ---- Clues ----
  var lastTurnKey = '';
  var currentSpeakerName = '';
  function renderClues(c) {
    if (!c) return;
    show('clues');
    document.getElementById('cluesRound').textContent = c.round || 1;
    document.getElementById('cluesTopic').textContent = (c.grid && c.grid.topic) || '';
    document.getElementById('cluesSpeaker').innerHTML = c.currentName
      ? '<span class="pname">' + escapeHtml(c.currentName) + '</span>, your word…'
      : '—';
    currentSpeakerName = c.currentName || '';
    renderGrid(document.getElementById('cluesGrid'), c.grid, {});
    renderOrder(document.getElementById('cluesOrder'), c.order, c.turnIndex);
    var key = c.round + ':' + c.turnIndex;
    if (key !== lastTurnKey) {
      lastTurnKey = key;
      playTurnBlip();
    }
  }
  document.getElementById('skipTurnBtn').addEventListener('click', function () {
    var who = currentSpeakerName ? '“' + currentSpeakerName + '”' : 'this player';
    showConfirm('Skip ' + who + '’s turn?', 'Skip').then(function (ok) {
      if (ok) socket.emit('host:next', {});
    });
  });

  // ---- Vote ----
  var lastVoted = -1;
  function renderVote(v) {
    if (!v) return;
    show('vote');
    document.getElementById('voteRound').textContent = v.round || 1;
    renderGrid(document.getElementById('voteGrid'), v.grid, {});
    renderOrder(document.getElementById('voteOrder'), v.order);
    document.getElementById('voteCount').textContent = v.voted || 0;
    document.getElementById('voteTotal').textContent = v.total || 0;
    lastVoted = v.voted || 0;
    playVoteOpen();
  }
  socket.on('host:voteCount', function (p) {
    if (!p) return;
    document.getElementById('voteCount').textContent = p.voted || 0;
    document.getElementById('voteTotal').textContent = p.total || 0;
    if (typeof p.voted === 'number' && p.voted > lastVoted) playVoteTick();
    lastVoted = typeof p.voted === 'number' ? p.voted : lastVoted;
  });
  document.getElementById('closeVoteBtn').addEventListener('click', function () {
    socket.emit('host:next', {});
  });

  // ---- Guess ----
  function renderGuess(g) {
    if (!g) return;
    show('guess');
    document.getElementById('guessRound').textContent = g.round || 1;
    document.getElementById('guessName').textContent = g.chameleonName || 'The Chameleon';
    document.getElementById('guessTieChip').hidden = !g.caughtOnTie;
    renderGrid(document.getElementById('guessGrid'), g.grid, {});
    renderTally(document.getElementById('guessTally'), g.tally, {
      accusedId: g.accusedId, chameleonId: g.chameleonId,
    });
    playCaughtStinger();
  }
  document.getElementById('skipGuessBtn').addEventListener('click', function () {
    socket.emit('host:next', {});
  });

  // ---- Reveal ----
  var revealTimer = null;
  function stopRevealTimer() { if (revealTimer) { clearInterval(revealTimer); revealTimer = null; } }

  // Lead-in: hold the verdict alone and centred for a beat, then let the rest
  // of the details fade back in around it.
  var REVEAL_FOCUS_MS = 1800;
  var revealZoomTimer = null;
  function clearRevealZoom() {
    if (revealZoomTimer) { clearTimeout(revealZoomTimer); revealZoomTimer = null; }
    var rv = views.reveal.querySelector('.reveal-view');
    if (rv) rv.classList.remove('reveal-focus', 'reveal-instant');
  }
  function startRevealZoom() {
    var rv = views.reveal.querySelector('.reveal-view');
    var verdict = document.getElementById('revealVerdict');
    if (!rv || !verdict) return;
    // Measure before focusing: both rects sit inside the same (possibly
    // mid-crossfade) section, so any view-level offset cancels out.
    var box = rv.getBoundingClientRect();
    var v = verdict.getBoundingClientRect();
    rv.style.setProperty('--verdict-lift',
      Math.round((box.top + box.height / 2) - (v.top + v.height / 2)) + 'px');
    rv.classList.add('reveal-focus', 'reveal-instant');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        rv.classList.remove('reveal-instant');
        revealZoomTimer = setTimeout(function () {
          revealZoomTimer = null;
          rv.classList.remove('reveal-focus');
        }, REVEAL_FOCUS_MS);
      });
    });
  }

  function renderReveal(r) {
    if (!r) return;
    syncClock(r);
    show('reveal');
    clearRevealZoom();
    document.getElementById('revealRound').textContent = r.round || 1;
    document.getElementById('revealTarget').textContent = r.target || 5;

    var verdict = document.getElementById('revealVerdict');
    var word = document.getElementById('verdictWord');
    var chip = document.getElementById('verdictChip');
    verdict.classList.remove('caught', 'escaped', 'wrong', 'right');
    if (r.outcome === 'caught') {
      verdict.classList.add('caught');
      // The vote already played out on the GUESS screen — the news here is the failed guess.
      word.textContent = r.guessWord ? 'WRONG GUESS' : 'CAUGHT';
      if (r.guessWord) {
        verdict.classList.add('wrong');
        chip.innerHTML = 'Guessed “' + escapeHtml(r.guessWord) + '” <span class="mark bad">✗</span>';
        chip.hidden = false;
      } else {
        chip.hidden = true;
      }
    } else if (r.outcome === 'escaped-guess') {
      // Voted out, but they named the word — redeemed, not escaped.
      verdict.classList.add('escaped', 'right');
      word.textContent = 'RIGHT GUESS';
      chip.innerHTML = r.guessWord
        ? 'Guessed “' + escapeHtml(r.guessWord) + '” <span class="mark good">✓</span>'
        : 'Named the word <span class="mark good">✓</span>';
      chip.hidden = false;
    } else {
      verdict.classList.add('escaped');
      word.textContent = 'ESCAPED';
      if (r.accusedName) {
        chip.innerHTML = 'The room voted <span class="pname">' + escapeHtml(r.accusedName) + '</span>';
        chip.hidden = false;
      } else {
        chip.textContent = 'No majority';
        chip.hidden = false;
      }
    }

    document.getElementById('revealCham').textContent = r.chameleonName || '—';
    document.getElementById('revealWord').textContent = r.secretWord || '—';

    renderTally(document.getElementById('revealTally'), r.tally, {
      accusedId: r.accusedId, chameleonId: r.chameleonId,
    });
    renderLeaderboardInto(document.getElementById('revealLb'), r.leaderboard, r.chameleonId, r.scorers);

    var nextBtn = document.getElementById('nextBtn');
    nextBtn.textContent = r.gameOver ? 'See the results →' : 'Next round →';
    stopRevealTimer();
    if (r.autoAdvance && r.revealEndsAt) {
      var endsAt = r.revealEndsAt;
      revealTimer = setInterval(function () {
        var left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
        nextBtn.textContent = (r.gameOver ? 'See the results' : 'Next round') + ' → ' + left + 's';
        if (left <= 0) stopRevealTimer();
      }, 200);
    }

    if (r.outcome === 'caught') playCaughtReveal();
    else playEscapeReveal();

    startRevealZoom();
  }
  document.getElementById('nextBtn').addEventListener('click', function () {
    stopRevealTimer();
    socket.emit('host:next', {});
  });

  // ---- Final ----
  function podiumCell(cls, medal, group) {
    if (!group) return '<div class="podium-step empty-slot"></div>';
    var names = group.players || [];
    var shown = names.slice(0, 3).map(function (p) {
      return '<div class="name">' + escapeHtml(p.name) + '</div>';
    }).join('');
    var more = names.length > 3 ? '<div class="more-count">+' + (names.length - 3) + ' more</div>' : '';
    var tie = names.length > 1 ? '<div class="tie-pill">TIE</div>' : '';
    return '<div class="podium-step ' + cls + '">' + tie +
      '<div class="medal">' + medal + '</div>' +
      '<div class="names-list">' + shown + more + '</div>' +
      '<div class="score">' + group.score + (group.score === 1 ? ' pt' : ' pts') + '</div>' +
      '</div>';
  }
  function renderFinal(f) {
    show('final');
    stopRevealTimer();
    var title = document.getElementById('finalTitle');
    var intro = document.getElementById('resultsIntro');
    if (f && f.winnerName) {
      title.innerHTML = '🏆 <span class="pname">' + escapeHtml(f.winnerName) + '</span> wins!';
      title.classList.add('with-name');
      intro.textContent = 'First to ' + (f.target || 5) + ' points.';
    } else {
      title.textContent = '🦎 It\'s a tie!';
      title.classList.remove('with-name');
      intro.textContent = 'Nobody could be separated at the top.';
    }
    var g = (f && f.podiumGroups) || [];
    document.getElementById('podium').innerHTML =
      podiumCell('place-2', '🥈', g[1]) +
      podiumCell('place-1', '🥇', g[0]) +
      podiumCell('place-3', '🥉', g[2]);
    renderLeaderboardInto(document.getElementById('fullLb'), (f && f.fullLeaderboard) || []);
    playApplause();
    burstConfetti();
  }

  // ---- Confetti ----
  var confettiLayer = document.getElementById('confettiLayer');
  function burstConfetti() {
    if (!confettiLayer) return;
    var colors = ['#A3E635', '#5B2A86', '#F0A83A', '#FFFFFF', '#8B5FBF'];
    confettiLayer.innerHTML = '';
    for (var i = 0; i < 110; i++) {
      var bit = document.createElement('div');
      bit.className = 'confetti-bit';
      bit.style.left = (Math.random() * 100) + '%';
      bit.style.background = colors[i % colors.length];
      bit.style.animationDuration = (2.6 + Math.random() * 2.2) + 's';
      bit.style.animationDelay = (Math.random() * 0.9) + 's';
      bit.style.opacity = String(0.75 + Math.random() * 0.25);
      confettiLayer.appendChild(bit);
    }
    setTimeout(function () { if (confettiLayer) confettiLayer.innerHTML = ''; }, 6500);
  }

  // ---- Socket state ----
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      reactionsMuted = !!res.reactionsMuted;
      updateMuteBtn();
      if (typeof res.minPlayers === 'number') MIN_PLAYERS = res.minPlayers;
      if (typeof res.maxPlayers === 'number') { MAX_PLAYERS = res.maxPlayers; playerMax.textContent = MAX_PLAYERS; }
      if (typeof res.target === 'number' && targetSelect) targetSelect.value = String(res.target);
      if (res.phase === 'LOBBY') { show('lobby'); renderLobby({ players: res.players }); }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
    renderQR();
  });
  socket.on('state:lobby', function (s) { if (s && s.phase === 'LOBBY') show('lobby'); renderLobby(s); });
  socket.on('state:intro', renderIntro);
  socket.on('state:role', renderRole);
  socket.on('state:clues', renderClues);
  socket.on('state:vote', renderVote);
  socket.on('state:guess', renderGuess);
  socket.on('state:reveal', renderReveal);
  socket.on('state:final', renderFinal);
  socket.on('state:reset', function () {
    stopIntroTimer();
    stopRevealTimer();
    show('lobby');
    lastLobbyCount = -1;
    lastRoleRound = -1;
    lastTurnKey = '';
  });

  // ---- Reactions ----
  var REACTION_EMOJIS = ['😂', '🔥', '👀', '🎉', '😱', '😡'];
  var REACTION_MAX = 30;
  var reactionLayer = document.getElementById('reactionLayer');
  function spawnReaction(index) {
    var emoji = REACTION_EMOJIS[index];
    if (!emoji || !reactionLayer) return;
    while (reactionLayer.children.length >= REACTION_MAX) reactionLayer.removeChild(reactionLayer.firstChild);
    var el = document.createElement('div');
    el.className = 'reaction-emoji';
    el.textContent = emoji;
    el.style.left = (5 + Math.random() * 90) + '%';
    var scale = 0.85 + Math.random() * 0.5;
    el.style.fontSize = (44 * scale) + 'px';
    el.style.animationDuration = (3.0 + Math.random() * 1.2) + 's';
    el.addEventListener('animationend', function () { if (el.parentNode) el.parentNode.removeChild(el); });
    reactionLayer.appendChild(el);
  }
  socket.on('host:reaction', function (p) { if (p && typeof p.index === 'number') spawnReaction(p.index); });

  var reactionsMuted = false;
  var muteBtn = document.getElementById('muteReactionsBtn');
  function updateMuteBtn() {
    if (!muteBtn) return;
    if (reactionsMuted) { muteBtn.textContent = '🔕 Reactions: Off'; muteBtn.classList.add('is-muted'); }
    else { muteBtn.textContent = '🔔 Reactions: On'; muteBtn.classList.remove('is-muted'); }
  }
  if (muteBtn) muteBtn.addEventListener('click', function () {
    socket.emit('host:setReactionsMuted', { muted: !reactionsMuted }, function (res) {
      if (res && res.ok) { reactionsMuted = !!res.reactionsMuted; updateMuteBtn(); }
    });
  });
  socket.on('state:reactionsMuted', function (p) { reactionsMuted = !!(p && p.muted); updateMuteBtn(); });

  // ---- Wake Lock (keep Host screen awake) ----
  var wakeLock = null;
  function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (wl) {
      wakeLock = wl;
      wakeLock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { wakeLock = null; });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wakeLock === null) acquireWakeLock();
  });
  acquireWakeLock();
  document.addEventListener('click', function once() {
    document.removeEventListener('click', once);
    if (wakeLock === null) acquireWakeLock();
  });

  // ---- Fullscreen / reset / hub ----
  var fullscreenBtn = document.getElementById('fullscreenBtn');
  if (fullscreenBtn) fullscreenBtn.addEventListener('click', function () {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(function () {});
    else document.exitFullscreen();
  });
  document.addEventListener('fullscreenchange', function () {
    if (fullscreenBtn) fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit' : '⛶ Fullscreen';
  });
  document.getElementById('resetBtn').addEventListener('click', function () {
    showConfirm('Reset the entire game? All players will be kicked.', 'Reset', { danger: true }).then(function (ok) {
      if (ok) socket.emit('host:reset', {});
    });
  });
  var hubBtn = document.getElementById('hubBtn');
  if (hubBtn) hubBtn.addEventListener('click', function (e) {
    e.preventDefault();
    var href = hubBtn.getAttribute('href') || '/';
    showConfirm('Leaving will reset the game and kick all players. Go back to the hub?', 'Leave & Reset', { danger: true }).then(function (ok) {
      if (!ok) return;
      socket.emit('host:leave', {}, function () { window.location.href = href; });
    });
  });

  // ---- Audio ----
  var audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  }
  function unlockAudio() {
    var ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    try {
      var t = ctx.currentTime;
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.001);
    } catch (e) {}
  }
  function readyCtx() {
    var ctx = getAudioCtx();
    if (!ctx) return null;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function () {});
      if (ctx.state !== 'running') return null;
    }
    return ctx;
  }
  function playNotes(notes, layersFor) {
    var ctx = readyCtx();
    if (!ctx) return;
    var t0 = ctx.currentTime;
    notes.forEach(function (n) {
      layersFor(n).forEach(function (layer) {
        var osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = layer.type;
        osc.frequency.value = layer.freq;
        var t = t0 + n.start;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(layer.vol, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t); osc.stop(t + n.dur + 0.05);
      });
    });
  }
  // Two-note join ding — matches the other games' lobby-join sound.
  function playDing() {
    var ctx = readyCtx();
    if (!ctx) return;
    var osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  }
  // Cheerful rising fanfare on game start.
  function playStartFanfare() {
    playNotes([
      { freq: 523.25, start: 0.00, dur: 0.22 },
      { freq: 659.25, start: 0.14, dur: 0.22 },
      { freq: 783.99, start: 0.28, dur: 0.55 },
    ], function (n) {
      return [
        { type: 'triangle', freq: n.freq, vol: 0.45 },
        { type: 'sine', freq: n.freq * 0.5, vol: 0.18 },
      ];
    });
  }
  // "Look up!" arpeggio when a new round's grid appears.
  function playNewRoundCue() {
    playNotes([
      { freq: 587.33, start: 0.00, dur: 0.20 },
      { freq: 739.99, start: 0.13, dur: 0.20 },
      { freq: 880.00, start: 0.26, dur: 0.24 },
      { freq: 1174.66, start: 0.40, dur: 0.50 },
    ], function (n) {
      return [
        { type: 'triangle', freq: n.freq, vol: 0.40 },
        { type: 'sine', freq: n.freq * 2, vol: 0.10 },
      ];
    });
  }
  // Short blip as the turn passes to the next speaker.
  function playTurnBlip() {
    playNotes([
      { freq: 783.99, start: 0.00, dur: 0.13 },
      { freq: 1046.50, start: 0.09, dur: 0.20 },
    ], function (n) {
      return [{ type: 'sine', freq: n.freq, vol: 0.30 }];
    });
  }
  // Tense descending chime when voting opens.
  function playVoteOpen() {
    playNotes([
      { freq: 880.00, start: 0.00, dur: 0.24 },
      { freq: 659.25, start: 0.15, dur: 0.28 },
      { freq: 523.25, start: 0.30, dur: 0.50 },
    ], function (n) {
      return [
        { type: 'sine', freq: n.freq, vol: 0.40 },
        { type: 'triangle', freq: n.freq * 2, vol: 0.07 },
      ];
    });
  }
  // Soft tick each time a vote lands.
  function playVoteTick() {
    playNotes([{ freq: 1174.66, start: 0.00, dur: 0.10 }], function (n) {
      return [{ type: 'sine', freq: n.freq, vol: 0.22 }];
    });
  }
  // Sharp stab the moment someone is accused correctly.
  function playCaughtStinger() {
    playNotes([
      { freq: 349.23, start: 0.00, dur: 0.20 },
      { freq: 523.25, start: 0.12, dur: 0.22 },
      { freq: 698.46, start: 0.24, dur: 0.42 },
    ], function (n) {
      return [
        { type: 'square', freq: n.freq, vol: 0.16 },
        { type: 'triangle', freq: n.freq, vol: 0.34 },
      ];
    });
  }
  // Bright resolve when the room caught the Chameleon.
  function playCaughtReveal() {
    playNotes([
      { freq: 659.25, start: 0.00, dur: 0.24 },
      { freq: 830.61, start: 0.15, dur: 0.24 },
      { freq: 1046.50, start: 0.30, dur: 0.60 },
    ], function (n) {
      return [
        { type: 'triangle', freq: n.freq, vol: 0.42 },
        { type: 'sine', freq: n.freq * 0.5, vol: 0.14 },
      ];
    });
  }
  // Slinky descending "they got away" sting.
  function playEscapeReveal() {
    playNotes([
      { freq: 622.25, start: 0.00, dur: 0.26 },
      { freq: 466.16, start: 0.18, dur: 0.30 },
      { freq: 349.23, start: 0.38, dur: 0.62 },
    ], function (n) {
      return [
        { type: 'triangle', freq: n.freq, vol: 0.38 },
        { type: 'sine', freq: n.freq * 0.5, vol: 0.14 },
      ];
    });
  }
  function playApplause() {
    var ctx = readyCtx();
    if (!ctx) return;
    var t = ctx.currentTime;
    [523, 659, 784, 1047].forEach(function (f, i) {
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'triangle'; osc.frequency.value = f;
      var st = t + i * 0.09;
      gain.gain.setValueAtTime(0.0001, st);
      gain.gain.exponentialRampToValueAtTime(0.2, st + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(st); osc.stop(st + 0.52);
    });
  }
  // Unlock audio on first interaction.
  ['click', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function once() {
      var ctx = getAudioCtx();
      if (ctx && ctx.state !== 'running') ctx.resume().catch(function () {});
      window.removeEventListener(ev, once);
    }, { once: true });
  });
})();
