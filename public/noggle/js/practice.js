(function () {
  'use strict';

  // ============================================================
  // practice.js — solo Noggle practice mode (no socket).
  //
  // Fetches a freshly shaken board + its full solved word list from
  // /api/noggle/practice/board, then validates the player's traced words
  // entirely on the client. The timer counts UP (open-ended) and pauses
  // while the tab is hidden or an overlay is open — matching 24 practice.
  //
  // Board tracing (pointer drag + tap) is adapted from noggle/js/player.js.
  // ============================================================

  // ---------------- DOM refs ----------------
  const backBtn = document.getElementById('backBtn');
  const viewSetup = document.getElementById('view-setup');
  const viewPlay = document.getElementById('view-play');
  const sizePicker = document.getElementById('sizePicker');
  const startBtn = document.getElementById('startBtn');
  const setupLoading = document.getElementById('setupLoading');
  const setupError = document.getElementById('setupError');

  const timerDisplay = document.getElementById('timerDisplay');
  const foundCountEl = document.getElementById('foundCount');
  const totalCountEl = document.getElementById('totalCount');
  const scoreDisplay = document.getElementById('scoreDisplay');
  const maxScoreDisplay = document.getElementById('maxScoreDisplay');
  const sizeChip = document.getElementById('sizeChip');
  const sizeDisplay = document.getElementById('sizeDisplay');

  const playerBoard = document.getElementById('playerBoard');
  const currentWordEl = document.getElementById('currentWord');
  const wordFeedbackEl = document.getElementById('wordFeedback');
  const foundList = document.getElementById('foundList');
  const revealBtn = document.getElementById('revealBtn');
  const newBoardBtn = document.getElementById('newBoardBtn');

  const revealOverlay = document.getElementById('revealOverlay');
  const revealSummary = document.getElementById('revealSummary');
  const revealList = document.getElementById('revealList');
  const revealCloseBtn = document.getElementById('revealCloseBtn');
  const revealNewBtn = document.getElementById('revealNewBtn');

  const sizeOverlay = document.getElementById('sizeOverlay');
  const changeSizePicker = document.getElementById('changeSizePicker');
  const sizeCancelBtn = document.getElementById('sizeCancelBtn');
  const sizeApplyBtn = document.getElementById('sizeApplyBtn');

  // ---------------- Back navigation target ----------------
  function getBackTarget() {
    const params = new URLSearchParams(window.location.search);
    const from = (params.get('from') || '').toLowerCase();
    if (from === 'join') return '/noggle/join';
    if (from === 'play') return '/noggle/play';
    return '/';
  }

  // ---------------- Session state ----------------
  let selectedSize = 5;
  let board = null;          // 2D array of tile strings
  let boardSize = 4;
  let minWordLen = 3;
  let validWords = {};       // { UPPERWORD: points } for the current board
  let totalWords = 0;
  let maxScore = 0;
  let foundWords = new Set(); // uppercased words already found
  let score = 0;
  let loading = false;

  // ---------------- Count-up timer ----------------
  // Accumulate ms only while the play view is active, the tab is visible and
  // no overlay is open, so reading the reveal or backgrounding pauses it.
  let accumulatedMs = 0;
  let segmentStart = 0;     // 0 = paused
  let timerHandle = null;
  let viewActive = false;
  let pageVisible = (typeof document === 'undefined') ? true : !document.hidden;

  function overlayOpen() {
    return !revealOverlay.hidden || !sizeOverlay.hidden;
  }
  function shouldRun() { return viewActive && pageVisible && !overlayOpen(); }
  function currentElapsedMs() {
    return accumulatedMs + (segmentStart ? (Date.now() - segmentStart) : 0);
  }
  function reconcileTimer() {
    if (shouldRun()) {
      if (!segmentStart) segmentStart = Date.now();
    } else if (segmentStart) {
      accumulatedMs += Date.now() - segmentStart;
      segmentStart = 0;
    }
    paintTimer();
  }
  function startTimer() {
    stopTimer();
    paintTimer();
    timerHandle = setInterval(paintTimer, 1000);
  }
  function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } }
  function resetTimer() { accumulatedMs = 0; segmentStart = shouldRun() ? Date.now() : 0; paintTimer(); }
  function paintTimer() {
    const total = Math.floor(currentElapsedMs() / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    timerDisplay.textContent = m + ':' + (s < 10 ? '0' : '') + s;
  }
  function setViewActive(active) { viewActive = active; reconcileTimer(); }

  document.addEventListener('visibilitychange', function () {
    pageVisible = !document.hidden;
    reconcileTimer();
    if (document.hidden) saveSession();
  });

  // ---------------- Views ----------------
  function showView(name) {
    viewSetup.hidden = name !== 'setup';
    viewPlay.hidden = name !== 'play';
    setViewActive(name === 'play');
  }

  // ---------------- Persistence (survive page refresh) ----------------
  const STORAGE_KEY = 'noggle.practice.session';

  function saveSession() {
    if (!board) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        board: board,
        boardSize: boardSize,
        minWordLen: minWordLen,
        validWords: validWords,
        totalWords: totalWords,
        maxScore: maxScore,
        foundWords: Array.from(foundWords),
        score: score,
        elapsedMs: currentElapsedMs(),
        selectedSize: selectedSize
      }));
    } catch (_) {}
  }
  function clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }
  function restoreSession() {
    let data;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      data = JSON.parse(raw);
    } catch (_) { return false; }
    if (!data || !Array.isArray(data.board)) return false;
    selectedSize = data.selectedSize || data.boardSize || 5;
    boardSize = data.boardSize;
    minWordLen = data.minWordLen;
    validWords = data.validWords || {};
    totalWords = data.totalWords || 0;
    maxScore = data.maxScore || 0;
    foundWords = new Set(data.foundWords || []);
    score = data.score || 0;
    foundList.innerHTML = '';
    clearPath();
    setFeedback('', '');
    renderBoard(data.board, boardSize);
    foundWords.forEach(function (w) { addFoundChip(w, validWords[w] || 0, false); });
    paintStats();
    paintSizeChip();
    accumulatedMs = data.elapsedMs || 0;
    segmentStart = 0;
    showView('play');
    startTimer();
    return true;
  }

  window.addEventListener('pagehide', saveSession);
  window.addEventListener('beforeunload', saveSession);

  sizePicker.addEventListener('click', function (e) {
    const btn = e.target.closest('.size-card');
    if (!btn) return;
    Array.prototype.forEach.call(sizePicker.querySelectorAll('.size-card'), function (b) {
      b.classList.toggle('selected', b === btn);
    });
    selectedSize = Number(btn.dataset.size);
  });

  startBtn.addEventListener('click', function () {
    loadBoard(selectedSize);
  });

  // ---------------- Board loading ----------------
  function loadBoard(size) {
    if (loading) return;
    loading = true;
    setupError.hidden = true;
    setupLoading.hidden = false;
    fetch('/api/noggle/practice/board?size=' + encodeURIComponent(size))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.grid)) throw new Error('bad board');
        selectedSize = data.size;
        boardSize = data.size;
        minWordLen = data.minWordLen;
        validWords = data.words || {};
        totalWords = data.totalWords || 0;
        maxScore = data.maxScore || 0;
        beginBoard(data.grid);
      })
      .catch(function () {
        setupError.textContent = 'Could not load a board. Check your connection and try again.';
        setupError.hidden = false;
      })
      .then(function () {
        loading = false;
        setupLoading.hidden = true;
      });
  }

  function beginBoard(grid) {
    foundWords = new Set();
    score = 0;
    foundList.innerHTML = '';
    clearPath();
    setFeedback('', '');
    renderBoard(grid, boardSize);
    paintStats();
    paintSizeChip();
    showView('play');
    resetTimer();
    startTimer();
    saveSession();
  }

  function paintStats() {
    foundCountEl.textContent = foundWords.size;
    totalCountEl.textContent = totalWords;
    scoreDisplay.textContent = score;
    maxScoreDisplay.textContent = maxScore;
  }
  function paintSizeChip() {
    sizeDisplay.textContent = boardSize + '×' + boardSize;
  }

  // ---------------- Board render ----------------
  function renderBoard(grid, size) {
    board = grid;
    boardSize = size;
    playerBoard.style.setProperty('--n', size);
    playerBoard.innerHTML = grid.map(function (row, r) {
      return row.map(function (cell, c) {
        const disp = cell === 'QU' ? 'Qu' : cell;
        return '<div class="b-tile" data-r="' + r + '" data-c="' + c + '">' + escapeHtml(disp) + '</div>';
      }).join('');
    }).join('');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'trace-layer');
    svg.id = 'traceLayer';
    playerBoard.appendChild(svg);
  }

  // ---------------- Trace input (adapted from player.js) ----------------
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
    const rect = playerBoard.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const cellW = rect.width / boardSize;
    const cellH = rect.height / boardSize;
    let c = Math.floor((x - rect.left) / cellW);
    let r = Math.floor((y - rect.top) / cellH);
    if (r < 0 || r >= boardSize || c < 0 || c >= boardSize) return null;
    const fx = (x - rect.left) / cellW - c;
    const fy = (y - rect.top) / cellH - r;
    const M = 0.18;
    if (fx < M || fx > 1 - M || fy < M || fy > 1 - M) return null;
    return { r: r, c: c };
  }
  function wordFromPath() {
    return path.map(function (p) { return board[p.r][p.c]; }).join('');
  }
  function displayWord(w) { return String(w).replace(/QU/g, 'Qu'); }

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
      currentWordEl.textContent = displayWord(w);
      currentWordEl.classList.remove('empty');
    } else {
      currentWordEl.textContent = 'Trace a word';
      currentWordEl.classList.add('empty');
    }
    updateTraceLine();
  }

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
    pts.forEach(function (pt, i) {
      const r = (i === pts.length - 1) ? strokeW * 0.85 : strokeW * 0.5;
      inner += '<circle cx="' + pt[0].toFixed(1) + '" cy="' + pt[1].toFixed(1) + '" r="' + r.toFixed(1) + '" fill="#B47A17" fill-opacity="0.9"/>';
    });
    svg.innerHTML = inner;
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
    if (path.length === 0) return;
    const w = wordFromPath();
    clearPath();
    checkWord(w);
  }

  playerBoard.addEventListener('pointerdown', function (e) {
    const tileEl = e.target.closest('.b-tile');
    if (!tileEl) return;
    if (activePointer !== null) return;
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
    if (!moved) { moved = true; path = [dragStart]; renderPath(); }
    if (!cell) return;
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

  // ---------------- Word validation (local) ----------------
  function checkWord(rawWord) {
    const w = String(rawWord || '').toUpperCase();
    const letterLen = w.length; // QU tile already contributes 2 chars
    if (letterLen < minWordLen) { reject('Too short'); return; }
    if (foundWords.has(w)) { reject('Already found'); return; }
    if (!Object.prototype.hasOwnProperty.call(validWords, w)) { reject('Not a word'); return; }
    const pts = validWords[w];
    foundWords.add(w);
    score += pts;
    addFoundChip(w, pts, true);
    paintStats();
    setFeedback('good', '+' + pts + ' ' + displayWord(w));
    playChime();
    saveSession();
  }
  function reject(msg) {
    setFeedback('bad', msg);
    shakeBoard();
  }

  let feedbackTimer = null;
  function setFeedback(kind, text) {
    wordFeedbackEl.textContent = text || '';
    wordFeedbackEl.className = 'word-feedback' + (kind ? ' ' + kind : '');
    if (feedbackTimer) clearTimeout(feedbackTimer);
    if (text) feedbackTimer = setTimeout(function () {
      wordFeedbackEl.textContent = ''; wordFeedbackEl.className = 'word-feedback';
    }, 1600);
  }
  function shakeBoard() {
    playerBoard.classList.remove('shake');
    void playerBoard.offsetWidth;
    playerBoard.classList.add('shake');
  }

  function addFoundChip(word, points, isNew) {
    const chip = document.createElement('div');
    chip.className = 'found-chip' + (isNew ? ' new' : '');
    chip.innerHTML = escapeHtml(displayWord(word)) + '<span class="fc-pts">+' + points + '</span>';
    foundList.insertBefore(chip, foundList.firstChild);
  }

  // ---------------- Reveal all words ----------------
  revealBtn.addEventListener('click', openReveal);
  function openReveal() {
    const all = Object.keys(validWords).sort(function (a, b) {
      return (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0);
    });
    revealSummary.textContent = 'You found ' + foundWords.size + ' of ' + totalWords +
      ' words  ·  ' + score + ' / ' + maxScore + ' points';
    revealList.innerHTML = all.map(function (w) {
      const got = foundWords.has(w);
      return '<span class="reveal-chip' + (got ? ' got' : '') + '">' +
        escapeHtml(displayWord(w)) + '<span class="rc-pts">' + validWords[w] + '</span></span>';
    }).join('');
    revealOverlay.hidden = false;
    reconcileTimer();
  }
  revealCloseBtn.addEventListener('click', function () {
    revealOverlay.hidden = true;
    reconcileTimer();
  });
  revealNewBtn.addEventListener('click', function () {
    revealOverlay.hidden = true;
    loadBoard(boardSize);
  });

  // ---------------- New board ----------------
  newBoardBtn.addEventListener('click', function () { loadBoard(boardSize); });

  // ---------------- Change size ----------------
  let pendingSize = null;
  function updateSizeApplyState() {
    sizeApplyBtn.disabled = (pendingSize === null);
  }
  sizeChip.addEventListener('click', function () {
    pendingSize = boardSize;
    Array.prototype.forEach.call(changeSizePicker.querySelectorAll('.size-card'), function (b) {
      b.classList.toggle('selected', Number(b.dataset.size) === boardSize);
    });
    updateSizeApplyState();
    sizeOverlay.hidden = false;
    reconcileTimer();
  });
  changeSizePicker.addEventListener('click', function (e) {
    const btn = e.target.closest('.size-card');
    if (!btn) return;
    pendingSize = Number(btn.dataset.size);
    Array.prototype.forEach.call(changeSizePicker.querySelectorAll('.size-card'), function (b) {
      b.classList.toggle('selected', b === btn);
    });
    updateSizeApplyState();
  });
  sizeCancelBtn.addEventListener('click', function () {
    sizeOverlay.hidden = true;
    pendingSize = null;
    reconcileTimer();
  });
  sizeApplyBtn.addEventListener('click', function () {
    const size = pendingSize || boardSize;
    pendingSize = null;
    sizeOverlay.hidden = true;
    loadBoard(size);
  });

  // ---------------- Back ----------------
  backBtn.addEventListener('click', function () {
    clearSession();
    window.location.href = getBackTarget();
  });

  // ---------------- Audio ----------------
  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  }
  document.addEventListener('pointerdown', function () {
    try { const c = getAudioCtx(); if (c && c.state === 'suspended') c.resume(); } catch (_) {}
  }, { once: true });
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Double-tap-zoom guard (mirrors player.js) — skip the board (own gestures).
  (function guardDoubleTapZoom() {
    let lastTap = 0;
    document.addEventListener('touchend', function (e) {
      if (e.target && e.target.closest && e.target.closest('.b-board')) return;
      const now = Date.now();
      if (now - lastTap <= 350) e.preventDefault();
      lastTap = now;
    }, { passive: false });
  })();

  // ---------------- Init: resume an in-progress board after a refresh ----------------
  restoreSession();
})();
