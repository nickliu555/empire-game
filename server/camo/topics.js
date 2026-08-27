'use strict';

const path = require('path');
const fs = require('fs');

// Curated topic bank. Generated/extended offline by scripts/gen-camo-topics.js
// and then hand-edited — never LLM-called at runtime.
//
// Shape: [{ id: string, topic: string, words: string[16] }, ...]

const GRID_SIZE = 16;
const MAX_WORD_LEN = 18;

const FALLBACK = [{
  id: 'fallback',
  topic: 'Animals',
  words: ['Elephant', 'Penguin', 'Kangaroo', 'Dolphin', 'Tiger', 'Owl', 'Snake', 'Sloth',
    'Wolf', 'Giraffe', 'Bat', 'Octopus', 'Hedgehog', 'Camel', 'Crocodile', 'Panda'],
}];

let RAW = [];
try {
  RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'topics.json'), 'utf8'));
  if (!Array.isArray(RAW)) RAW = [];
} catch (_) {
  RAW = [];
}

function cleanWord(raw) {
  if (typeof raw !== 'string') return '';
  const w = raw.replace(/[\r\n\t]+/g, ' ').trim().replace(/\s+/g, ' ');
  return w.length > MAX_WORD_LEN ? '' : w;
}

// Keep only well-formed topics: exactly 16 usable, case-insensitively distinct
// words. A malformed entry is dropped rather than shown with a short grid.
const seenTopics = new Set();
const TOPICS = [];
for (let i = 0; i < RAW.length; i++) {
  const t = RAW[i];
  const topic = t && typeof t.topic === 'string' ? t.topic.trim() : '';
  if (!topic) continue;
  const key = topic.toLowerCase();
  if (seenTopics.has(key)) continue;
  if (!t || !Array.isArray(t.words)) continue;

  const seenWords = new Set();
  const words = [];
  for (const raw of t.words) {
    const w = cleanWord(raw);
    if (!w) continue;
    const wk = w.toLowerCase();
    if (seenWords.has(wk)) continue;
    seenWords.add(wk);
    words.push(w);
  }
  if (words.length !== GRID_SIZE) continue;

  seenTopics.add(key);
  TOPICS.push({ id: t.id != null ? String(t.id) : 't' + i, topic, words });
}

function fisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A freshly shuffled copy of the whole bank. Each game draws without
 * replacement and reshuffles once the queue is exhausted.
 */
function buildQueue() {
  return fisherYates(TOPICS.length ? TOPICS : FALLBACK);
}

function count() {
  return TOPICS.length;
}

module.exports = { buildQueue, count, GRID_SIZE, MAX_WORD_LEN };
