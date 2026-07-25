/* ===== Ranking · Host ===== */
(function () {
  'use strict';

  var socket = io('/ranking', { transports: ['polling', 'websocket'] });

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
    collect: document.getElementById('view-collect'),
    intro: document.getElementById('view-intro'),
    rank: document.getElementById('view-rank'),
    discuss: document.getElementById('view-discuss'),
    revealTransition: document.getElementById('view-reveal-transition'),
    reveal: document.getElementById('view-reveal'),
    final: document.getElementById('view-final'),
  };
  var showTimer = null;
  function show(name) {
    var incoming = views[name];
    if (!incoming) return;
    // Leaving the reveal: kill any pending pill zoom-out so its timer can't
    // toggle a now-hidden view.
    if (name !== 'reveal') clearRevealZoom();
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    var currentName = Object.keys(views).find(function (k) { return views[k].classList.contains('active'); });
    if (currentName === name) { forceSingle(name); return; }
    var outgoing = currentName ? views[currentName] : null;
    if (outgoing) {
      // Ensure only the outgoing view lingers during the fade (kills any stray
      // active/fading-out left by a fast previous transition).
      Object.keys(views).forEach(function (k) {
        if (k !== currentName && k !== name) views[k].classList.remove('active', 'fading-out');
      });
      outgoing.classList.add('fading-out');
      showTimer = setTimeout(function () { showTimer = null; forceSingle(name); }, 350);
    } else {
      forceSingle(name);
    }
  }
  // Normalize to EXACTLY one active view (bulletproof against transition races
  // and any stray/duplicate state broadcast).
  function forceSingle(name) {
    Object.keys(views).forEach(function (k) {
      if (k === name) views[k].classList.add('active');
      else views[k].classList.remove('active', 'fading-out');
    });
  }

  // ---- Element refs ----
  var qrImg = document.getElementById('qrImg');
  var joinUrlEl = document.getElementById('joinUrl');
  var playerList = document.getElementById('playerList');
  var playerCount = document.getElementById('playerCount');
  var startBtn = document.getElementById('startBtn');
  var startError = document.getElementById('startError');
  var customWordsSeg = document.getElementById('customWordsSeg');
  var collectDone = document.getElementById('collectDone');
  var collectTotal = document.getElementById('collectTotal');
  var collectList = document.getElementById('collectList');
  var collectActions = document.getElementById('collectActions');
  var collectStartBtn = document.getElementById('collectStartBtn');

  var MIN_PLAYERS = 2;

  // ---- Shared bits ----
  function scoreboardHtml(group, game) {
    var total = group + game;
    var gp = total > 0 ? (group / total * 100) : 50;
    var mp = 100 - gp;
    return '<div class="scoreboard">' +
      '<div class="sb-side group"><span class="sb-label">Group</span><span class="sb-num">' + group + '</span></div>' +
      '<div class="sb-bar">' +
        '<div class="sb-fill-group" style="width:' + gp.toFixed(1) + '%"></div>' +
        '<div class="sb-fill-game" style="width:' + mp.toFixed(1) + '%"></div>' +
      '</div>' +
      '<div class="sb-side game"><span class="sb-label">Game</span><span class="sb-num">' + game + '</span></div>' +
    '</div>';
  }
  function itemMap(items) {
    var m = {};
    (items || []).forEach(function (it) { m[it.id] = it.text; });
    return m;
  }
  function boardHtml(map, order) {
    return (order || []).map(function (id, i) {
      return '<div class="rk-row" data-id="' + id + '">' +
        '<span class="rk-rank">' + (i + 1) + '</span>' +
        '<span class="rk-text">' + escapeHtml(map[id]) + '</span>' +
      '</div>';
    }).join('');
  }
  var boardReduceMotion = false;
  try { boardReduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  // Render the consensus board and, when it changes, play a FLIP animation so the
  // cards SLIDE into their new spots — mirroring the submitter's drag smoothly
  // instead of snapping.
  function renderBoard(order, animate) {
    var board = document.getElementById('dsBoard');
    if (!board) return;
    var prev = null;
    if (animate && !boardReduceMotion) {
      prev = {};
      var old = board.querySelectorAll('.rk-row');
      for (var i = 0; i < old.length; i++) prev[old[i].getAttribute('data-id')] = old[i].getBoundingClientRect().top;
    }
    board.innerHTML = boardHtml(dsMap, order);
    if (!prev) return;
    var rows = board.querySelectorAll('.rk-row');
    var moved = [];
    for (var j = 0; j < rows.length; j++) {
      var id = rows[j].getAttribute('data-id');
      if (prev[id] == null) continue;
      var delta = prev[id] - rows[j].getBoundingClientRect().top;
      if (delta) { rows[j].style.transition = 'none'; rows[j].style.transform = 'translateY(' + delta + 'px)'; moved.push(rows[j]); }
    }
    if (!moved.length) return;
    board.getBoundingClientRect(); // one reflow to commit the start offsets
    for (var k = 0; k < moved.length; k++) {
      moved[k].style.transition = 'transform 0.22s cubic-bezier(0.2, 0.7, 0.2, 1)';
      moved[k].style.transform = '';
    }
  }

  // ---- QR ----
  function renderQR() {
    fetch('/api/ranking/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var url = (cfg && cfg.joinUrl) || (window.location.origin + '/ranking/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      qrImg.src = '/api/ranking/qr?url=' + encodeURIComponent(url);
    }).catch(function () {
      var url = window.location.origin + '/ranking/join';
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      qrImg.src = '/api/ranking/qr?url=' + encodeURIComponent(url);
    });
  }

  // ---- Lobby ----
  var lastLobbyCount = -1;
  function renderLobby(s) {
    var players = (s && s.players) || [];
    if (lastLobbyCount >= 0 && players.length > lastLobbyCount) playDing();
    lastLobbyCount = players.length;
    playerCount.textContent = players.length;
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

  // Custom Words toggle (segmented Custom / Built-in)
  var customWordsTitle = document.getElementById('customWordsTitle');
  var customWordsSub = document.getElementById('customWordsSub');
  function setCustomWordsUI(on) {
    if (!customWordsSeg) return;
    Array.prototype.forEach.call(customWordsSeg.querySelectorAll('.seg-opt'), function (b) {
      b.classList.toggle('active', (b.getAttribute('data-cw') === 'on') === !!on);
    });
    if (customWordsTitle) customWordsTitle.textContent = on ? 'Custom words' : 'Built-in words';
    if (customWordsSub) {
      customWordsSub.textContent = on
        ? 'Players write the words/phrases (5 each) before the game starts.'
        : 'Uses the built-in word bank — no writing needed.';
    }
  }
  if (customWordsSeg) customWordsSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-opt');
    if (!btn) return;
    var on = btn.getAttribute('data-cw') === 'on';
    setCustomWordsUI(on); // optimistic
    socket.emit('host:setCustomWords', { on: on }, function (res) {
      if (res && res.ok) setCustomWordsUI(res.customWords);
    });
  });
  socket.on('state:customWords', function (p) { if (p) setCustomWordsUI(!!p.on); });

  // ---- Collect (Custom Words) ----
  var collectBarFill = document.getElementById('collectBarFill');
  function renderCollect(s) {
    show('collect');
    var players = (s && s.players) || [];
    var done = (s && typeof s.submitted === 'number') ? s.submitted : players.filter(function (p) { return p.submitted; }).length;
    var total = (s && typeof s.total === 'number') ? s.total : players.length;
    collectDone.textContent = done;
    collectTotal.textContent = total;
    if (collectBarFill) collectBarFill.style.width = (total > 0 ? (done / total * 100) : 0).toFixed(1) + '%';
    collectList.innerHTML = players.map(function (p) {
      var cls = 'collect-chip' + (p.submitted ? ' done' : '') + (p.connected ? '' : ' disconnected');
      var mark = p.submitted ? '✓' : '…';
      return '<div class="' + cls + '">' +
        '<span class="cc-mark">' + mark + '</span>' + escapeHtml(p.name) + '</div>';
    }).join('');
    // Host may start only when everyone has submitted and nobody is mid-edit.
    var ready = !!(s && s.ready) && total > 0;
    if (collectActions) collectActions.hidden = !ready;
    if (collectStartBtn) collectStartBtn.disabled = !ready;
  }

  if (collectStartBtn) collectStartBtn.addEventListener('click', function () {
    collectStartBtn.disabled = true;
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
      if (res && res.ok) { playStartFanfare(); return; }
      collectStartBtn.disabled = false;
    });
  });

  startBtn.addEventListener('click', function () {
    startError.hidden = true;
    startBtn.disabled = true;
    unlockAudio();
    socket.emit('host:start', {}, function (res) {
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
  function renderIntro(p) {
    syncClock(p);
    show('intro');
    var el = document.getElementById('introCountdown');
    var endsAt = (p && p.endsAt) || (serverNow() + 4000);
    function tick() {
      var left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (el) el.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0 && introTimer) { clearInterval(introTimer); introTimer = null; }
    }
    tick();
    if (introTimer) clearInterval(introTimer);
    introTimer = setInterval(tick, 200);
  }

  // ---- Rank (waiting) ----
  function renderRank(p) {
    show('rank');
    document.getElementById('rkRound').textContent = p.round;
    document.getElementById('rkTotal').textContent = p.totalRounds;
    document.getElementById('rkRanker').textContent = p.rankerName || 'Someone';
    document.getElementById('rankScoreboard').innerHTML = scoreboardHtml(p.groupScore || 0, p.gameScore || 0);
    playNewRound();  // audio cue so the room looks up for the new ranker
  }

  // ---- Discuss ----
  var dsMap = {};
  function renderDiscuss(p) {
    show('discuss');
    dsMap = itemMap(p.items);
    document.getElementById('dsRound').textContent = p.round;
    document.getElementById('dsTotal').textContent = p.totalRounds;
    document.getElementById('dsSubmitter').textContent = p.submitterName || 'Someone';
    document.getElementById('dsRanker').textContent = p.rankerName || 'The ranker';
    renderBoard(p.consensusOrder, false);
    document.getElementById('discussScoreboard').innerHTML = scoreboardHtml(p.groupScore || 0, p.gameScore || 0);
  }
  socket.on('state:consensus', function (p) {
    if (!p || !views.discuss.classList.contains('active')) return;
    renderBoard(p.consensusOrder, true);
  });

  // ---- Reveal ----
  function renderRevealTransition(p) {
    show('revealTransition');
    if (p) {
      document.getElementById('rtRound').textContent = p.round;
      document.getElementById('rtTotal').textContent = p.totalRounds;
    }
    playSuspense();
  }

  // Pill zoom-in lead-in: show the +Group/+Game pills alone & enlarged for a
  // beat, then zoom out to the full board. `revealZoomTimer` holds the pending
  // zoom-out; clearRevealZoom() cancels it and strips the focus classes.
  var revealZoomTimer = null;
  function clearRevealZoom() {
    if (revealZoomTimer) { clearTimeout(revealZoomTimer); revealZoomTimer = null; }
    var rv = views.reveal && views.reveal.querySelector('.reveal-view');
    if (rv) rv.classList.remove('reveal-focus', 'reveal-instant');
  }
  function startRevealZoom() {
    var rv = views.reveal && views.reveal.querySelector('.reveal-view');
    if (!rv) return;
    // Snap into the focused (pills-only) state without an entry animation…
    rv.classList.add('reveal-focus', 'reveal-instant');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        rv.classList.remove('reveal-instant');
        // …hold the zoomed-in pills, then zoom out to the full board.
        revealZoomTimer = setTimeout(function () {
          revealZoomTimer = null;
          rv.classList.remove('reveal-focus');
        }, 2000);
      });
    });
  }

  function renderReveal(r) {
    clearRevealZoom();
    syncClock(r);
    show('reveal');
    document.getElementById('rvRound').textContent = r.round;
    document.getElementById('rvTotal').textContent = r.totalRounds;
    document.getElementById('rvRanker').textContent = r.rankerName || 'the ranker';
    var map = itemMap(r.items);

    var head = '<div class="reveal-colhead">' +
      '<div class="rc-spacer"></div>' +
      '<div class="rc-h group">Group guessed</div>' +
      '<div class="rc-h ranker">' + escapeHtml(r.rankerName || 'Ranker') + ' ranked</div>' +
    '</div>';
    var rows = '';
    for (var i = 0; i < r.rankerOrder.length; i++) {
      var match = r.positions[i];
      rows += '<div class="reveal-row' + (match ? ' match' : '') + '">' +
        '<div class="rr-rank">' + (i + 1) + '</div>' +
        '<div class="rr-cell group">' + escapeHtml(map[r.consensusOrder[i]]) + '</div>' +
        '<div class="rr-cell ranker">' + escapeHtml(map[r.rankerOrder[i]]) + '</div>' +
      '</div>';
    }
    document.getElementById('rvCols').innerHTML = head + rows;

    document.getElementById('rvResult').innerHTML =
      '<div class="result-chip group">+' + r.groupPts + ' Group</div>' +
      '<div class="result-chip game">+' + r.gamePts + ' Game</div>';
    document.getElementById('revealScoreboard').innerHTML = scoreboardHtml(r.groupScore, r.gameScore);

    var nextBtn = document.getElementById('nextBtn');
    nextBtn.textContent = r.isLastRound ? 'See final result →' : 'Next round →';
    nextBtn.disabled = false;

    if (r.groupPts > r.gamePts) playChime();
    startRevealZoom();
  }

  document.getElementById('nextBtn').addEventListener('click', function () {
    var btn = document.getElementById('nextBtn');
    btn.disabled = true;
    socket.emit('host:next', {}, function () { btn.disabled = false; });
  });

  // ---- Final ----
  function renderFinal(f) {
    show('final');
    var win = !!f.playersWin;
    document.getElementById('finalBadge').textContent = win ? '🏆' : '🤖';
    var title = document.getElementById('finalTitle');
    title.textContent = win ? 'The group wins!' : 'The game wins!';
    title.className = 'final-title ' + (win ? 'win' : 'lose');
    document.getElementById('finalSub').textContent = win
      ? 'You read each other\'s minds and beat the game together.'
      : 'So close — the game edged you out this time. Run it back!';
    document.getElementById('finalScoreboard').innerHTML = scoreboardHtml(f.groupScore, f.gameScore);
    document.getElementById('finalRecap').innerHTML = (f.recap || []).map(function (row) {
      return '<div class="recap-row">' +
        '<div class="rp-round">R' + row.round + '</div>' +
        '<div class="rp-who">' + escapeHtml(row.rankerName || '—') + ' ranked</div>' +
        '<div class="rp-pts"><span class="g">+' + row.groupPts + '</span> / <span class="m">+' + row.gamePts + '</span></div>' +
      '</div>';
    }).join('');
    if (win) { playApplause(); playClapping(); launchConfetti(); } else { playSad(); }
  }

  // ---- Socket state ----
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      if (typeof res.minPlayers === 'number') MIN_PLAYERS = res.minPlayers;
      reactionsMuted = !!res.reactionsMuted;
      updateMuteBtn();
      if (typeof res.customWords === 'boolean') setCustomWordsUI(res.customWords);
      if (res.phase === 'LOBBY') { show('lobby'); renderLobby({ players: res.players }); }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
    renderQR();
  });
  socket.on('state:lobby', function (s) { if (s.phase === 'LOBBY') show('lobby'); renderLobby(s); });
  socket.on('state:collect', renderCollect);
  socket.on('state:intro', renderIntro);
  socket.on('state:rank', renderRank);
  socket.on('state:discuss', renderDiscuss);
  socket.on('state:revealTransition', renderRevealTransition);
  socket.on('state:reveal', renderReveal);
  socket.on('state:final', renderFinal);
  socket.on('state:reset', function () { show('lobby'); lastLobbyCount = -1; });

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

  // ---- Audio (Web Audio, matches the other games) ----
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
  function playStartFanfare() {
    var ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') { ctx.resume().catch(function () {}); if (ctx.state !== 'running') return; }
    var t0 = ctx.currentTime;
    var notes = [
      { freq: 523.25, start: 0.00, dur: 0.22 },
      { freq: 659.25, start: 0.14, dur: 0.22 },
      { freq: 783.99, start: 0.28, dur: 0.55 },
    ];
    notes.forEach(function (n) {
      [{ type: 'triangle', freq: n.freq, vol: 0.45 }, { type: 'sine', freq: n.freq * 0.5, vol: 0.18 }].forEach(function (layer) {
        var osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = layer.type; osc.frequency.value = layer.freq;
        var t = t0 + n.start;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(layer.vol, t + 0.015);
        gain.gain.setValueAtTime(layer.vol, t + n.dur - 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t); osc.stop(t + n.dur + 0.05);
      });
    });
  }
  function playDing() {
    var ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    var osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.4);
  }
  function playChime() {
    var ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    [659.25, 987.77].forEach(function (f, i) {
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'triangle'; osc.frequency.value = f;
      var st = t + i * 0.08;
      gain.gain.setValueAtTime(0.0001, st);
      gain.gain.exponentialRampToValueAtTime(0.22, st + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(st); osc.stop(st + 0.34);
    });
  }
  // Bright ascending arpeggio played when a new ranker is selected ("look up!").
  function playNewRound() {
    var ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'triangle'; osc.frequency.value = f;
      var st = t + i * 0.085;
      gain.gain.setValueAtTime(0.0001, st);
      gain.gain.exponentialRampToValueAtTime(0.26, st + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start(st); osc.stop(st + 0.44);
    });
  }
  // Rising anticipation swell for the pre-results "Let's see…" transition.
  function playSuspense() {
    var ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    var osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(330, t);
    osc.frequency.exponentialRampToValueAtTime(660, t + 1.6);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.2);
    gain.gain.setValueAtTime(0.16, t + 1.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t); osc.stop(t + 2.05);
  }
  function playApplause() {
    var ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
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
  // Real crowd applause on a group win — the same recording Trivia uses.
  var sfxApplause = document.getElementById('sfx-applause');
  function playClapping() {
    if (!sfxApplause) return;
    try { sfxApplause.currentTime = 0; sfxApplause.play().catch(function () {}); } catch (e) {}
  }
  function playSad() {
    var ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    [392, 349.23, 293.66].forEach(function (f, i) {
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = f;
      var st = t + i * 0.18;
      gain.gain.setValueAtTime(0.0001, st);
      gain.gain.exponentialRampToValueAtTime(0.18, st + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(st); osc.stop(st + 0.52);
    });
  }

  // ---- Confetti (group win) ----
  var confettiLayer = document.getElementById('confettiLayer');
  function launchConfetti() {
    if (!confettiLayer) return;
    var colors = ['#E0A21A', '#2FA37A', '#E15C4B', '#4E9E5B', '#F0C860', '#7be0b8', '#ffffff'];
    for (var i = 0; i < 150; i++) {
      var el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.left = (Math.random() * 100) + '%';
      el.style.background = colors[i % colors.length];
      el.style.setProperty('--dx', ((Math.random() * 2 - 1) * 180).toFixed(0) + 'px');
      el.style.setProperty('--rot', (720 + Math.random() * 720).toFixed(0) + 'deg');
      el.style.animationDuration = (2.6 + Math.random() * 1.9).toFixed(2) + 's';
      el.style.animationDelay = (Math.random() * 0.6).toFixed(2) + 's';
      if (Math.random() < 0.5) el.style.borderRadius = '50%';
      el.addEventListener('animationend', function () { if (this.parentNode) this.parentNode.removeChild(this); });
      confettiLayer.appendChild(el);
    }
  }

  ['click', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function once() {
      var ctx = getAudioCtx();
      if (ctx && ctx.state !== 'running') ctx.resume().catch(function () {});
      window.removeEventListener(ev, once);
    }, { once: true });
  });
})();
