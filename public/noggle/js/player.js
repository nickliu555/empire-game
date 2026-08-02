(function () {
  'use strict';

  const playerId = localStorage.getItem('noggle.playerId');
  const playerName = localStorage.getItem('noggle.playerName') || 'Player';
  if (!playerId) { window.location.replace('/noggle/join'); return; }

  const socket = io('/noggle', { transports: ['polling', 'websocket'] });

  // ---------------- Element refs ----------------
  const views = {
    lobby: document.getElementById('view-lobby'),
    intro: document.getElementById('view-intro'),
    round: document.getElementById('view-round'),
    'final-wait': document.getElementById('view-final-wait'),
    final: document.getElementById('view-final'),
    kicked: document.getElementById('view-kicked'),
  };
  const meName = document.getElementById('meName');
  const meScore = document.getElementById('meScore');
  const pCountdown = document.getElementById('pCountdown');
  const pIntroCountdown = document.getElementById('pIntroCountdown');

  const playerBoard = document.getElementById('playerBoard');
  const currentWordEl = document.getElementById('currentWord');
  const wordFeedbackEl = document.getElementById('wordFeedback');
  const foundList = document.getElementById('foundList');
  const foundCountEl = document.getElementById('foundCount');

  const finalRankLine = document.getElementById('finalRankLine');
  const finalScoreEl = document.getElementById('finalScore');
  const finalWordsEl = document.getElementById('finalWords');
  const finalWordsList = document.getElementById('finalWordsList');
  const finalTitle = document.getElementById('finalTitle');

  const reactionBar = document.getElementById('reactionBar');
  const reactionCooldown = document.getElementById('reactionCooldown');
  const playerAttribution = document.getElementById('playerAttribution');
  const hostAbsentOverlay = document.getElementById('hostAbsentOverlay');
  const kickRejoinBtn = document.getElementById('kickRejoinBtn');

  meName.textContent = playerName;

  // Belt-and-suspenders double-tap-zoom guard. iOS Safari can still
  // double-tap-zoom on cards/buttons/text despite touch-action:manipulation,
  // so swallow the second tap's default. Applied to the whole player shell but
  // NOT the board (which handles its own tracing gestures + touch-action:none).
  (function guardDoubleTapZoom() {
    let lastTap = 0;
    document.addEventListener('touchend', function (e) {
      if (e.target && e.target.closest && e.target.closest('.b-board')) return;
      const now = Date.now();
      if (now - lastTap <= 350) e.preventDefault();
      lastTap = now;
    }, { passive: false });
  })();

  // ---------------- State ----------------
  let board = null;        // 2D array of cell strings
  let boardSize = 4;
  let myScore = 0;
  let foundWords = new Set(); // lowercased words already found (dedupe chips)
  let currentPhase = 'LOBBY';
  let clockOffset = 0;
  function serverNow() { return Date.now() + clockOffset; }

  function showView(name) {
    Object.keys(views).forEach(function (k) {
      if (!views[k]) return;
      views[k].style.display = (k === name) ? '' : 'none';
    });
    const social = (name === 'lobby' || name === 'final');
    if (reactionBar) reactionBar.hidden = !social;
    // The credit is lobby-only — it must not come back on the final screen.
    if (playerAttribution) playerAttribution.hidden = (name !== 'lobby');
  }
  function setScore(v) { myScore = v; meScore.textContent = v; }

  // ---------------- Boot / reconnect ----------------
  socket.on('connect', function () {
    socket.emit('player:reconnect', { playerId: playerId }, function (res) {
      if (!res || !res.ok) {
        // Session no longer valid (e.g. host reset) — bounce to join.
        localStorage.setItem('noggle.rejoinName', playerName);
        localStorage.removeItem('noggle.playerId');
        window.location.replace('/noggle/join');
        return;
      }
      setHostPresent(res.hostPresent !== false);
      applyPhase(res);
    });
  });

  function applyPhase(res) {
    currentPhase = res.phase;
    if (res.phase === 'LOBBY') { showView('lobby'); pCountdown.textContent = '—'; pCountdown.classList.remove('warn', 'urgent'); }
    else if (res.phase === 'INTRO') { renderIntro(res.intro); }
    else if (res.phase === 'ROUND') {
      restoreYou(res.you);
      applyRound(res.round);
    }
    else if (res.phase === 'FINAL') { renderFinal(res.youFinal, res); }
  }

  function restoreYou(you) {
    foundWords = new Set();
    foundList.innerHTML = '';
    setScore((you && you.score) || 0);
    const words = (you && you.words) || [];
    words.forEach(function (w) { addFoundChip(w.word, w.points, false); });
    foundCountEl.textContent = (you && you.wordCount) || words.length;
  }

  // ---------------- Intro ----------------
  let introTimer = null;
  function renderIntro(payload) {
    currentPhase = 'INTRO';
    cancelFinalWait();
    showView('intro');
    if (introTimer) clearInterval(introTimer);
    if (payload && typeof payload.serverNow === 'number') clockOffset = payload.serverNow - Date.now();
    const endsAt = (payload && payload.endsAt) || (Date.now() + 4000);
    function tick() {
      const left = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      pIntroCountdown.textContent = left <= 0 ? 'Go!' : String(left);
      if (left <= 0 && introTimer) { clearInterval(introTimer); introTimer = null; }
    }
    tick();
    introTimer = setInterval(tick, 200);
  }
  socket.on('state:intro', function (p) { renderIntro(p); });

  // ---------------- Round ----------------
  let countdownTimer = null;
  let roundEndsAt = 0;
  let lastTickSec = null;
  function applyRound(round) {
    if (!round) return;
    currentPhase = 'ROUND';
    cancelFinalWait();
    showView('round');
    clearPath();
    setFeedback('', '');
    if (typeof round.serverNow === 'number') clockOffset = round.serverNow - Date.now();
    roundEndsAt = round.roundEndsAt;
    lastTickSec = null;
    renderBoard(round.board);
    tickCountdown();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(tickCountdown, 250);
  }
  function tickCountdown() {
    const ms = Math.max(0, roundEndsAt - serverNow());
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    pCountdown.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    pCountdown.classList.toggle('warn', totalSec <= 10 && totalSec > 5);
    pCountdown.classList.toggle('urgent', totalSec <= 5 && totalSec > 0);
    if (ms <= 0 && countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }
  socket.on('state:round', function (r) { applyRound(r); });

  function renderBoard(b) {
    if (!b || !b.grid) return;
    board = b.grid;
    boardSize = b.size;
    playerBoard.style.setProperty('--n', boardSize);
    playerBoard.innerHTML = board.map(function (row, r) {
      return row.map(function (cell, c) {
        const disp = cell === 'QU' ? 'Qu' : cell;
        return '<div class="b-tile" data-r="' + r + '" data-c="' + c + '">' + escapeHtml(disp) + '</div>';
      }).join('');
    }).join('');
    // Overlay SVG for the trace connection line (drawn on top of the tiles,
    // pointer-events:none so it never blocks the drag). Rebuilt with the board.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'trace-layer');
    svg.id = 'traceLayer';
    playerBoard.appendChild(svg);
  }

  // ---------------- Trace input ----------------
  let path = [];
  let dragging = false;
  let moved = false;
  let dragStart = null;
  let activePointer = null;

  function sameCell(a, b) { return a && b && a.r === b.r && a.c === b.c; }
  function inPath(cell) { return path.some(function (p) { return sameCell(p, cell); }); }
  function adjacent(a, b) {
    const dr = Math.abs(a.r - b.r), dc = Math.abs(a.c - b.c);
    return dr <= 1 && dc <= 1 && (dr !== 0 || dc !== 0);
  }
  function tileAt(x, y) {
    // Geometry-based hit detection: map the pointer to a cell from the board's
    // rect rather than elementFromPoint. This removes the dead zone over the
    // gaps between tiles (which otherwise breaks diagonal dragging, since a
    // diagonal drag passes through the corner where four tiles meet). A small
    // inset margin is ignored so the very edges/corners don't misfire.
    const rect = playerBoard.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const cellW = rect.width / boardSize;
    const cellH = rect.height / boardSize;
    let c = Math.floor((x - rect.left) / cellW);
    let r = Math.floor((y - rect.top) / cellH);
    if (r < 0 || r >= boardSize || c < 0 || c >= boardSize) return null;
    // Require the point to fall within the tile's body, not the surrounding
    // gap, so a diagonal drag only picks up the diagonal tile once the finger
    // is actually over it (prevents accidental orthogonal detours).
    const fx = (x - rect.left) / cellW - c; // 0..1 within the cell horizontally
    const fy = (y - rect.top) / cellH - r;  // 0..1 within the cell vertically
    const M = 0.18; // ignore the outer ~18% band (the gap region)
    if (fx < M || fx > 1 - M || fy < M || fy > 1 - M) return null;
    return { r: r, c: c };
  }
  function wordFromPath() {
    return path.map(function (p) { return board[p.r][p.c]; }).join('');
  }
  function renderPath() {
    playerBoard.querySelectorAll('.b-tile').forEach(function (t) {
      t.classList.remove('in-path', 'path-last');
    });
    path.forEach(function (p, i) {
      const t = playerBoard.querySelector('.b-tile[data-r="' + p.r + '"][data-c="' + p.c + '"]');
      if (!t) return;
      t.classList.add('in-path');
      if (i === path.length - 1) t.classList.add('path-last');
    });
    const w = wordFromPath();
    if (w) {
      currentWordEl.textContent = w === '' ? '' : displayWord(w);
      currentWordEl.classList.remove('empty');
    } else {
      currentWordEl.textContent = 'Trace a word';
      currentWordEl.classList.add('empty');
    }
    updateTraceLine();
  }

  // Draw the connecting line through the centres of the traced tiles into the
  // board's SVG overlay. Coordinates are the tiles' offsets within the board
  // (their offsetParent), matched by the SVG viewBox, so it stays aligned at
  // any board size.
  function updateTraceLine() {
    const svg = document.getElementById('traceLayer');
    if (!svg) return;
    const w = playerBoard.clientWidth;
    const h = playerBoard.clientHeight;
    if (!w || !h) { svg.innerHTML = ''; return; }
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    if (path.length === 0) { svg.innerHTML = ''; return; }
    const pts = [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const t = playerBoard.querySelector('.b-tile[data-r="' + p.r + '"][data-c="' + p.c + '"]');
      if (!t) continue;
      pts.push([t.offsetLeft + t.offsetWidth / 2, t.offsetTop + t.offsetHeight / 2]);
    }
    if (!pts.length) { svg.innerHTML = ''; return; }
    const strokeW = Math.max(6, w * 0.045);
    let inner = '';
    if (pts.length >= 2) {
      const d = pts.map(function (pt, i) { return (i === 0 ? 'M' : 'L') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1); }).join(' ');
      inner += '<path d="' + d + '" fill="none" stroke="#B47A17" stroke-opacity="0.85" stroke-width="' + strokeW.toFixed(1) + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    // A dot at each node; the last one (current tile) is emphasised.
    pts.forEach(function (pt, i) {
      const r = (i === pts.length - 1) ? strokeW * 0.85 : strokeW * 0.5;
      inner += '<circle cx="' + pt[0].toFixed(1) + '" cy="' + pt[1].toFixed(1) + '" r="' + r.toFixed(1) + '" fill="#B47A17" fill-opacity="0.9"/>';
    });
    svg.innerHTML = inner;
  }
  function displayWord(w) {
    // Render QU tiles as "Qu" within the uppercase word for readability.
    return w.replace(/QU/g, 'Qu');
  }
  function clearPath() { path = []; renderPath(); }

  function handleTap(cell) {
    if (path.length === 0) { path = [cell]; renderPath(); return; }
    const last = path[path.length - 1];
    if (sameCell(cell, last)) { submitPath(); return; }
    if (inPath(cell)) return;
    if (adjacent(last, cell)) { path.push(cell); renderPath(); return; }
    path = [cell]; renderPath();
  }

  function submitPath() {
    if (path.length === 0 || currentPhase !== 'ROUND') return;
    const submitting = path.slice();
    socket.emit('player:word', { path: submitting }, handleWordResult);
    clearPath();
  }

  playerBoard.addEventListener('pointerdown', function (e) {
    if (currentPhase !== 'ROUND') return;
    const tileEl = e.target.closest('.b-tile');
    if (!tileEl) return;
    if (activePointer !== null) return; // ignore secondary touches
    e.preventDefault();
    activePointer = e.pointerId;
    dragging = true;
    moved = false;
    dragStart = { r: Number(tileEl.dataset.r), c: Number(tileEl.dataset.c) };
    try { playerBoard.setPointerCapture(e.pointerId); } catch (_) {}
  });

  playerBoard.addEventListener('pointermove', function (e) {
    if (!dragging || e.pointerId !== activePointer) return;
    e.preventDefault();
    const cell = tileAt(e.clientX, e.clientY);
    if (!moved) {
      // First movement commits this gesture to a fresh drag-traced word.
      moved = true;
      path = [dragStart];
      renderPath();
    }
    if (!cell) return;
    // Backtrack: dragging back onto the second-to-last tile removes the last.
    if (path.length >= 2 && sameCell(cell, path[path.length - 2])) { path.pop(); renderPath(); return; }
    const last = path[path.length - 1];
    if (!inPath(cell) && adjacent(last, cell)) { path.push(cell); renderPath(); }
  });

  function endPointer(e) {
    if (!dragging || (activePointer !== null && e.pointerId !== activePointer)) return;
    dragging = false;
    activePointer = null;
    if (moved) submitPath();
    else if (dragStart) handleTap(dragStart);
    dragStart = null;
  }
  playerBoard.addEventListener('pointerup', endPointer);
  playerBoard.addEventListener('pointercancel', function (e) {
    if (e.pointerId !== activePointer) return;
    dragging = false; activePointer = null; dragStart = null;
  });

  let feedbackTimer = null;
  function setFeedback(kind, text) {
    wordFeedbackEl.textContent = text || '';
    wordFeedbackEl.className = 'word-feedback' + (kind ? ' ' + kind : '');
    if (feedbackTimer) clearTimeout(feedbackTimer);
    if (text) feedbackTimer = setTimeout(function () { wordFeedbackEl.textContent = ''; wordFeedbackEl.className = 'word-feedback'; }, 1600);
  }
  function shakeBoard() {
    playerBoard.classList.remove('shake');
    void playerBoard.offsetWidth;
    playerBoard.classList.add('shake');
  }

  function handleWordResult(res) {
    if (!res || !res.ok) {
      const map = { 'not-adjacent': 'Letters must connect', 'cell-reused': 'Can\'t reuse a tile', 'round-over': 'Round over' };
      setFeedback('bad', map[res && res.reason] || 'Invalid');
      shakeBoard();
      return;
    }
    if (res.accepted) {
      setScore(res.score);
      foundCountEl.textContent = res.wordCount;
      addFoundChip(res.word, res.points, true);
      setFeedback('good', '+' + res.points + ' ' + displayWord(res.word));
      playChime();
    } else {
      const map = { 'too-short': 'Too short', 'already-found': 'Already found', 'not-a-word': 'Not a word' };
      setFeedback('bad', map[res.reason] || 'Nope');
      shakeBoard();
    }
  }

  function addFoundChip(word, points, isNew) {
    const key = String(word).toLowerCase();
    if (foundWords.has(key)) return;
    foundWords.add(key);
    const chip = document.createElement('div');
    chip.className = 'found-chip' + (isNew ? ' new' : '');
    chip.innerHTML = escapeHtml(displayWord(word)) + '<span class="fc-pts">+' + points + '</span>';
    // Newest first.
    foundList.insertBefore(chip, foundList.firstChild);
  }

  // ---------------- Final ----------------
  // The host plays a ~3.8s "Time's up! → Now for the results…" splash before
  // the podium appears. Hold the phone on the "Look up!" card for the same beat
  // so the personal recap reveals in sync with the host podium, instead of
  // popping up the instant the round ends. Kept in sync with host.js
  // showFinalIntro().
  const FINAL_WAIT_MS = 3800;
  let finalWaitTimer = null;
  let pendingFinal = null;
  let finalRevealed = false;
  function cancelFinalWait() {
    if (finalWaitTimer) { clearTimeout(finalWaitTimer); finalWaitTimer = null; }
  }
  socket.on('state:final', function () {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    // Land the header timer on 0:00 (the 250ms tick may otherwise freeze it at
    // 0:01 when the round-end broadcast arrives mid-interval).
    pCountdown.textContent = '0:00';
    pCountdown.classList.remove('warn', 'urgent');
    currentPhase = 'FINAL';
    finalRevealed = false;
    showView('final-wait');
    cancelFinalWait();
    finalWaitTimer = setTimeout(function () {
      finalWaitTimer = null;
      finalRevealed = true;
      renderFinal(pendingFinal || {});
    }, FINAL_WAIT_MS);
  });
  socket.on('you:final', function (data) {
    // Stash it; only render now if the reveal beat has already elapsed
    // (otherwise the timer above reveals it in sync with the host podium).
    pendingFinal = data;
    if (finalRevealed) renderFinal(pendingFinal);
  });

  function renderFinal(youFinal, snapshot) {
    currentPhase = 'FINAL';
    finalRevealed = true;
    cancelFinalWait();
    const data = youFinal || {};
    const rank = data.rank;
    const total = data.total || (snapshot && snapshot.fullLeaderboard && snapshot.fullLeaderboard.length);
    finalScoreEl.textContent = data.score || 0;
    finalWordsEl.textContent = data.wordCount || 0;
    if (rank === 1) { finalTitle.textContent = '🥇 You won!'; finalRankLine.textContent = '1st place!'; }
    else if (rank) { finalRankLine.textContent = ordinal(rank) + (total ? ' of ' + total : ''); finalTitle.textContent = '🏁 Time\'s up!'; }
    else { finalRankLine.textContent = ''; }
    const words = (data.words || []);
    finalWordsList.innerHTML = words.length
      ? words.map(function (w) {
          return '<div class="found-chip">' + escapeHtml(displayWord(w.word)) + '<span class="fc-pts">+' + w.points + '</span></div>';
        }).join('')
      : '<div class="found-empty">No words this round.</div>';
    showView('final');
  }

  // ---------------- Reset / kick / host presence ----------------
  socket.on('state:reset', function () {
    localStorage.setItem('noggle.rejoinName', playerName);
    localStorage.removeItem('noggle.playerId');
    window.location.replace('/noggle/join');
  });
  socket.on('player:rejected', function (p) {
    if (p && p.reason === 'kicked') {
      localStorage.setItem('noggle.rejoinName', playerName);
      localStorage.removeItem('noggle.playerId');
      showView('kicked');
    }
  });
  if (kickRejoinBtn) kickRejoinBtn.addEventListener('click', function () { window.location.replace('/noggle/join'); });

  function setHostPresent(present) { if (hostAbsentOverlay) hostAbsentOverlay.hidden = !!present; }
  socket.on('state:hostPresence', function (p) { setHostPresent(!(p && p.present === false)); });

  // ---------------- Reactions ----------------
  let reactionsMuted = false;
  const REACTION_COOLDOWN_MS = 10 * 1000;
  socket.on('state:reactionsMuted', function (p) { reactionsMuted = !!(p && p.muted); });
  if (reactionBar) {
    reactionBar.addEventListener('click', function (e) {
      const btn = e.target.closest('.reaction-btn');
      if (!btn) return;
      const index = Number(btn.dataset.reaction);
      socket.emit('player:reaction', { index: index }, function (res) {
        if (res && res.ok) startReactionCooldown(REACTION_COOLDOWN_MS);
        else if (res && res.reason === 'cooldown') startReactionCooldown(res.retryInMs || REACTION_COOLDOWN_MS);
      });
    });
  }
  let cooldownTimer = null;
  function setReactionBtnsDisabled(disabled) {
    if (!reactionBar) return;
    reactionBar.classList.toggle('on-cooldown', !!disabled);
    reactionBar.querySelectorAll('.reaction-btn').forEach(function (b) { b.disabled = !!disabled; });
  }
  function startReactionCooldown(ms) {
    if (!reactionCooldown) return;
    const until = Date.now() + ms;
    reactionCooldown.hidden = false;
    setReactionBtnsDisabled(true);
    function tick() {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      reactionCooldown.textContent = left + 's';
      if (left <= 0) {
        reactionCooldown.hidden = true;
        setReactionBtnsDisabled(false);
        if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
      }
    }
    tick();
    if (cooldownTimer) clearInterval(cooldownTimer);
    cooldownTimer = setInterval(tick, 250);
  }

  // ---------------- Audio ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  }
  document.addEventListener('pointerdown', function () { try { const c = getAudioCtx(); if (c && c.state === 'suspended') c.resume(); } catch (_) {} }, { once: true });
  function playChime() {
    const ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    [[784, 0, 0.1], [1046, 0.08, 0.14]].forEach(function (n) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n[0];
      const st = t + n[1];
      gain.gain.setValueAtTime(0, st);
      gain.gain.linearRampToValueAtTime(0.28, st + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, st + n[2]);
      osc.connect(gain).connect(ctx.destination);
      osc.start(st);
      osc.stop(st + n[2] + 0.02);
    });
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
