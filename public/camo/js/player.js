/* ===== Camo · Player ===== */
(function () {
  'use strict';

  var playerId = localStorage.getItem('camo.playerId');
  if (!playerId) { window.location.replace('/camo/join'); return; }

  // iOS Safari ignores maximum-scale / user-scalable, and a two-thumb tap on
  // the grid reads as a pinch — block every zoom gesture explicitly.
  (function lockZoom() {
    var stop = function (e) { e.preventDefault(); };
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('gestureend', stop, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
    var lastTouchEnd = 0;
    document.addEventListener('touchend', function (e) {
      var now = Date.now();
      if (now - lastTouchEnd <= 350) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
  }());

  var socket = io('/camo', { transports: ['polling', 'websocket'] });
  var rejected = false;

  var elName = document.getElementById('playerName');
  var elScore = document.getElementById('playerScore');
  var elView = document.getElementById('playerView');
  var reactionBar = document.getElementById('reactionBar');
  var attribution = document.getElementById('playerAttribution');

  var clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }
  function syncClock(p) { if (p && typeof p.serverNow === 'number') clockOffset = p.serverNow - Date.now(); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function render(html) { clearArm(); elView.innerHTML = '<div class="state-card">' + html + '</div>'; }
  function tryVibrate(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} } }
  function ordinal(n) {
    var tail = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (tail[(v - 20) % 10] || tail[v] || tail[0]);
  }

  var cachedName = '—';
  var lobbyTotal = 0;
  var hostPresent = true;
  var myRole = null;        // { round, topic, isChameleon, secretWord }
  var roleAcked = false;
  var voteArmedId = null;
  var guessArmedIndex = -1;

  // ---- Pending-confirm arming (vote & guess) ----
  // An armed control reverts by itself after a pause or as soon as the player
  // taps anywhere else, so a stray tap never leaves the button half-committed.
  var ARM_TIMEOUT_MS = 5000;
  var armTimer = null;
  var armedDisarm = null;
  function clearArm() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    var fn = armedDisarm;
    armedDisarm = null;
    if (fn) fn();
  }
  function setArm(disarm) {
    clearArm();
    armedDisarm = disarm;
    armTimer = setTimeout(clearArm, ARM_TIMEOUT_MS);
  }
  function disarmOnOutsideTap(e) {
    if (!armedDisarm) return;
    var t = e.target;
    if (t && t.closest && t.closest('.vote-btn:not([disabled]), .guess-cell:not([disabled])')) return;
    clearArm();
  }
  document.addEventListener('pointerdown', disarmOnOutsideTap, true);
  if (!('PointerEvent' in window)) document.addEventListener('touchstart', disarmOnOutsideTap, true);

  function setScore(v) { if (typeof v === 'number') elScore.textContent = v + (v === 1 ? ' pt' : ' pts'); }
  function setName(name) { cachedName = name; elName.textContent = name; }
  function setAttribution(v) { if (attribution) attribution.hidden = !v; }

  // ---- Reactions gating ----
  var reactionsAllowed = false;
  var reactionsMutedByHost = false;
  function setReactionsAllowed(v) { reactionsAllowed = !!v; updateReactionState(); }
  function updateReactionState() {
    reactionBar.hidden = !(reactionsAllowed && !reactionsMutedByHost && hostPresent);
  }

  // ---- Hold-to-peek secret card ----
  // The Chameleon's card is byte-identical in shape and behaviour — same blur,
  // same hold gesture — so the gesture itself never gives anyone away.
  function secretCardHtml() {
    if (!myRole) return '';
    var isCham = !!myRole.isChameleon;
    var word = isCham ? 'You are the Chameleon 🦎' : (myRole.secretWord || '');
    return '<div class="topic-line">' + escapeHtml(myRole.topic || '') + '</div>' +
      '<div class="secret-card" id="secretCard">' +
        '<div class="secret-label">Secret word</div>' +
        '<div class="secret-word' + (isCham ? ' is-chameleon' : '') + '">' + escapeHtml(word) + '</div>' +
        '<div class="secret-hint">👆 Hold to peek</div>' +
      '</div>';
  }
  function bindSecretCard() {
    var card = document.getElementById('secretCard');
    if (!card) return;
    var hint = card.querySelector('.secret-hint');
    function peek(on) {
      card.classList.toggle('peeking', !!on);
      if (hint) hint.textContent = on ? '👀 Keep holding — release to hide' : '👆 Hold to peek';
    }
    if (window.PointerEvent) {
      card.addEventListener('pointerdown', function (e) { e.preventDefault(); peek(true); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
        card.addEventListener(ev, function () { peek(false); });
      });
    } else {
      card.addEventListener('touchstart', function (e) { e.preventDefault(); peek(true); }, { passive: false });
      ['touchend', 'touchcancel'].forEach(function (ev) {
        card.addEventListener(ev, function () { peek(false); });
      });
      card.addEventListener('mousedown', function () { peek(true); });
      ['mouseup', 'mouseleave'].forEach(function (ev) {
        card.addEventListener(ev, function () { peek(false); });
      });
    }
  }

  // ---- Lobby ----
  function renderLobby() {
    setReactionsAllowed(true);
    var label = lobbyTotal === 1 ? 'player' : 'players';
    var countLine = lobbyTotal > 0
      ? '<div class="lobby-player-count"><span class="pulse-dot"></span><span><strong>' + lobbyTotal + '</strong> ' + label + ' in the lobby</span></div>'
      : '';
    render(
      '<div class="lobby-hero" aria-hidden="true"><span>🦎</span></div>' +
      '<h2>You\'re in!</h2>' +
      '<p>Look up at the big screen. The game will start soon.</p>' + countLine
    );
    setAttribution(true);
  }

  // ---- Intro ----
  var introTimer = null;
  function stopIntroTimer() { if (introTimer) { clearInterval(introTimer); introTimer = null; } }
  function renderIntro(p) {
    setReactionsAllowed(false);
    setAttribution(false);
    stopIntroTimer();
    syncClock(p);
    myRole = null;
    roleAcked = false;
    var endsAt = (p && p.endsAt) || (serverNow() + 4000);
    elView.innerHTML =
      '<div class="state-card intro-card">' +
        '<div class="card-meta">Cover your screen</div>' +
        '<h2>Dealing the round…</h2>' +
        '<div class="intro-countdown" id="pIntro">4</div>' +
        '<p>Your word is on its way…</p>' +
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

  // ---- Role ----
  function renderRole() {
    setReactionsAllowed(false);
    setAttribution(false);
    stopIntroTimer();
    if (!myRole) {
      render('<div class="card-meta">Round</div><h2>Getting your word…</h2><p>Hang tight.</p>');
      return;
    }
    if (!roleAcked) {
      elView.innerHTML =
        '<div class="state-card">' +
          '<div class="card-meta">Round ' + (myRole.round || 1) + '</div>' +
          secretCardHtml() +
          '<p>Hold the card to read it — keep it off your neighbor\'s screen.</p>' +
          '<div class="card-actions"><button type="button" class="btn-accent" id="ackBtn">Got it</button></div>' +
        '</div>';
      bindSecretCard();
      var btn = document.getElementById('ackBtn');
      btn.addEventListener('click', function () {
        btn.disabled = true;
        socket.emit('player:roleAck', {}, function (res) {
          if (!res || !res.ok) { btn.disabled = false; return; }
          roleAcked = true;
          // The last ack ends the phase, so the clues screen can land before this reply —
          // only paint the waiting screen if we're still on the role card.
          if (document.body.contains(btn)) renderRoleWaiting(res.acked, res.total);
        });
      });
    } else {
      renderRoleWaiting();
    }
  }
  function renderRoleWaiting(acked, total) {
    var progress = (typeof acked === 'number' && typeof total === 'number')
      ? '<p>' + acked + ' of ' + total + ' ready…</p>' : '<p>Waiting for everyone else…</p>';
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="card-meta">Round ' + ((myRole && myRole.round) || 1) + '</div>' +
        secretCardHtml() +
        '<h2>Ready ✓</h2>' + progress +
      '</div>';
    bindSecretCard();
  }

  // ---- Clues ----
  function queueHtml(order, turnIndex) {
    if (!order || !order.length) return '';
    return '<div class="turn-queue scroll-region">' + order.map(function (p, i) {
      var cls = 'queue-chip';
      if (i === turnIndex) cls += ' current';
      else if (i < turnIndex) cls += ' done';
      return '<div class="' + cls + '">' + escapeHtml(p.name) + '</div>';
    }).join('') + '</div>';
  }
  function renderClues(c) {
    if (!c) return;
    setReactionsAllowed(false);
    setAttribution(false);
    stopIntroTimer();
    clearArm();
    var mine = c.currentId === playerId;
    if (mine) tryVibrate([60, 50, 60]);
    var myTurn = (c.order || []).findIndex(function (o) { return o.id === playerId; });
    var spoken = myTurn >= 0 && myTurn < (c.turnIndex || 0);
    var body = mine
      ? '<div class="turn-badge">Your turn</div>' +
        '<h2>Say one word out loud</h2>' +
        '<p>Pick a word that shows you know the secret word — without giving it away.</p>' +
        '<div class="card-actions"><button type="button" class="btn-accent" id="doneBtn">I said my word</button></div>'
      : '<div class="card-meta">Now speaking</div>' +
        '<div class="turn-name">' + escapeHtml(c.currentName || '—') + '</div>' +
        (spoken
          ? '<p>You\'ve had your turn — listen for the rest.</p>'
          : '<p>Listen closely. Your turn is coming.</p>');
    elView.innerHTML =
      '<div class="state-card">' +
        secretCardHtml() + body + queueHtml(c.order, c.turnIndex) +
      '</div>';
    bindSecretCard();
    if (mine) {
      var btn = document.getElementById('doneBtn');
      btn.addEventListener('click', function () {
        btn.disabled = true;
        socket.emit('player:clueDone', {}, function (res) {
          if (!res || !res.ok) btn.disabled = false;
        });
      });
    }
  }

  // ---- Vote ----
  function renderVote(v, myVote) {
    setReactionsAllowed(false);
    setAttribution(false);
    clearArm();
    voteArmedId = null;
    if (myVote) return renderVoteLocked(v, myVote);
    var players = (v && v.players) || [];
    elView.innerHTML =
      '<div class="state-card">' +
        secretCardHtml() +
        '<h2>Who is the Chameleon?</h2>' +
        '<p class="vote-scroll-hint">Talk it out, then tap a name twice to lock your vote.</p>' +
        '<div class="vote-list scroll-region" id="voteList">' +
          players.map(function (p) {
            var me = p.id === playerId;
            var label = p.name + (me ? ' (you)' : '');
            return '<button type="button" class="vote-btn' + (me ? ' is-me' : '') + '"' +
              (me ? ' disabled' : '') + ' data-pid="' + escapeHtml(p.id) + '"' +
              ' data-label="' + escapeHtml(label) + '">' + escapeHtml(label) + '</button>';
          }).join('') +
        '</div>' +
      '</div>';
    bindSecretCard();
    var list = document.getElementById('voteList');
    function paintVote(pid) {
      Array.prototype.forEach.call(list.querySelectorAll('.vote-btn'), function (b) {
        var on = b.getAttribute('data-pid') === pid;
        b.classList.toggle('selected', on);
        b.textContent = on ? b.getAttribute('data-label') + ' — tap again ✔' : b.getAttribute('data-label');
      });
    }
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('.vote-btn');
      if (!btn || btn.disabled) return;
      var pid = btn.getAttribute('data-pid');
      if (voteArmedId !== pid) {
        voteArmedId = pid;
        paintVote(pid);
        setArm(function () { voteArmedId = null; paintVote(null); });
        return;
      }
      clearArm();
      voteArmedId = null;
      Array.prototype.forEach.call(list.querySelectorAll('.vote-btn'), function (b) { b.disabled = true; });
      socket.emit('player:vote', { targetId: pid }, function (res) {
        if (res && res.ok) renderVoteLocked(v, pid);
        else renderVote(v, null);
      });
    });
  }
  function renderVoteLocked(v, targetId) {
    var players = (v && v.players) || [];
    var target = players.filter(function (p) { return p.id === targetId; })[0];
    render(
      '<div class="card-meta">Vote locked</div>' +
      '<h2>You voted for</h2>' +
      '<div class="result-word">' + escapeHtml(target ? target.name : '…') + '</div>' +
      '<p>Waiting for everyone…</p>'
    );
  }

  // ---- Guess ----
  function renderGuess(g) {
    setReactionsAllowed(false);
    setAttribution(false);
    clearArm();
    guessArmedIndex = -1;
    var mine = g && g.chameleonId === playerId;
    if (!mine) {
      render(
        '<div class="card-meta">Caught!</div>' +
        '<h2 class="has-name"><span class="pname">' + escapeHtml((g && g.chameleonName) || 'The Chameleon') + '</span> was the Chameleon 🦎</h2>' +
        '<p>Look up — they get one chance to guess the word.</p>'
      );
      return;
    }
    tryVibrate([90, 60, 90]);
    var words = (g && g.grid && g.grid.words) || [];
    elView.innerHTML =
      '<div class="state-card">' +
        '<div class="turn-badge">You\'re caught</div>' +
        '<h2>Name the secret word</h2>' +
        '<p class="vote-scroll-hint">Tap a word, then tap again to lock.</p>' +
        '<div class="guess-grid scroll-region" id="guessGrid">' +
          words.map(function (w, i) {
            return '<button type="button" class="guess-cell" data-idx="' + i + '">' + escapeHtml(w) + '</button>';
          }).join('') +
        '</div>' +
      '</div>';
    var grid = document.getElementById('guessGrid');
    var hintEl = elView.querySelector('.vote-scroll-hint');
    var baseHint = hintEl ? hintEl.textContent : '';
    function paintGuess(idx) {
      Array.prototype.forEach.call(grid.querySelectorAll('.guess-cell'), function (b) {
        b.classList.toggle('selected', parseInt(b.getAttribute('data-idx'), 10) === idx);
      });
      if (hintEl) hintEl.textContent = idx < 0 ? baseHint : 'Tap “' + words[idx] + '” again to lock it in.';
    }
    grid.addEventListener('click', function (e) {
      var cell = e.target.closest('.guess-cell');
      if (!cell || cell.disabled) return;
      var idx = parseInt(cell.getAttribute('data-idx'), 10);
      if (isNaN(idx)) return;
      if (guessArmedIndex !== idx) {
        guessArmedIndex = idx;
        paintGuess(idx);
        setArm(function () { guessArmedIndex = -1; paintGuess(-1); });
        return;
      }
      clearArm();
      guessArmedIndex = -1;
      Array.prototype.forEach.call(grid.querySelectorAll('.guess-cell'), function (b) { b.disabled = true; });
      socket.emit('player:guess', { wordIndex: idx }, function (res) {
        if (res && res.ok) {
          render('<div class="card-meta">Locked in</div><h2>You guessed</h2>' +
            '<div class="result-word">' + escapeHtml(words[idx]) + '</div><p>Look up at the big screen…</p>');
        } else {
          renderGuess(g);
        }
      });
    });
  }

  // ---- Result ----
  function renderResult(res) {
    if (!res) return;
    setReactionsAllowed(true);
    setAttribution(false);
    setScore(res.totalScore);
    myRole = null;
    roleAcked = false;

    var verdict, tone;
    if (res.wasChameleon) {
      if (res.outcome === 'escaped-vote') { verdict = 'ESCAPED'; tone = 'good'; }
      else if (res.outcome === 'escaped-guess') { verdict = 'RIGHT GUESS'; tone = 'good'; }
      else { verdict = 'BUSTED'; tone = 'bad'; }
    } else if (res.outcome === 'escaped-guess') {
      verdict = 'THEY GUESSED THE WORD';
      tone = 'bad';
    } else if (res.caught && res.votedCorrectly && res.pointsEarned > 0) {
      // Only claim the catch when it actually paid — a scoreless round never reads as a win.
      verdict = 'YOU CAUGHT THEM';
      tone = 'good';
    } else if (res.caught) {
      verdict = 'THEY GOT CAUGHT';
      tone = 'bad';
    } else {
      verdict = 'THEY ESCAPED';
      tone = 'bad';
    }

    var main = '<h2 class="result-' + tone + '">' + verdict + '</h2>' +
      '<div class="result-points' + (res.pointsEarned ? '' : ' zero') + '">' +
      (res.pointsEarned ? '+' + res.pointsEarned : '+0') + '</div>' +
      '<div class="result-fact"><span class="fact-label">🦎 Chameleon</span>' +
        '<span class="fact-value">' + escapeHtml(res.wasChameleon ? 'You' : (res.chameleonName || '—')) + '</span></div>' +
      '<div class="result-fact"><span class="fact-label">The word</span>' +
        '<span class="fact-value">' + escapeHtml(res.secretWord || '—') + '</span></div>';

    var foot;
    if (res.gameOver) {
      foot = res.isWinner ? '<p><strong>🏆 You win!</strong></p>' : '<p>Game over</p>';
    } else {
      foot = '<div class="result-fact"><span class="fact-label">Your place</span>' +
        '<span class="fact-value">' + (res.tied ? 'Tied for ' : '') + ordinal(res.rank) +
        ' of ' + res.totalPlayers + '</span></div>';
    }
    render('<div class="result-main">' + main + '</div><div class="result-foot">' + foot + '</div>');
  }

  function renderWaitReveal() {
    setReactionsAllowed(false);
    setAttribution(false);
    render('<h2>Hold tight…</h2><p>The reveal is on the big screen.</p>');
  }

  function renderFinal() {
    setReactionsAllowed(false);
    setAttribution(false);
    stopIntroTimer();
    render('<h2>Thanks for playing! 🦎</h2><p>Check the big screen for the final results.</p>');
  }

  // ---- Host presence ----
  function updateHostPresence(present) {
    var was = hostPresent;
    hostPresent = !!present;
    var ov = document.getElementById('hostAbsentOverlay');
    if (ov) ov.hidden = hostPresent;
    updateReactionState();
    if (was && !hostPresent) {
      stopIntroTimer();
      localStorage.removeItem('camo.playerId');
      localStorage.removeItem('camo.playerName');
    } else if (!was && hostPresent) {
      window.location.replace('/camo/join');
    }
  }
  socket.on('state:hostPresence', function (p) { updateHostPresence(!(p && p.present === false)); });

  // ---- Socket ----
  socket.on('connect', function () {
    if (rejected) return;
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (rejected) return;
      if (!res || !res.ok) {
        localStorage.removeItem('camo.playerId');
        localStorage.removeItem('camo.playerName');
        window.location.replace('/camo/join');
        return;
      }
      setName(res.player.name);
      setScore(res.player.score || 0);
      reactionsMutedByHost = !!res.reactionsMuted;
      hostPresent = res.hostPresent !== false;
      var ov = document.getElementById('hostAbsentOverlay');
      if (ov) ov.hidden = hostPresent;
      if (res.myRole) myRole = res.myRole;

      if (res.phase === 'LOBBY') { lobbyTotal = res.total || 0; renderLobby(); }
      else if (res.phase === 'INTRO') renderIntro(res.intro);
      else if (res.phase === 'ROLE') { roleAcked = !!res.acked; renderRole(); }
      else if (res.phase === 'CLUES') renderClues(res.clues);
      else if (res.phase === 'VOTE') renderVote(res.vote, res.myVote);
      else if (res.phase === 'GUESS') renderGuess(res.guess);
      else if (res.phase === 'REVEAL') { if (res.myResult) renderResult(res.myResult); else renderWaitReveal(); }
      else if (res.phase === 'FINAL') renderFinal();
      updateReactionState();
    });
  });

  socket.on('state:lobby', function (s) {
    if (s && typeof s.total === 'number') lobbyTotal = s.total;
    if (elView.querySelector('.lobby-hero')) renderLobby();
  });
  socket.on('state:intro', renderIntro);
  socket.on('you:role', function (r) { myRole = r; roleAcked = false; renderRole(); });
  socket.on('state:role', function () { if (!myRole) renderRole(); });
  socket.on('state:clues', renderClues);
  socket.on('state:vote', function (v) { renderVote(v, null); });
  socket.on('state:guess', renderGuess);
  socket.on('state:reveal', function () { /* per-player result arrives via player:result */ });
  socket.on('player:result', renderResult);
  socket.on('state:final', renderFinal);
  socket.on('state:reset', function () {
    var name = localStorage.getItem('camo.playerName') || '';
    if (name) localStorage.setItem('camo.rejoinName', name);
    localStorage.removeItem('camo.playerId');
    localStorage.removeItem('camo.playerName');
    window.location.replace('/camo/join');
  });

  socket.on('player:rejected', function (payload) {
    rejected = true;
    stopIntroTimer();
    setReactionsAllowed(false);
    var reason = payload && payload.reason;
    var savedName = localStorage.getItem('camo.playerName') || '';
    if (reason === 'kicked' || reason === 'reset') {
      if (savedName) localStorage.setItem('camo.rejoinName', savedName);
    }
    localStorage.removeItem('camo.playerId');
    localStorage.removeItem('camo.playerName');
    var msg = {
      'kicked': 'You were removed by the host.',
      'reset': 'The host has reset the game.',
    }[reason] || 'Disconnected.';
    reactionBar.hidden = true;
    elView.innerHTML =
      '<div class="state-card">' +
        '<h2>' + msg + '</h2>' +
        '<div class="card-actions"><button type="button" class="btn-accent" id="rejoinBtn">Rejoin</button></div>' +
      '</div>';
    var rj = document.getElementById('rejoinBtn');
    if (rj) rj.addEventListener('click', function () { window.location.replace('/camo/join'); });
  });

  socket.on('state:reactionsMuted', function (p) { reactionsMutedByHost = !!(p && p.muted); updateReactionState(); });

  // ---- Reaction bar ----
  var REACTION_COOLDOWN_MS = 10 * 1000;
  var REACTION_LS_KEY = 'camo.lastReactionAt';
  var reactionCooldown = document.getElementById('reactionCooldown');
  var reactionUntil = 0, cooldownRaf = null;
  var reactionBtns = Array.prototype.slice.call(reactionBar.querySelectorAll('.reaction-btn'));

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
  var storedLast = parseInt(localStorage.getItem(REACTION_LS_KEY) || '0', 10);
  if (storedLast && Date.now() - storedLast < REACTION_COOLDOWN_MS) {
    reactionUntil = storedLast + REACTION_COOLDOWN_MS;
    startCooldown();
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
