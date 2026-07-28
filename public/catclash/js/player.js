/* ===== Category Clash · Player ===== */
(function () {
  'use strict';

  var playerId = localStorage.getItem('catclash.playerId');
  if (!playerId) { window.location.replace('/catclash/join'); return; }

  // ---- Kill zoom ----
  // iOS Safari ignores maximum-scale / user-scalable, so block the gestures
  // directly. Single-finger touchmove is left alone — the category list and the
  // round breakdown scroll.
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

  // ---- Pin the shell to the visible area ----
  // The keyboard only resizes the visual viewport, so the browser can pan the
  // (unchanged) layout viewport underneath it. Matching the body to the visual
  // viewport's height and offset means the visible area is always exactly the
  // shell — there is nothing below the "I'm done" button to pan to.
  (function pinToVisualViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    var body = document.body;
    function apply() {
      body.style.height = Math.round(vv.height) + 'px';
      body.style.transform = vv.offsetTop ? 'translateY(' + Math.round(vv.offsetTop) + 'px)' : '';
    }
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
  })();

  var socket = io('/catclash', { transports: ['polling', 'websocket'] });
  var rejected = false;

  var elName = document.getElementById('playerName');
  var elScore = document.getElementById('playerScore');
  var elView = document.getElementById('playerView');
  var reactionBar = document.getElementById('reactionBar');
  var attribution = document.getElementById('playerAttribution');

  var MAX_ANSWER_LEN = 40;
  var SAVE_DEBOUNCE_MS = 450;

  var clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }
  function syncClock(p) { if (p && typeof p.serverNow === 'number') clockOffset = p.serverNow - Date.now(); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function render(html) {
    elView.classList.remove('mode-round');
    elView.innerHTML = '<div class="state-card">' + html + '</div>';
  }
  function tryVibrate(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} } }
  function fmtClock(sec) {
    var s = Math.max(0, sec | 0);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  // Mirrors the server's letterStartOk(): strip accents/punctuation, allow one
  // leading "a" / "an" / "the", then compare the first letter.
  function letterStartOk(raw, letter) {
    if (!letter) return true;
    var s = String(raw == null ? '' : raw);
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return false;
    var parts = s.split(' ');
    if (parts.length > 1 && (parts[0] === 'a' || parts[0] === 'an' || parts[0] === 'the')) parts.shift();
    var head = parts.join(' ');
    if (!head) return false;
    return head.charAt(0) === String(letter).toLowerCase();
  }

  var cachedName = '—';
  var lobbyTotal = 0;
  var hostPresent = true;
  var currentRound = null;

  function setScore(v) { if (typeof v === 'number') elScore.textContent = v; }
  function setName(name) { elName.textContent = name; }
  function setAttribution(v) {
    if (attribution) attribution.hidden = !v;
    // The footer is pinned to the viewport bottom, so the reaction bar only
    // needs to leave room for it while it is actually visible.
    document.body.classList.toggle('has-attribution', !!v);
  }

  // ---- Reactions gating ----
  var reactionsAllowed = false;
  var reactionsMutedByHost = false;
  function setReactionsAllowed(v) { reactionsAllowed = !!v; updateReactionState(); }
  function updateReactionState() {
    reactionBar.hidden = !(reactionsAllowed && !reactionsMutedByHost && hostPresent);
  }

  // ---- Lobby ----
  function renderLobby() {
    stopAllTimers();
    currentRound = null;
    setReactionsAllowed(true);
    var label = lobbyTotal === 1 ? 'player' : 'players';
    var countLine = lobbyTotal > 0
      ? '<div class="lobby-player-count"><span class="pulse-dot"></span><span><strong>' + lobbyTotal + '</strong> ' + label + ' in the lobby</span></div>'
      : '';
    render(
      '<div class="lobby-hero" aria-hidden="true"><span>📝</span></div>' +
      '<h2>You\'re in!</h2>' +
      '<p>Look up at the big screen. The game will start soon.</p>' + countLine
    );
    setAttribution(true);
  }

  // ---- Intro (letter reveal) ----
  var introTimer = null;
  function stopIntroTimer() { if (introTimer) { clearInterval(introTimer); introTimer = null; } }
  function renderIntro(p) {
    stopAllTimers();
    currentRound = null;
    setReactionsAllowed(false);
    setAttribution(false);
    syncClock(p);
    var endsAt = (p && p.endsAt) || (serverNow() + 4000);
    var letter = (p && p.letter) || '?';
    elView.classList.remove('mode-round');
    elView.innerHTML =
      '<div class="state-card intro-card">' +
        '<div class="intro-hint">Round ' + ((p && p.round) || 1) + ' of ' + ((p && p.totalRounds) || 1) + ' · your letter is…</div>' +
        '<div class="letter-tile">' + escapeHtml(letter) + '</div>' +
        '<p>Every answer must start with <strong>' + escapeHtml(letter) + '</strong>.</p>' +
        '<div class="intro-countdown" id="pIntro">3</div>' +
      '</div>';
    var el = document.getElementById('pIntro');
    function tick() {
      var left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      if (el) el.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0) stopIntroTimer();
    }
    tick();
    introTimer = setInterval(tick, 200);
  }

  // ---- Round (12 categories) ----
  var pendingSaves = {};   // catIdx -> timeout id
  var localAnswers = [];
  var iAmDone = false;
  var doneArmed = false;

  function flushSave(idx) {
    if (pendingSaves[idx]) { clearTimeout(pendingSaves[idx]); delete pendingSaves[idx]; }
    if (!currentRound) return;
    socket.emit('player:answer', { catIdx: idx, text: localAnswers[idx] || '' });
  }
  function flushAllSaves() {
    Object.keys(pendingSaves).forEach(function (k) { flushSave(parseInt(k, 10)); });
  }
  function queueSave(idx) {
    if (pendingSaves[idx]) clearTimeout(pendingSaves[idx]);
    pendingSaves[idx] = setTimeout(function () { flushSave(idx); }, SAVE_DEBOUNCE_MS);
  }

  function renderRound(r, myAnswers, myDone) {
    stopAllTimers();
    currentRound = r;
    syncClock(r);
    setReactionsAllowed(false);
    setAttribution(false);
    iAmDone = !!myDone;
    doneArmed = false;
    localAnswers = [];
    var cats = (r && r.categories) || [];
    for (var i = 0; i < cats.length; i++) {
      localAnswers[i] = (myAnswers && myAnswers[i]) ? String(myAnswers[i]) : '';
    }

    var letter = r.letter || '?';
    var rows = cats.map(function (c, i) {
      return '' +
        '<div class="cat-item" data-idx="' + i + '">' +
          '<div class="cat-label"><span class="num">' + (i + 1) + '.</span><span class="txt">' + escapeHtml(c.text) + '</span></div>' +
          '<div class="cat-field">' +
            '<input type="text" maxlength="' + MAX_ANSWER_LEN + '" data-idx="' + i + '" ' +
              'autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" ' +
              'enterkeyhint="next" placeholder="Starts with ' + escapeHtml(letter) + '…" ' +
              'value="' + escapeHtml(localAnswers[i]) + '" />' +
            '<button type="button" class="cat-clear" data-clear="' + i + '" aria-label="Clear answer" tabindex="-1" hidden>×</button>' +
          '</div>' +
          '<p class="cat-warn" hidden>Must start with ' + escapeHtml(letter) + ' (or "A/An/The ' + escapeHtml(letter) + '")</p>' +
        '</div>';
    }).join('');

    elView.classList.add('mode-round');
    elView.innerHTML =
      '<div class="round-shell">' +
        '<div class="round-bar">' +
          '<div class="letter-tile">' + escapeHtml(letter) + '</div>' +
          '<div class="bar-mid">' +
            '<div class="bar-round">Round ' + r.round + ' of ' + r.totalRounds + '</div>' +
            '<div class="bar-rule">Every answer starts with <b>' + escapeHtml(letter) + '</b></div>' +
          '</div>' +
          '<div class="countdown-pill" id="pcount">—</div>' +
        '</div>' +
        '<div class="cat-list" id="catList">' + rows + '</div>' +
        '<div class="round-foot">' +
          '<div class="filled-note" id="filledNote"></div>' +
          '<button type="button" class="btn-primary" id="doneBtn">I\'m done</button>' +
        '</div>' +
      '</div>';

    var list = document.getElementById('catList');
    list.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.cat-clear') : null;
      if (!btn) return;
      var idx = parseInt(btn.dataset.clear, 10);
      if (isNaN(idx)) return;
      var input = list.querySelector('input[data-idx="' + idx + '"]');
      if (!input || input.disabled) return;
      input.value = '';
      localAnswers[idx] = '';
      disarmDone();
      refreshRow(idx);
      updateFilledNote();
      flushSave(idx);
      input.focus();
    });
    list.addEventListener('input', function (e) {
      var input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      var idx = parseInt(input.dataset.idx, 10);
      if (isNaN(idx)) return;
      localAnswers[idx] = input.value.slice(0, MAX_ANSWER_LEN);
      // A deliberate edit cancels the "I'm done" arm so it never needs 3 taps.
      disarmDone();
      refreshRow(idx);
      updateFilledNote();
      queueSave(idx);
    });
    list.addEventListener('focusout', function (e) {
      var input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      var idx = parseInt(input.dataset.idx, 10);
      if (!isNaN(idx) && pendingSaves[idx]) flushSave(idx);
    });
    // Enter hops to the next field instead of dismissing the keyboard.
    list.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      e.preventDefault();
      var idx = parseInt(input.dataset.idx, 10);
      var next = list.querySelector('input[data-idx="' + (idx + 1) + '"]');
      if (next) next.focus(); else input.blur();
    });

    for (var j = 0; j < cats.length; j++) refreshRow(j);
    updateFilledNote();
    updateDoneBtn();
    document.getElementById('doneBtn').addEventListener('click', onDoneClick);
    startCountdown();
  }

  function refreshRow(idx) {
    var row = elView.querySelector('.cat-item[data-idx="' + idx + '"]');
    if (!row) return;
    var val = (localAnswers[idx] || '').trim();
    var warn = row.querySelector('.cat-warn');
    var clear = row.querySelector('.cat-clear');
    var bad = !!val && !letterStartOk(val, currentRound && currentRound.letter);
    row.classList.toggle('filled', !!val && !bad);
    row.classList.toggle('badletter', bad);
    if (warn) warn.hidden = !bad;
    if (clear) clear.hidden = !(localAnswers[idx] || '').length;
  }
  function filledCount() {
    var n = 0;
    for (var i = 0; i < localAnswers.length; i++) if ((localAnswers[i] || '').trim()) n++;
    return n;
  }
  function updateFilledNote() {
    var el = document.getElementById('filledNote');
    if (!el) return;
    el.textContent = filledCount() + ' of ' + localAnswers.length + ' filled in';
  }

  function disarmDone() {
    if (!doneArmed) return;
    doneArmed = false;
    updateDoneBtn();
  }
  function updateDoneBtn() {
    var btn = document.getElementById('doneBtn');
    if (!btn) return;
    btn.classList.toggle('btn-arm', doneArmed && !iAmDone);
    if (iAmDone) btn.textContent = 'Keep writing';
    else if (doneArmed) btn.textContent = 'Tap again to lock in';
    else btn.textContent = 'I\'m done';
  }
  function onDoneClick() {
    if (iAmDone) {
      // Un-done is not destructive — no confirmation needed.
      iAmDone = false;
      updateDoneBtn();
      setRoundEditable(true);
      socket.emit('player:done', { done: false });
      return;
    }
    // Two-tap confirm (player pages have no modal helper available).
    if (!doneArmed) { doneArmed = true; updateDoneBtn(); tryVibrate(20); return; }
    doneArmed = false;
    iAmDone = true;
    flushAllSaves();
    updateDoneBtn();
    setRoundEditable(false);
    tryVibrate([30, 40, 30]);
    socket.emit('player:done', { done: true }, function (res) {
      if (res && !res.ok) { iAmDone = false; updateDoneBtn(); setRoundEditable(true); }
    });
  }
  function setRoundEditable(on) {
    var inputs = elView.querySelectorAll('.cat-list input');
    for (var i = 0; i < inputs.length; i++) inputs[i].disabled = !on;
    var clears = elView.querySelectorAll('.cat-clear');
    for (var j = 0; j < clears.length; j++) clears[j].disabled = !on;
    var note = document.getElementById('filledNote');
    if (note) note.textContent = on ? (filledCount() + ' of ' + localAnswers.length + ' filled in') : 'Locked in — tap “Keep writing” to edit again';
  }

  // ---- Reviewing / review progress ----
  function renderReviewing(p) {
    stopAllTimers();
    currentRound = null;
    setReactionsAllowed(true);
    setAttribution(false);
    render(
      '<div class="reviewing-spinner"></div>' +
      '<h2>Pens down!</h2>' +
      '<p>The host is going through the answers on the big screen.</p>' +
      '<div class="review-now" id="reviewNow" hidden></div>'
    );
    if (p && p.category) renderReviewProgress(p);
  }
  function renderReviewProgress(p) {
    var el = document.getElementById('reviewNow');
    if (!el || !p) return;
    el.hidden = false;
    el.innerHTML = 'Now scoring <strong>' + ((p.catIdx || 0) + 1) + ' / ' + (p.total || 12) + '</strong>: ' +
      escapeHtml(p.category || '');
  }

  // ---- Result ----
  var STATUS_TAG = { scored: '+1', duplicate: 'Duplicate', invalid: 'Doesn\'t count', blank: 'Blank' };
  function renderResult(res) {
    stopAllTimers();
    currentRound = null;
    setReactionsAllowed(true);
    setAttribution(false);
    if (!res) { render('<h2>Hold tight…</h2><p>Results are on the big screen.</p>'); return; }
    setScore(res.totalScore);

    var rankLine = res.isLastRound
      ? 'Final round done — check the big screen!'
      : (res.tied
        ? 'You\'re tied at <strong>#' + res.rank + '</strong> of ' + res.totalPlayers
        : 'You\'re <strong>#' + res.rank + '</strong> of ' + res.totalPlayers);

    var items = (res.breakdown || []).map(function (b) {
      var answerHtml = b.answer
        ? '<div class="bd-answer">' + escapeHtml(b.answer) + '</div>'
        : '<div class="bd-answer empty">(left blank)</div>';
      return '' +
        '<div class="bd-item ' + escapeHtml(b.status) + '">' +
          '<div class="bd-text">' +
            '<div class="bd-cat">' + escapeHtml(b.category) + '</div>' + answerHtml +
          '</div>' +
          '<div class="bd-tag">' + escapeHtml(STATUS_TAG[b.status] || b.status) + '</div>' +
        '</div>';
    }).join('');

    elView.classList.add('mode-round');
    elView.innerHTML =
      '<div class="result-shell">' +
        '<div class="result-head">' +
          '<h2>Round ' + res.round + ' · letter ' + escapeHtml(res.letter || '') + '</h2>' +
          '<div class="result-points' + (res.roundPoints ? '' : ' zero') + '">+' + res.roundPoints + '</div>' +
          '<p class="result-rank">' + rankLine + '</p>' +
        '</div>' +
        '<div class="breakdown">' + items + '</div>' +
      '</div>';
  }

  function renderFinal(p) {
    stopAllTimers();
    currentRound = null;
    setReactionsAllowed(true);
    var line = '<p>Check the big screen for the final results.</p>';
    if (p && p.fullLeaderboard) {
      var me = null;
      for (var i = 0; i < p.fullLeaderboard.length; i++) {
        if (p.fullLeaderboard[i].id === playerId) { me = p.fullLeaderboard[i]; break; }
      }
      if (me) {
        line = (me.rank === 1)
          ? '<p>🏆 You finished <strong>#1</strong> with ' + me.score + ' points!</p>'
          : '<p>You finished <strong>#' + me.rank + '</strong> with ' + me.score + ' points.</p>';
        setScore(me.score);
      }
    }
    render('<h2>Thanks for playing! 📝</h2>' + line);
    setAttribution(true);
  }

  // ---- Countdown ----
  var countdownRaf = null, haptic30 = false, haptic10 = false, urgentAdded = false;
  function stopCountdown() { if (countdownRaf) { cancelAnimationFrame(countdownRaf); countdownRaf = null; } }
  function stopAllTimers() { stopCountdown(); stopIntroTimer(); }
  function startCountdown() {
    stopCountdown();
    haptic30 = false; haptic10 = false; urgentAdded = false;
    var lastLeft = -1;
    function tick() {
      if (!currentRound) return stopCountdown();
      var el = document.getElementById('pcount');
      if (!el) return stopCountdown();
      var msLeft = Math.max(0, currentRound.endsAt - serverNow());
      var left = Math.ceil(msLeft / 1000);
      if (left !== lastLeft) {
        lastLeft = left;
        el.textContent = fmtClock(left);
        if (left <= 15 && left > 0) {
          if (!urgentAdded) { urgentAdded = true; el.classList.add('urgent'); }
          if (!haptic30) { haptic30 = true; tryVibrate(50); }
          if (left <= 5 && !haptic10) { haptic10 = true; tryVibrate([90, 60, 90]); }
        }
      }
      if (msLeft <= 0) { flushAllSaves(); stopCountdown(); return; }
      countdownRaf = requestAnimationFrame(tick);
    }
    countdownRaf = requestAnimationFrame(tick);
  }

  // Never lose typing when the phone is backgrounded mid-round.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushAllSaves();
  });

  // ---- Host presence ----
  function updateHostPresence(present) {
    var was = hostPresent;
    hostPresent = !!present;
    var ov = document.getElementById('hostAbsentOverlay');
    if (ov) ov.hidden = hostPresent;
    updateReactionState();
    if (was && !hostPresent) {
      stopAllTimers();
      localStorage.removeItem('catclash.playerId');
      localStorage.removeItem('catclash.playerName');
    } else if (!was && hostPresent) {
      window.location.replace('/catclash/join');
    }
  }
  socket.on('state:hostPresence', function (p) { updateHostPresence(!(p && p.present === false)); });

  // ---- Socket ----
  socket.on('connect', function () {
    if (rejected) return;
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (rejected) return;
      if (!res || !res.ok) {
        localStorage.removeItem('catclash.playerId');
        localStorage.removeItem('catclash.playerName');
        window.location.replace('/catclash/join');
        return;
      }
      cachedName = res.player.name;
      setName(cachedName);
      setScore(res.player.score || 0);
      reactionsMutedByHost = !!res.reactionsMuted;
      hostPresent = res.hostPresent !== false;
      var ov = document.getElementById('hostAbsentOverlay');
      if (ov) ov.hidden = hostPresent;

      if (res.phase === 'LOBBY') { lobbyTotal = res.total || 0; renderLobby(); }
      else if (res.phase === 'INTRO') renderIntro(res.intro);
      else if (res.phase === 'ROUND' && res.round) {
        renderRound(res.round, res.myAnswers, res.myDone);
        if (res.myDone) setRoundEditable(false);
      }
      else if (res.phase === 'REVIEWING') renderReviewing(res.reviewing);
      else if (res.phase === 'REVIEW') renderReviewing(res.reviewProgress);
      else if (res.phase === 'REVEAL') renderResult(res.myResult);
      else if (res.phase === 'FINAL') renderFinal(null);
      updateReactionState();
    });
  });

  socket.on('state:lobby', function (s) {
    if (s && typeof s.total === 'number') lobbyTotal = s.total;
    // Only refresh the lobby card — never clobber another view.
    if (elView.querySelector('.lobby-hero')) renderLobby();
  });
  socket.on('state:intro', renderIntro);
  socket.on('state:round', function (r) { renderRound(r, null, false); });
  socket.on('state:reviewing', function (p) { renderReviewing(p); });
  socket.on('state:reviewProgress', function (p) {
    if (!document.getElementById('reviewNow')) renderReviewing(p);
    else renderReviewProgress(p);
  });
  socket.on('state:reveal', function () { /* per-player breakdown arrives via player:result */ });
  socket.on('player:result', renderResult);
  socket.on('state:final', renderFinal);
  socket.on('state:reset', function () {
    var name = localStorage.getItem('catclash.playerName') || '';
    if (name) localStorage.setItem('catclash.rejoinName', name);
    localStorage.removeItem('catclash.playerId');
    localStorage.removeItem('catclash.playerName');
    window.location.replace('/catclash/join');
  });

  socket.on('player:rejected', function (payload) {
    rejected = true;
    stopAllTimers();
    setReactionsAllowed(false);
    var reason = payload && payload.reason;
    var savedName = localStorage.getItem('catclash.playerName') || '';
    if (reason === 'kicked' || reason === 'reset') {
      if (savedName) localStorage.setItem('catclash.rejoinName', savedName);
    }
    localStorage.removeItem('catclash.playerId');
    localStorage.removeItem('catclash.playerName');
    var msg = {
      'kicked': 'You were removed by the host.',
      'reset': 'The host has reset the game.',
    }[reason] || 'Disconnected.';
    reactionBar.hidden = true;
    elView.classList.remove('mode-round');
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2>' + msg + '</h2>' +
        '<button class="btn-accent" id="rejoinBtn" type="button">Rejoin</button>' +
      '</div>';
    document.getElementById('rejoinBtn').addEventListener('click', function () {
      window.location.replace('/catclash/join');
    });
  });

  socket.on('state:reactionsMuted', function (p) { reactionsMutedByHost = !!(p && p.muted); updateReactionState(); });

  // ---- Reaction bar ----
  var REACTION_COOLDOWN_MS = 10 * 1000;
  var REACTION_LS_KEY = 'catclash.lastReactionAt';
  var reactionCooldown = document.getElementById('reactionCooldown');
  var reactionUntil = 0, cooldownRaf = null;
  var reactionBtns = Array.prototype.slice.call(reactionBar.querySelectorAll('.reaction-btn'));

  var storedLast = parseInt(localStorage.getItem(REACTION_LS_KEY) || '0', 10);
  if (storedLast && Date.now() - storedLast < REACTION_COOLDOWN_MS) {
    reactionUntil = storedLast + REACTION_COOLDOWN_MS;
    startCooldown();
  }
  function startCooldown() {
    if (cooldownRaf) cancelAnimationFrame(cooldownRaf);
    function tick() {
      var left = reactionUntil - Date.now();
      if (left <= 0) {
        reactionBtns.forEach(function (b) { b.disabled = false; });
        reactionCooldown.hidden = true;
        cooldownRaf = null;
        return;
      }
      reactionBtns.forEach(function (b) { b.disabled = true; });
      reactionCooldown.hidden = false;
      reactionCooldown.textContent = Math.ceil(left / 1000) + 's';
      cooldownRaf = requestAnimationFrame(tick);
    }
    tick();
  }
  reactionBar.addEventListener('click', function (e) {
    var btn = e.target.closest('.reaction-btn');
    if (!btn || btn.disabled) return;
    var idx = parseInt(btn.dataset.reaction, 10);
    if (isNaN(idx)) return;
    var now = Date.now();
    reactionUntil = now + REACTION_COOLDOWN_MS;
    localStorage.setItem(REACTION_LS_KEY, String(now));
    startCooldown();
    socket.emit('player:reaction', { index: idx }, function (res) {
      if (res && !res.ok && res.reason === 'cooldown' && res.retryInMs) {
        reactionUntil = Date.now() + res.retryInMs;
        localStorage.setItem(REACTION_LS_KEY, String(Date.now() + res.retryInMs - REACTION_COOLDOWN_MS));
        startCooldown();
      }
    });
  });
})();
