'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Category Clash — the category bank + the letter die.
//
// categories.json is a hand-curated list of classic Scattergories-style
// prompts. At runtime we only read + shuffle it (no LLM calls needed here).
// Each round draws 12 fresh categories without replacement, so a single game
// never repeats a category.
// ─────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');

const CATEGORIES_PER_ROUND = 12;

// The 20 letters on a real Scattergories die (no J, Q, U, V, X or Z).
const LETTERS = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K',
  'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'W', 'Y',
];

let RAW = [];
try {
  RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'categories.json'), 'utf8'));
  if (!Array.isArray(RAW)) RAW = [];
} catch (_) {
  RAW = [];
}

// Defensive: keep only well-formed entries and dedupe by text.
const seen = new Set();
const CATEGORIES = [];
for (let i = 0; i < RAW.length; i++) {
  const text = typeof RAW[i] === 'string' ? RAW[i].trim() : '';
  if (!text) continue;
  const key = text.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  CATEGORIES.push({ id: 'c' + i, text });
}

// Absolute fallback so the game can never wedge on an empty/broken bank.
const FALLBACK = [
  'Animals', 'Fruits', 'Cities', 'Things in the kitchen', 'Sports',
  'Movie titles', 'Jobs or occupations', 'Things you wear', 'Colors',
  'Things that are cold', 'Board games', 'Things in outer space',
].map((text, i) => ({ id: 'f' + i, text }));

function fisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A freshly shuffled copy of the whole bank. A game builds one queue at start
 * and shifts 12 off it per round; if it ever runs dry it reshuffles.
 */
function buildQueue() {
  return fisherYates(CATEGORIES.length >= CATEGORIES_PER_ROUND ? CATEGORIES : FALLBACK);
}

/** A shuffled copy of the 20 playable letters (drawn without replacement). */
function buildLetterQueue() {
  return fisherYates(LETTERS);
}

function count() {
  return CATEGORIES.length;
}

module.exports = { buildQueue, buildLetterQueue, count, LETTERS, CATEGORIES_PER_ROUND };
