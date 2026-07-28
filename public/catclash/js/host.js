/* ===== Category Clash · Host ===== */
(function () {
  'use strict';

  var socket = io('/catclash', { transports: ['polling', 'websocket'] });

  // ---- Clock sync ----
  var clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }
  function syncClock(p) { if (p && typeof p.serverNow === 'number') clockOffset = p.serverNow - Date.now(); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtClock(sec) {
    var s = Math.max(0, sec | 0);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  // ---- Views ----
  var views = {
    lobby: document.getElementById('view-lobby'),
    intro: document.getElementById('view-intro'),
    round: document.getElementById('view-round'),
    reviewing: document.getElementById('view-reviewing'),
    review: document.getElementById('view-review'),
    reveal: document.getElementById('view-reveal'),
    final: document.getElementById('view-final'),
  };
  var showTimer = null;
  var pendingView = null;
  function show(name) {
    var incoming = views[name];
    if (!incoming) return;
    if (pendingView === name) return;
    // Views can change faster than the 350ms crossfade (e.g. review → reveal →
    // final in one tick), so always sweep every other view, not just the one
    // that happened to be active when this call started.
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
  var startBtn = document.getElementById('startBtn');
  var startError = document.getElementById('startError');
  var roundsSelect = document.getElementById('roundsSelect');
  var timeSelect = document.getElementById('timeSelect');

  var roundLetter = document.getElementById('roundLetter');
  var roundLetterInline = document.getElementById('roundLetterInline');
  var roundNum = document.getElementById('roundNum');
  var roundTotal = document.getElementById('roundTotal');
  var timerRing = document.getElementById('timerRing');
  var timerText = document.getElementById('timerText');
  var catBoard = document.getElementById('catBoard');
  var doneCountEl = document.getElementById('doneCount');
  var doneTotalEl = document.getElementById('doneTotal');
  var endRoundBtn = document.getElementById('endRoundBtn');

  // ---- QR ----
  function renderQR() {
    fetch('/api/catclash/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var url = (cfg && cfg.joinUrl) || (window.location.origin + '/catclash/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      qrImg.src = '/api/catclash/qr?url=' + encodeURIComponent(url);
    }).catch(function () {
      var url = window.location.origin + '/catclash/join';
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      qrImg.src = '/api/catclash/qr?url=' + encodeURIComponent(url);
    });
  }

  // ---- Lobby ----
  var MIN_PLAYERS = 2;
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

  startBtn.addEventListener('click', function () {
    startError.hidden = true;
    startBtn.disabled = true;
    // Unlock audio on this user gesture so the fanfare can play on success.
    unlockAudio();
    socket.emit('host:start', {
      rounds: parseInt(roundsSelect.value, 10),
      timeLimitSec: parseInt(timeSelect.value, 10),
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

  // ---- Intro (letter reveal) ----
  var introTimer = null;
  function renderIntro(p) {
    syncClock(p);
    show('intro');
    stopRoundTimer();
    var letter = (p && p.letter) || '?';
    document.getElementById('introLetter').textContent = letter;
    document.getElementById('introRound').textContent =
      'Round ' + ((p && p.round) || 1) + ' of ' + ((p && p.totalRounds) || 1);
    // "Look up!" cue for every new letter after the opening fanfare.
    if (p && Number(p.round) > 1) playNextRoundCue();
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

  // ---- Round ----
  var roundRaf = null;
  function stopRoundTimer() { if (roundRaf) { cancelAnimationFrame(roundRaf); roundRaf = null; } }
  function renderRound(r) {
    if (!r) return;
    syncClock(r);
    stopRoundTimer();
    show('round');
    var letter = r.letter || '?';
    roundLetter.textContent = letter;
    roundLetterInline.textContent = letter;
    roundNum.textContent = r.round;
    roundTotal.textContent = r.totalRounds;
    catBoard.innerHTML = (r.categories || []).map(function (c, i) {
      return '<div class="cat-board-item"><span class="num">' + (i + 1) + '.</span>' +
             '<span class="txt">' + escapeHtml(c.text) + '</span></div>';
    }).join('');
    endRoundBtn.disabled = false;

    var totalMs = (r.timeLimitSec || 180) * 1000;
    var lastSec = -1, urgent = false;
    function update() {
      var msLeft = Math.max(0, r.endsAt - serverNow());
      var secLeft = Math.ceil(msLeft / 1000);
      timerRing.style.setProperty('--pct', Math.max(0, (msLeft / totalMs) * 100).toFixed(1));
      if (secLeft !== lastSec) {
        lastSec = secLeft;
        timerText.textContent = fmtClock(secLeft);
        var u = secLeft <= 15 && msLeft > 0;
        if (u !== urgent) { urgent = u; timerRing.classList.toggle('urgent', urgent); }
      }
      if (msLeft <= 0) { stopRoundTimer(); return; }
      roundRaf = requestAnimationFrame(update);
    }
    roundRaf = requestAnimationFrame(update);
  }

  socket.on('host:progress', function (p) {
    if (!p) return;
    doneCountEl.textContent = p.done;
    doneTotalEl.textContent = p.total;
  });

  endRoundBtn.addEventListener('click', function () {
    showConfirm('End the round now? Everyone stops writing.', 'End round', { danger: true }).then(function (ok) {
      if (!ok) return;
      endRoundBtn.disabled = true;
      socket.emit('host:next', {}, function (res) {
        if (!res || !res.ok) endRoundBtn.disabled = false;
      });
    });
  });

  // ---- Review (buckets + the "doesn't count" pile) ----
  var INVALID_ID = '__invalid__';
  var reviewGroups = [];     // [{id,label,autoMerged,mergeSource,members:[{playerId,name,raw}]}]
  var invalidMembers = [];   // [{playerId,name,raw,reason}]
  var reviewHistory = [];
  var selectedChip = null;   // {playerId, groupId} tap fallback
  var currentCatIdx = -1;

  var reviewGrid = document.getElementById('reviewGrid');
  var reviewStatus = document.getElementById('reviewStatus');
  var reviewRound = document.getElementById('reviewRound');
  var reviewCat = document.getElementById('reviewCat');
  var reviewCatNum = document.getElementById('reviewCatNum');
  var reviewCatTotal = document.getElementById('reviewCatTotal');
  var reviewLetter = document.getElementById('reviewLetter');
  var reviewProgressText = document.getElementById('reviewProgressText');
  var reviewProgressBar = document.getElementById('reviewProgressBar');
  var scoreBtn = document.getElementById('scoreBtn');
  var undoBtn = document.getElementById('undoBtn');
  var newBucketZone = document.getElementById('newBucketZone');
  var invalidPanel = document.getElementById('invalidPanel');
  var invalidList = document.getElementById('invalidList');
  var invalidCount = document.getElementById('invalidCount');
  var blanksNote = document.getElementById('blanksNote');
  var gid = 0;
  function nextGid() { return 'h' + (gid++) + '_' + Date.now().toString(36); }

  function renderReviewing(p) {
    show('reviewing');
    stopRoundTimer();
    playTimeUpCue();
    currentCatIdx = -1;
    reviewGrid.innerHTML = '';
    invalidList.innerHTML = '';
    reviewGroups = [];
    invalidMembers = [];
    reviewHistory = [];
    selectedChip = null;
    reviewStatus.innerHTML = '<span class="spinner-sm"></span> Grouping answers…';
    scoreBtn.disabled = true;
    undoBtn.disabled = true;
    if (p) {
      reviewRound.textContent = p.round || '';
      reviewLetter.textContent = p.letter || '?';
      reviewCatTotal.textContent = p.total || 12;
    }
  }
  socket.on('state:reviewing', renderReviewing);

  socket.on('state:review', function (p) {
    if (!p) return;
    show('review');
    var isNewCategory = p.catIdx !== currentCatIdx;
    currentCatIdx = p.catIdx;
    reviewRound.textContent = p.round;
    reviewLetter.textContent = p.letter || '?';
    reviewCat.textContent = p.category || '';
    reviewCatNum.textContent = (p.catIdx + 1);
    reviewCatTotal.textContent = p.total;
    reviewProgressText.textContent = (p.catIdx + 1) + ' / ' + p.total;
    reviewProgressBar.style.width = (((p.catIdx) / p.total) * 100).toFixed(1) + '%';

    reviewGroups = (p.buckets || []).map(function (g) {
      return {
        id: g.id || nextGid(),
        label: g.label || '(answer)',
        autoMerged: !!g.autoMerged,
        mergeSource: g.mergeSource || null,
        members: (g.members || []).map(function (m) {
          return { playerId: m.playerId, name: m.name, raw: m.raw || '' };
        }),
      };
    });
    invalidMembers = (p.invalid || []).map(function (m) {
      return { playerId: m.playerId, name: m.name, raw: m.raw || '', reason: m.reason || null };
    });
    reviewHistory = [];
    selectedChip = null;
    undoBtn.disabled = true;

    var answered = reviewGroups.reduce(function (n, g) { return n + g.members.length; }, 0) + invalidMembers.length;
    reviewStatus.textContent = answered + (answered === 1 ? ' answer' : ' answers') +
      ' · only a bucket with one name scores';
    scoreBtn.disabled = false;

    var blanks = p.blanks || [];
    if (blanks.length) {
      blanksNote.hidden = false;
      blanksNote.innerHTML = '<strong>Left blank (' + blanks.length + '):</strong> ' +
        blanks.map(function (b) { return escapeHtml(b.name); }).join(', ');
    } else {
      blanksNote.hidden = true;
      blanksNote.innerHTML = '';
    }

    if (isNewCategory) playPageTurn();
    renderReviewGrid();
  });

  socket.on('state:reviewProgress', function () { /* host drives this */ });

  function snapshot() {
    reviewHistory.push(JSON.stringify({ g: reviewGroups, i: invalidMembers }));
    if (reviewHistory.length > 50) reviewHistory.shift();
    undoBtn.disabled = false;
  }
  undoBtn.addEventListener('click', function () {
    if (!reviewHistory.length) return;
    var snap = JSON.parse(reviewHistory.pop());
    reviewGroups = snap.g;
    invalidMembers = snap.i;
    if (!reviewHistory.length) undoBtn.disabled = true;
    selectedChip = null;
    renderReviewGrid();
  });

  function findGroup(id) { return reviewGroups.find(function (g) { return g.id === id; }); }
  function removeMember(list, playerId) {
    var i = list.findIndex(function (m) { return m.playerId === playerId; });
    if (i < 0) return null;
    return list.splice(i, 1)[0];
  }
  function takeMember(fromId, playerId) {
    if (fromId === INVALID_ID) return removeMember(invalidMembers, playerId);
    var from = findGroup(fromId);
    return from ? removeMember(from.members, playerId) : null;
  }
  function pruneEmpty() {
    reviewGroups = reviewGroups.filter(function (g) { return g.members.length > 0; });
  }
  function moveChip(playerId, fromId, toId) {
    if (fromId === toId) return;
    if (toId !== INVALID_ID && !findGroup(toId)) return;
    snapshot();
    var m = takeMember(fromId, playerId);
    if (!m) { reviewHistory.pop(); return; }
    if (toId === INVALID_ID) {
      m.reason = 'host';
      invalidMembers.push(m);
    } else {
      delete m.reason;
      findGroup(toId).members.push(m);
    }
    pruneEmpty();
    renderReviewGrid();
  }
  function splitChip(playerId, fromId) {
    if (fromId !== INVALID_ID) {
      var from = findGroup(fromId);
      if (!from || from.members.length <= 1) return; // already alone
    }
    snapshot();
    var m = takeMember(fromId, playerId);
    if (!m) { reviewHistory.pop(); return; }
    delete m.reason;
    reviewGroups.push({ id: nextGid(), label: m.raw || '(answer)', autoMerged: false, mergeSource: null, members: [m] });
    pruneEmpty();
    renderReviewGrid();
  }
  function mergeGroups(srcId, dstId) {
    if (srcId === dstId) return;
    var src = findGroup(srcId), dst = findGroup(dstId);
    if (!src || !dst) return;
    snapshot();
    dst.members = dst.members.concat(src.members);
    reviewGroups = reviewGroups.filter(function (g) { return g.id !== srcId; });
    renderReviewGrid();
  }
  function cardToInvalid(srcId) {
    var src = findGroup(srcId);
    if (!src) return;
    snapshot();
    src.members.forEach(function (m) { m.reason = 'host'; invalidMembers.push(m); });
    reviewGroups = reviewGroups.filter(function (g) { return g.id !== srcId; });
    renderReviewGrid();
  }
  function renameGroup(id, label) {
    var g = findGroup(id);
    if (!g) return;
    var clean = String(label || '').trim().slice(0, 60);
    if (!clean || clean === g.label) return;
    snapshot();
    g.label = clean;
  }

  var REASON_TEXT = { letter: 'letter', category: 'AI', host: 'you' };
  function chipHtml(m, groupId, extra) {
    var sel = (selectedChip && selectedChip.playerId === m.playerId) ? ' selected' : '';
    var word = m.raw
      ? '<span class="chip-word">' + escapeHtml(m.raw) + '</span>'
      : '<span class="chip-word">(blank)</span>';
    return '<div class="chip' + sel + '" draggable="true" data-pid="' + escapeHtml(m.playerId) + '" ' +
             'data-gid="' + escapeHtml(groupId) + '">' +
             '<span class="chip-name">' + escapeHtml(m.name) + '</span>' + word + (extra || '') +
           '</div>';
  }

  function renderReviewGrid() {
    reviewGrid.innerHTML = reviewGroups.map(function (g) {
      var badge = g.autoMerged
        ? '<span class="bucket-badge">' + (g.mergeSource === 'ai' ? 'AI' : 'auto') + '</span>'
        : '';
      var chips = g.members.map(function (m) { return chipHtml(m, g.id, ''); }).join('');
      var cls = 'bucket-card' + (g.members.length === 1 ? ' scoring' : ' dupe');
      return '<div class="' + cls + '" draggable="true" data-gid="' + escapeHtml(g.id) + '">' +
               '<div class="bucket-head">' +
                 '<span class="bucket-label" data-gid="' + escapeHtml(g.id) + '" title="Double-click to rename">' + escapeHtml(g.label) + '</span>' +
                 badge +
                 '<span class="bucket-count">' + g.members.length + '</span>' +
               '</div>' +
               '<div class="bucket-chips">' + chips + '</div>' +
             '</div>';
    }).join('');

    invalidList.innerHTML = invalidMembers.map(function (m) {
      var reason = m.reason ? '<span class="reason">' + escapeHtml(REASON_TEXT[m.reason] || m.reason) + '</span>' : '';
      return chipHtml(m, INVALID_ID, reason);
    }).join('');
    invalidCount.textContent = invalidMembers.length;
  }

  // ---- Drag & drop ----
  var dragData = null;
  function clearDragMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('.dragging, .drop-target'), function (el) {
      el.classList.remove('dragging');
      el.classList.remove('drop-target');
    });
  }
  function onDragStart(e) {
    var chip = e.target.closest('.chip');
    if (chip) {
      e.stopPropagation();
      dragData = { type: 'chip', playerId: chip.getAttribute('data-pid'), groupId: chip.getAttribute('data-gid') };
      chip.classList.add('dragging');
      return;
    }
    var card = e.target.closest('.bucket-card');
    if (card) {
      dragData = { type: 'card', groupId: card.getAttribute('data-gid') };
      card.classList.add('dragging');
    }
  }
  reviewGrid.addEventListener('dragstart', onDragStart);
  invalidList.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragend', function () { dragData = null; clearDragMarks(); });

  reviewGrid.addEventListener('dragover', function (e) {
    if (!dragData) return;
    var card = e.target.closest('.bucket-card');
    if (!card) return;
    e.preventDefault();
    if (card.getAttribute('data-gid') !== dragData.groupId) card.classList.add('drop-target');
  });
  reviewGrid.addEventListener('dragleave', function (e) {
    var card = e.target.closest('.bucket-card');
    if (card) card.classList.remove('drop-target');
  });
  reviewGrid.addEventListener('drop', function (e) {
    if (!dragData) return;
    var card = e.target.closest('.bucket-card');
    if (!card) return;
    e.preventDefault();
    var toId = card.getAttribute('data-gid');
    var d = dragData; dragData = null;
    clearDragMarks();
    if (d.type === 'chip') moveChip(d.playerId, d.groupId, toId);
    else if (d.type === 'card') mergeGroups(d.groupId, toId);
  });

  invalidPanel.addEventListener('dragover', function (e) {
    if (!dragData || dragData.groupId === INVALID_ID) return;
    e.preventDefault();
    invalidPanel.classList.add('drop-target');
  });
  invalidPanel.addEventListener('dragleave', function (e) {
    if (!invalidPanel.contains(e.relatedTarget)) invalidPanel.classList.remove('drop-target');
  });
  invalidPanel.addEventListener('drop', function (e) {
    if (!dragData || dragData.groupId === INVALID_ID) return;
    e.preventDefault();
    var d = dragData; dragData = null;
    clearDragMarks();
    if (d.type === 'chip') moveChip(d.playerId, d.groupId, INVALID_ID);
    else if (d.type === 'card') cardToInvalid(d.groupId);
  });

  newBucketZone.addEventListener('dragover', function (e) {
    if (dragData && dragData.type === 'chip') { e.preventDefault(); newBucketZone.classList.add('drop-target'); }
  });
  newBucketZone.addEventListener('dragleave', function () { newBucketZone.classList.remove('drop-target'); });
  newBucketZone.addEventListener('drop', function (e) {
    if (!dragData || dragData.type !== 'chip') return;
    e.preventDefault();
    var d = dragData; dragData = null;
    clearDragMarks();
    splitChip(d.playerId, d.groupId);
  });

  // ---- Tap fallback: select a chip, then tap a target ----
  function onChipClick(e) {
    var chip = e.target.closest('.chip');
    if (!chip) return false;
    var pid = chip.getAttribute('data-pid');
    var g = chip.getAttribute('data-gid');
    if (selectedChip && selectedChip.playerId === pid) selectedChip = null;
    else selectedChip = { playerId: pid, groupId: g };
    renderReviewGrid();
    return true;
  }
  reviewGrid.addEventListener('click', function (e) {
    if (onChipClick(e)) return;
    if (!selectedChip) return;
    var card = e.target.closest('.bucket-card');
    if (!card) return;
    var sel = selectedChip; selectedChip = null;
    moveChip(sel.playerId, sel.groupId, card.getAttribute('data-gid'));
  });
  invalidPanel.addEventListener('click', function (e) {
    if (onChipClick(e)) return;
    if (!selectedChip || selectedChip.groupId === INVALID_ID) return;
    var sel = selectedChip; selectedChip = null;
    moveChip(sel.playerId, sel.groupId, INVALID_ID);
  });
  newBucketZone.addEventListener('click', function () {
    if (!selectedChip) return;
    var sel = selectedChip; selectedChip = null;
    splitChip(sel.playerId, sel.groupId);
  });

  // ---- Rename (double-click the label) ----
  reviewGrid.addEventListener('dblclick', function (e) {
    var label = e.target.closest('.bucket-label');
    if (!label) return;
    var id = label.getAttribute('data-gid');
    var g = findGroup(id);
    if (!g) return;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'bucket-label-input';
    input.value = g.label;
    input.maxLength = 60;
    label.replaceWith(input);
    input.focus();
    input.select();
    function commit() {
      renameGroup(id, input.value);
      renderReviewGrid();
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      else if (ev.key === 'Escape') { input.value = g.label; input.blur(); }
    });
  });

  scoreBtn.addEventListener('click', function () {
    if (currentCatIdx < 0) return;
    scoreBtn.disabled = true;
    var buckets = reviewGroups.map(function (g) {
      return {
        id: g.id,
        label: g.label,
        members: g.members.map(function (m) { return { playerId: m.playerId }; }),
      };
    });
    var invalid = invalidMembers.map(function (m) { return m.playerId; });
    socket.emit('host:scoreCategory', { catIdx: currentCatIdx, buckets: buckets, invalid: invalid }, function (res) {
      if (!res || !res.ok) scoreBtn.disabled = false;
    });
  });

  // ---- Reveal (round scoreboard) ----
  var revealBoard = document.getElementById('revealBoard');
  var nextBtn = document.getElementById('nextBtn');
  function renderReveal(r) {
    if (!r) return;
    syncClock(r);
    show('reveal');
    document.getElementById('revealRound').textContent = r.round;
    document.getElementById('revealLetter').textContent = r.letter || '?';
    document.getElementById('revealSub').textContent = r.isLastRound
      ? 'That was the final round!'
      : 'Round ' + (r.round + 1) + ' of ' + r.totalRounds + ' is next';
    revealBoard.innerHTML = (r.board || []).map(function (e) {
      var gainCls = e.roundPoints > 0 ? 'gain' : 'gain zero';
      return '<div class="sb-row">' +
               '<div class="rank">' + e.rank + '</div>' +
               '<div class="name">' + escapeHtml(e.name) + '</div>' +
               '<div class="' + gainCls + '">+' + e.roundPoints + '</div>' +
               '<div class="score">' + e.score + '</div>' +
             '</div>';
    }).join('');
    nextBtn.textContent = r.isLastRound ? 'See final results →' : 'Next round →';
    nextBtn.disabled = false;
    playChime();
  }
  nextBtn.addEventListener('click', function () {
    nextBtn.disabled = true;
    socket.emit('host:next', {}, function (res) {
      if (!res || !res.ok) nextBtn.disabled = false;
    });
  });

  function renderLeaderboardInto(el, lb, limit) {
    lb = (lb || []).slice(0, limit || lb.length);
    el.innerHTML = lb.map(function (e) {
      return '<div class="lb-row">' +
               '<div class="rank">' + e.rank + '</div>' +
               '<div class="name">' + escapeHtml(e.name) + '</div>' +
               '<div class="score">' + e.score + '</div>' +
             '</div>';
    }).join('');
  }

  // ---- Final ----
  function podiumCell(klass, medal, group) {
    if (!group) return '<div class="podium-step ' + klass + ' empty-slot"></div>';
    var tied = group.players.length > 1;
    var visible = group.players.slice(0, 2);
    var overflow = group.players.length - visible.length;
    var names = '<div class="names-list">' +
      visible.map(function (p) { return '<div class="name">' + escapeHtml(p.name) + '</div>'; }).join('') +
      (overflow > 0 ? '<div class="more-count">…and ' + overflow + ' more</div>' : '') +
      '</div>';
    var pill = tied ? '<div class="tie-pill">TIE</div>' : '';
    return '<div class="podium-step ' + klass + (tied ? ' tied' : '') + '">' + pill +
             '<div class="medal">' + medal + '</div>' + names +
             '<div class="score">' + group.score + ' pts</div>' +
           '</div>';
  }
  function renderFinal(f) {
    show('final');
    var title = document.getElementById('finalTitle');
    var intro = document.getElementById('resultsIntro');
    if (f && f.winnerName) {
      title.textContent = '🏆 ' + f.winnerName + ' wins!';
      intro.textContent = 'Most unique answers over ' + f.totalRounds +
        (f.totalRounds === 1 ? ' round' : ' rounds') + '.';
    } else {
      title.textContent = '📝 It\'s a tie!';
      intro.textContent = 'Nobody could be separated at the top.';
    }
    var g = (f && f.podiumGroups) || [];
    document.getElementById('podium').innerHTML =
      podiumCell('place-2', '🥈', g[1]) +
      podiumCell('place-1', '🥇', g[0]) +
      podiumCell('place-3', '🥉', g[2]);
    renderLeaderboardInto(document.getElementById('fullLb'), (f && f.fullLeaderboard) || [], 999);
    playApplause();
    burstConfetti();
  }

  // ---- Confetti ----
  var confettiLayer = document.getElementById('confettiLayer');
  function burstConfetti() {
    if (!confettiLayer) return;
    var colors = ['#E4572E', '#F5B301', '#3FA96B', '#FFFFFF', '#B33C17'];
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
      if (typeof res.totalRounds === 'number' && roundsSelect) roundsSelect.value = String(res.totalRounds);
      if (typeof res.timeLimitSec === 'number' && timeSelect) timeSelect.value = String(res.timeLimitSec);
      if (res.phase === 'LOBBY') { show('lobby'); renderLobby({ players: res.players, total: (res.players || []).length }); }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
    renderQR();
  });
  socket.on('state:lobby', function (s) { if (s && s.phase === 'LOBBY') show('lobby'); renderLobby(s); });
  socket.on('state:intro', renderIntro);
  socket.on('state:round', renderRound);
  socket.on('state:reveal', renderReveal);
  socket.on('state:final', renderFinal);
  socket.on('state:reset', function () {
    stopRoundTimer();
    if (introTimer) { clearInterval(introTimer); introTimer = null; }
    show('lobby');
    lastLobbyCount = -1;
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
  // Cheerful rising C-E-G fanfare on game start.
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
  // Rising "look up!" arpeggio for each new round's letter reveal.
  function playNextRoundCue() {
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
  // Descending buzz-free "pens down" chime when the writing window closes.
  function playTimeUpCue() {
    playNotes([
      { freq: 880.00, start: 0.00, dur: 0.30 },
      { freq: 659.25, start: 0.18, dur: 0.34 },
      { freq: 493.88, start: 0.36, dur: 0.55 },
    ], function (n) {
      return [
        { type: 'sine', freq: n.freq, vol: 0.42 },
        { type: 'triangle', freq: n.freq * 2, vol: 0.07 },
      ];
    });
  }
  // Soft click when the host moves to the next category during review.
  function playPageTurn() {
    playNotes([{ freq: 1046.5, start: 0.00, dur: 0.11 }], function (n) {
      return [{ type: 'sine', freq: n.freq, vol: 0.16 }];
    });
  }
  // Reveal chime for the round scoreboard.
  function playChime() {
    playNotes([
      { freq: 783.99, start: 0.00, dur: 0.26 },
      { freq: 1046.50, start: 0.16, dur: 0.55 },
    ], function (n) {
      return [
        { type: 'sine', freq: n.freq, vol: 0.42 },
        { type: 'triangle', freq: n.freq * 2, vol: 0.08 },
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
