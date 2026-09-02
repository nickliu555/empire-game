/* ===== Herd Mind · Host ===== */
(function () {
  'use strict';

  var socket = io('/herdmind', { transports: ['polling', 'websocket'] });

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
    question: document.getElementById('view-question'),
    review: document.getElementById('view-review'),
    reveal: document.getElementById('view-reveal'),
    final: document.getElementById('view-final'),
  };
  function show(name) {
    var currentName = Object.keys(views).find(function (k) { return views[k].classList.contains('active'); });
    if (currentName === name) return;
    var incoming = views[name];
    if (!incoming) return;
    var outgoing = currentName ? views[currentName] : null;
    if (outgoing) {
      outgoing.classList.add('fading-out');
      setTimeout(function () {
        outgoing.classList.remove('active');
        outgoing.classList.remove('fading-out');
        incoming.classList.add('active');
      }, 350);
    } else {
      incoming.classList.add('active');
    }
  }

  // ---- Element refs ----
  var qrImg = document.getElementById('qrImg');
  var joinUrlEl = document.getElementById('joinUrl');
  var playerList = document.getElementById('playerList');
  var playerCount = document.getElementById('playerCount');
  var startBtn = document.getElementById('startBtn');
  var startError = document.getElementById('startError');
  var timeSelect = document.getElementById('timeSelect');
  var targetSelect = document.getElementById('targetSelect');
  var autoAdvanceCheck = document.getElementById('autoAdvanceCheck');

  var qRound = document.getElementById('qRound');
  var qTarget = document.getElementById('qTarget');
  var qPrompt = document.getElementById('qPrompt');
  var timerRing = document.getElementById('timerRing');
  var timerText = document.getElementById('timerText');
  var answersReceived = document.getElementById('answersReceived');
  var answersTotal = document.getElementById('answersTotal');

  // ---- QR ----
  function renderQR() {
    fetch('/api/herdmind/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var url = (cfg && cfg.joinUrl) || (window.location.origin + '/herdmind/join');
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      qrImg.src = '/api/herdmind/qr?url=' + encodeURIComponent(url);
    }).catch(function () {
      var url = window.location.origin + '/herdmind/join';
      joinUrlEl.textContent = url.replace(/^https?:\/\//, '');
      qrImg.src = '/api/herdmind/qr?url=' + encodeURIComponent(url);
    });
  }

  // ---- Lobby ----
  var MIN_PLAYERS = 3;
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
    if (typeof s.total === 'number') answersTotal.textContent = s.total;
    // Match the other games: just gray out Start until the minimum is met.
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
      timeLimitSec: parseInt(timeSelect.value, 10),
      targetScore: parseInt(targetSelect.value, 10),
      autoAdvance: autoAdvanceCheck.checked,
    }, function (res) {
      startBtn.disabled = false;
      if (!res || !res.ok) {
        startError.textContent = (res && res.reason === 'not-enough-players')
          ? 'Need at least 3 players to start'
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

  // ---- Question timer ----
  var qRaf = null;
  function stopQTimer() { if (qRaf) { cancelAnimationFrame(qRaf); qRaf = null; } }
  function renderQuestion(q) {
    syncClock(q);
    stopQTimer();
    qRound.textContent = q.round;
    qTarget.textContent = q.target;
    qPrompt.textContent = q.text;
    answersReceived.textContent = '0';
    show('question');
    // Chime players to look up at the host screen for each new question after
    // the first (the first question follows the intro fanfare).
    if (q && Number(q.round) > 1) playNextQuestionCue();
    var totalMs = q.timeLimitSec * 1000;
    var lastSec = -1, urgent = false;
    function update() {
      var msLeft = Math.max(0, q.endsAt - serverNow());
      var secLeft = Math.ceil(msLeft / 1000);
      var pct = Math.max(0, (msLeft / totalMs) * 100);
      timerRing.style.setProperty('--pct', pct.toFixed(1));
      if (secLeft !== lastSec) {
        lastSec = secLeft;
        timerText.textContent = String(secLeft);
        var u = secLeft <= 5 && msLeft > 0;
        if (u !== urgent) { urgent = u; timerRing.classList.toggle('urgent', urgent); }
      }
      if (msLeft <= 0) { stopQTimer(); return; }
      qRaf = requestAnimationFrame(update);
    }
    qRaf = requestAnimationFrame(update);
  }

  socket.on('host:answerCount', function (p) {
    if (!p) return;
    answersReceived.textContent = p.answered;
    answersTotal.textContent = p.total;
  });

  // ---- Review (merge / split / rename) ----
  var reviewGroups = [];   // [{id,label,autoMerged,mergeSource,members:[{playerId,name,raw}]}]
  var reviewHistory = [];
  var selectedChip = null; // {playerId, groupId} for tap fallback
  var reviewGrid = document.getElementById('reviewGrid');
  var reviewStatus = document.getElementById('reviewStatus');
  var reviewRound = document.getElementById('reviewRound');
  var reviewQ = document.getElementById('reviewQ');
  var scoreBtn = document.getElementById('scoreBtn');
  var undoBtn = document.getElementById('undoBtn');
  var newBucketZone = document.getElementById('newBucketZone');
  var gid = 0;
  function nextGid() { return 'h' + (gid++) + '_' + Date.now().toString(36); }

  function renderReviewing(round) {
    show('review');
    if (reviewRound) reviewRound.textContent = round || '';
    reviewGrid.innerHTML = '';
    reviewGroups = [];
    reviewHistory = [];
    selectedChip = null;
    reviewStatus.innerHTML = '<span class="spinner-sm"></span> Grouping answers…';
    scoreBtn.disabled = true;
    undoBtn.disabled = true;
  }

  socket.on('state:reviewing', function (p) { renderReviewing(p && p.round); });

  socket.on('state:review', function (p) {
    show('review');
    if (reviewRound) reviewRound.textContent = (p && p.round) || '';
    if (reviewQ) reviewQ.textContent = (p && p.questionText) || '';
    reviewGroups = ((p && p.groups) || []).map(function (g) {
      return {
        id: g.id || nextGid(),
        label: g.label || '(answer)',
        autoMerged: !!g.autoMerged,
        mergeSource: g.mergeSource || null,
        members: (g.members || []).map(function (m) { return { playerId: m.playerId, name: m.name, raw: m.raw || '' }; }),
      };
    });
    reviewHistory = [];
    selectedChip = null;
    undoBtn.disabled = true;
    var n = (p && p.total) || 0;
    reviewStatus.textContent = n + (n === 1 ? ' answer in' : ' answers in') + ' · review the buckets, then score';
    scoreBtn.disabled = false;
    renderReviewGrid();
  });

  function snapshot() {
    reviewHistory.push(JSON.stringify(reviewGroups));
    if (reviewHistory.length > 50) reviewHistory.shift();
    undoBtn.disabled = false;
  }
  undoBtn.addEventListener('click', function () {
    if (!reviewHistory.length) return;
    reviewGroups = JSON.parse(reviewHistory.pop());
    if (!reviewHistory.length) undoBtn.disabled = true;
    selectedChip = null;
    renderReviewGrid();
  });

  function findGroup(id) { return reviewGroups.find(function (g) { return g.id === id; }); }
  function removeMember(group, playerId) {
    var i = group.members.findIndex(function (m) { return m.playerId === playerId; });
    if (i < 0) return null;
    return group.members.splice(i, 1)[0];
  }
  function pruneEmpty() {
    reviewGroups = reviewGroups.filter(function (g) { return g.members.length > 0; });
  }
  function moveChip(playerId, fromId, toId) {
    if (fromId === toId) return;
    var from = findGroup(fromId), to = findGroup(toId);
    if (!from || !to) return;
    snapshot();
    var m = removeMember(from, playerId);
    if (m) to.members.push(m);
    pruneEmpty();
    renderReviewGrid();
  }
  function splitChip(playerId, fromId) {
    var from = findGroup(fromId);
    if (!from || from.members.length <= 1) return; // already alone
    snapshot();
    var m = removeMember(from, playerId);
    if (m) {
      reviewGroups.push({ id: nextGid(), label: m.raw || '(answer)', autoMerged: false, mergeSource: null, members: [m] });
    }
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
  function renameGroup(id, label) {
    var g = findGroup(id);
    if (!g) return;
    var clean = String(label || '').trim().slice(0, 60);
    if (!clean || clean === g.label) return;
    snapshot();
    g.label = clean;
  }

  function leadingGroupId() {
    var maxSize = 0;
    for (var i = 0; i < reviewGroups.length; i++) if (reviewGroups[i].members.length > maxSize) maxSize = reviewGroups[i].members.length;
    if (maxSize < 2) return null;
    var atMax = reviewGroups.filter(function (g) { return g.members.length === maxSize; });
    return atMax.length === 1 ? atMax[0].id : null;
  }

  function renderReviewGrid() {
    var leadId = leadingGroupId();
    reviewGrid.innerHTML = reviewGroups.map(function (g) {
      var badge = g.autoMerged
        ? '<span class="bucket-badge">' + (g.mergeSource === 'ai' ? 'AI' : 'auto') + '</span>'
        : '';
      var chips = g.members.map(function (m) {
        var word = m.raw
          ? '<span class="chip-word">' + escapeHtml(m.raw) + '</span>'
          : '<span class="chip-word blank">(no answer)</span>';
        var sel = (selectedChip && selectedChip.playerId === m.playerId) ? ' selected' : '';
        return '<div class="chip' + sel + '" draggable="true" data-pid="' + escapeHtml(m.playerId) + '" data-gid="' + escapeHtml(g.id) + '">' +
                 '<span class="chip-name">' + escapeHtml(m.name) + '</span>' + word +
               '</div>';
      }).join('');
      var lead = (g.id === leadId) ? ' leading' : '';
      return '<div class="bucket-card' + lead + '" draggable="true" data-gid="' + escapeHtml(g.id) + '">' +
               '<div class="bucket-head">' +
                 '<span class="bucket-label" data-gid="' + escapeHtml(g.id) + '" title="Double-click to rename">' + escapeHtml(g.label) + '</span>' +
                 badge +
                 '<span class="bucket-count">' + g.members.length + '</span>' +
               '</div>' +
               '<div class="bucket-chips">' + chips + '</div>' +
             '</div>';
    }).join('');
  }

  // Drag & drop
  var dragData = null;
  reviewGrid.addEventListener('dragstart', function (e) {
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
  });
  reviewGrid.addEventListener('dragend', function () {
    dragData = null;
    Array.prototype.forEach.call(reviewGrid.querySelectorAll('.dragging'), function (el) { el.classList.remove('dragging'); });
    Array.prototype.forEach.call(reviewGrid.querySelectorAll('.drop-target'), function (el) { el.classList.remove('drop-target'); });
    newBucketZone.classList.remove('drop-target');
  });
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
    if (dragData.type === 'chip') moveChip(dragData.playerId, dragData.groupId, toId);
    else if (dragData.type === 'card') mergeGroups(dragData.groupId, toId);
    dragData = null;
  });
  newBucketZone.addEventListener('dragover', function (e) {
    if (dragData && dragData.type === 'chip') { e.preventDefault(); newBucketZone.classList.add('drop-target'); }
  });
  newBucketZone.addEventListener('dragleave', function () { newBucketZone.classList.remove('drop-target'); });
  newBucketZone.addEventListener('drop', function (e) {
    if (dragData && dragData.type === 'chip') { e.preventDefault(); splitChip(dragData.playerId, dragData.groupId); }
    newBucketZone.classList.remove('drop-target');
    dragData = null;
  });

  // Tap fallback: select a chip, then tap a card to move it (or new-bucket to split).
  reviewGrid.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) {
      var pid = chip.getAttribute('data-pid');
      var g = chip.getAttribute('data-gid');
      if (selectedChip && selectedChip.playerId === pid) selectedChip = null;
      else selectedChip = { playerId: pid, groupId: g };
      renderReviewGrid();
      return;
    }
    if (!selectedChip) return;
    var card = e.target.closest('.bucket-card');
    if (card) {
      var toId = card.getAttribute('data-gid');
      var sel = selectedChip; selectedChip = null;
      moveChip(sel.playerId, sel.groupId, toId);
    }
  });
  newBucketZone.addEventListener('click', function () {
    if (!selectedChip) return;
    var sel = selectedChip; selectedChip = null;
    splitChip(sel.playerId, sel.groupId);
  });

  // Rename (double-click the label)
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
    scoreBtn.disabled = true;
    var payload = reviewGroups.map(function (g) {
      return { id: g.id, label: g.label, members: g.members.map(function (m) { return { playerId: m.playerId }; }) };
    });
    socket.emit('host:score', { groups: payload }, function (res) {
      if (!res || !res.ok) { scoreBtn.disabled = false; }
    });
  });

  // ---- Reveal ----
  var HERD_VISIBLE_MAX = 8;
  var autoAdvRaf = null;
  function stopAutoAdv() { if (autoAdvRaf) { cancelAnimationFrame(autoAdvRaf); autoAdvRaf = null; } }
  function renderReveal(r) {
    syncClock(r);
    stopAutoAdv();
    show('reveal');
    document.getElementById('rvRound').textContent = r.round;
    document.getElementById('rvQ').textContent = r.questionText || '';
    document.getElementById('rvTarget').textContent = r.target;

    // Cow banner
    var cowBanner = document.getElementById('cowBanner');
    if (r.cowMovedTo && r.cowHolderName) {
      cowBanner.hidden = false;
      cowBanner.textContent = '🐄 ' + r.cowHolderName + ' takes the Pink Cow';
    } else if (r.cowHolderName) {
      cowBanner.hidden = false;
      cowBanner.textContent = '🐄 ' + r.cowHolderName + ' is still holding the Pink Cow';
    } else {
      cowBanner.hidden = true;
    }

    // Herd bars
    var groups = (r.groups || []).slice();
    var maxSize = groups.reduce(function (a, g) { return Math.max(a, g.size); }, 1);
    var visible = groups.slice(0, HERD_VISIBLE_MAX);
    // Always surface the Pink Cow's bucket even if it falls past the cutoff.
    if (r.cowMovedTo) {
      var inView = visible.some(function (g) { return g.size === 1 && g.members[0] && g.members[0].playerId === r.cowMovedTo; });
      if (!inView) {
        var cowG = groups.find(function (g) { return g.size === 1 && g.members[0] && g.members[0].playerId === r.cowMovedTo; });
        if (cowG) { visible = visible.slice(0, HERD_VISIBLE_MAX - 1); visible.push(cowG); }
      }
    }
    var hidden = groups.length - visible.length;
    var barsHtml = visible.map(function (g) {
      var pct = (g.size / maxSize) * 100;
      var names = g.members.map(function (m) { return m.name; }).join(', ');
      var isCow = g.size === 1 && r.cowMovedTo && g.members[0] && g.members[0].playerId === r.cowMovedTo;
      var cls = 'herd-row' + (g.isMajority ? ' majority' : '') + (isCow ? ' cow' : '');
      var tag = g.isMajority ? ' <span class="cow-tag" style="color:var(--good)">🏆</span>' : (isCow ? ' <span class="cow-tag">🐄</span>' : '');
      return '<div class="' + cls + '">' +
               '<div><div class="herd-label">' + escapeHtml(g.label) + tag + '</div>' +
               '<div class="herd-names">' + escapeHtml(names) + '</div></div>' +
               '<div class="herd-bar"><div class="herd-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
               '<div class="herd-count">' + g.size + '</div>' +
             '</div>';
    }).join('');
    if (hidden > 0) barsHtml += '<div class="herd-more">+ ' + hidden + ' more bucket' + (hidden === 1 ? '' : 's') + '</div>';
    document.getElementById('rvBars').innerHTML = barsHtml;

    renderLeaderboardInto(document.getElementById('rvLeaderboard'), r.leaderboard, 8);

    // Next button + optional auto-advance countdown
    var nextBtn = document.getElementById('nextBtn');
    var baseLabel = r.gameOver ? 'See results →' : 'Next question →';
    nextBtn.textContent = baseLabel;
    if (r.autoAdvance && r.revealEndsAt) {
      (function countdown() {
        var left = Math.max(0, Math.ceil((r.revealEndsAt - serverNow()) / 1000));
        nextBtn.textContent = baseLabel + ' (' + left + 's)';
        if (left > 0) autoAdvRaf = requestAnimationFrame(countdown);
        else nextBtn.textContent = baseLabel;
      })();
    }
  }

  function renderLeaderboardInto(el, lb, limit) {
    lb = (lb || []).slice(0, limit || lb.length);
    el.innerHTML = lb.map(function (e) {
      var cow = e.hasCow ? '<span class="cow-mini" title="Holding the Pink Cow">🐄</span>' : '';
      return '<div class="lb-row">' +
               '<div class="rank">' + e.rank + '</div>' +
               '<div class="name">' + escapeHtml(e.name) + cow + '</div>' +
               '<div class="score">' + e.score + '</div>' +
             '</div>';
    }).join('');
  }

  document.getElementById('nextBtn').addEventListener('click', function () {
    stopAutoAdv();
    var btn = document.getElementById('nextBtn');
    btn.disabled = true;
    socket.emit('host:next', {}, function () { btn.disabled = false; });
  });

  // ---- Final ----
  function podiumCell(klass, medal, group) {
    if (!group) return '<div class="podium-step ' + klass + ' empty-slot"></div>';
    var tied = group.players.length > 1;
    var visible = group.players.slice(0, 2);
    var overflow = group.players.length - visible.length;
    var names = '<div class="names-list">' +
      visible.map(function (p) {
        var cow = p.hasCow ? ' <span class="cow-mini">🐄</span>' : '';
        return '<div class="name">' + escapeHtml(p.name) + cow + '</div>';
      }).join('') +
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
      title.textContent = '🏆 ' + f.winnerName + ' wins the herd!';
      intro.textContent = 'First to ' + f.target + ' points — without the Pink Cow.';
    } else {
      title.textContent = '🐄 Game over!';
      intro.textContent = '';
    }
    var g = (f && f.podiumGroups) || [];
    document.getElementById('podium').innerHTML =
      podiumCell('place-2', '🥈', g[1]) +
      podiumCell('place-1', '🥇', g[0]) +
      podiumCell('place-3', '🥉', g[2]);
    renderLeaderboardInto(document.getElementById('fullLb'), (f && f.fullLeaderboard) || [], 999);
    playApplause();
  }

  // ---- Socket state ----
  socket.on('connect', function () {
    socket.emit('host:auth', {}, function (res) {
      if (!res || !res.ok) return;
      answersTotal.textContent = res.players ? res.players.length : 0;
      reactionsMuted = !!res.reactionsMuted;
      updateMuteBtn();
      if (res.phase === 'LOBBY') { show('lobby'); renderLobby({ players: res.players, total: res.players.length }); }
      if (window.Iris && typeof window.Iris.ready === 'function') window.Iris.ready();
    });
    renderQR();
  });
  socket.on('state:lobby', function (s) { if (s.phase === 'LOBBY') show('lobby'); renderLobby(s); });
  socket.on('state:intro', renderIntro);
  socket.on('state:question', renderQuestion);
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
    var origin = { clientX: e.clientX, clientY: e.clientY, currentTarget: hubBtn };
    showConfirm('Leaving will reset the game and kick all players. Go back to the hub?', 'Leave & Reset', { danger: true }).then(function (ok) {
      if (!ok) return;
      var navigated = false;
      var go = function () {
        if (navigated) return;
        navigated = true;
        if (window.Iris && typeof window.Iris.transitionTo === 'function') {
          window.Iris.transitionTo(href, origin, { emoji: '🎮', name: 'Game Hub', color: '#1b2838' });
        } else {
          window.location.href = href;
        }
      };
      socket.emit('host:leave', {}, go);
      // The ack never arrives if the socket is already down.
      setTimeout(go, 600);
    });
  });

  // ---- Audio (start fanfare via Web Audio, matches Trivia/24) ----
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
  // Cheerful rising C-E-G fanfare — used for BOTH game start and player join.
  function playStartFanfare() {
    var ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function () {});
      if (ctx.state !== 'running') return;
    }
    var t0 = ctx.currentTime;
    var notes = [
      { freq: 523.25, start: 0.00, dur: 0.22 }, // C5
      { freq: 659.25, start: 0.14, dur: 0.22 }, // E5
      { freq: 783.99, start: 0.28, dur: 0.55 }, // G5
    ];
    notes.forEach(function (n) {
      [
        { type: 'triangle', freq: n.freq,       vol: 0.45 },
        { type: 'sine',     freq: n.freq * 0.5, vol: 0.18 },
      ].forEach(function (layer) {
        var osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = layer.type;
        osc.frequency.value = layer.freq;
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
  // Two-note join ding — matches the other games' lobby-join sound.
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
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
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
  // Descending two-note "doorbell" attention chime played when each new
  // question appears (after the first, which follows the intro fanfare),
  // cueing players to glance at the host screen. Deliberately distinct from
  // an ascending chime so it reads as an announcement.
  function playNextQuestionCue() {
    var ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      ctx.resume().catch(function () {});
      if (ctx.state !== 'running') return;
    }
    var t0 = ctx.currentTime;
    var notes = [
      { freq: 1174.66, start: 0.00, dur: 0.55 }, // D6  (ding)
      { freq: 880.00,  start: 0.26, dur: 0.70 }, // A5  (dong)
    ];
    notes.forEach(function (n) {
      [
        { type: 'sine',     freq: n.freq,       vol: 0.5  },
        { type: 'triangle', freq: n.freq * 3.0, vol: 0.08 },
      ].forEach(function (layer) {
        var osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = layer.type;
        osc.frequency.value = layer.freq;
        var t = t0 + n.start;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(layer.vol, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t); osc.stop(t + n.dur + 0.05);
      });
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
