'use strict';

const path = require('path');
const fs = require('fs');

// Load the curated word/phrase bank. This JSON is seeded ONCE (offline) by
// scripts/gen-rankfive-words.js and then hand-edited by the maintainer. At
// runtime we only read + shuffle it — no LLM calls needed.
//
// Shape: ["Pizza", "Getting a tattoo", "Mondays", ...]  (flat array of strings)
// (Objects of the form { text } are also tolerated for forward-compat.)
let RAW = [];
try {
  RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'words.json'), 'utf8'));
  if (!Array.isArray(RAW)) RAW = [];
} catch (_) {
  RAW = [];
}

// Defensive: keep only well-formed entries, trim, and dedupe (case-insensitive).
const seen = new Set();
const WORDS = [];
for (let i = 0; i < RAW.length; i++) {
  const entry = RAW[i];
  const text = typeof entry === 'string'
    ? entry.trim()
    : (entry && typeof entry.text === 'string' ? entry.text.trim() : '');
  if (!text) continue;
  const key = text.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  WORDS.push(text.replace(/\s+/g, ' '));
}

// Last-ditch fallback so the game never wedges on an empty/missing bank.
const FALLBACK = [
  'Pizza', 'Mondays', 'Cats', 'Public speaking', 'Winning the lottery',
  'Bacon', 'Going to the dentist', 'Rainy days', 'Coffee', 'Long road trips',
];

function fisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A freshly shuffled copy of the whole bank of unique words. A game draws from
 * this pool WITHOUT replacement; if a single game needs more items than the
 * bank holds (lots of players), the game layer reshuffles for cross-round reuse.
 */
function buildPool() {
  const base = WORDS.length ? WORDS : FALLBACK;
  return fisherYates(base);
}

function count() {
  return (WORDS.length ? WORDS : FALLBACK).length;
}

module.exports = { buildPool, count };
