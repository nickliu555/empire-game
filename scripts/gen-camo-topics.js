'use strict';

// ─────────────────────────────────────────────────────────────────────────
// ONE-TIME topic-grid generator for Camo.
//
// Run this ONCE (with a GROQ_API_KEY) to seed a larger bank of 4x4 word
// grids, then hand-edit the JSON to taste. It is NOT part of the runtime
// server.
//
//   GROQ_API_KEY=sk-... node scripts/gen-camo-topics.js
//   GROQ_API_KEY=sk-... TARGET=120 node scripts/gen-camo-topics.js
//
// By default it MERGES new topics into the existing bank (deduped by topic
// name), so hand-edits and the seed set are preserved. Pass FRESH=1 to
// overwrite.
// ─────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'server', 'camo', 'topics.json');
const API_KEY = process.env.GROQ_API_KEY;
const TARGET = parseInt(process.env.TARGET || '120', 10);
const FRESH = /^(1|true|yes)$/i.test(process.env.FRESH || '');
const BATCH = 5;
const GRID_SIZE = 16;
const MAX_WORD_LEN = 18;

if (!API_KEY) {
  console.error('✗ GROQ_API_KEY is not set. Export it and re-run:');
  console.error('    GROQ_API_KEY=sk-... node scripts/gen-camo-topics.js');
  process.exit(1);
}

function loadExisting() {
  if (FRESH) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

const PROMPT =
`You are writing content for a party game called "Camo" (a hidden-role word
game). Each round the group sees one topic and a 4x4 grid of ${GRID_SIZE} words from
that topic. Everyone except one player also knows which of the ${GRID_SIZE} words is the
secret one; that player has to bluff a one-word clue without knowing it.

Write ${BATCH} original topics. Rules for every topic:
- "topic" is a short, instantly understood category (1-3 words), e.g.
  "Animals", "Kitchen Things", "At the Beach", "Movie Genres".
- "words" is exactly ${GRID_SIZE} items that clearly belong to that topic.
- Every word is at most ${MAX_WORD_LEN} characters, 1-2 words long, concrete, and
  well known to any adult — no trivia, no proper nouns needing expertise.
- The ${GRID_SIZE} words must be distinct and reasonably comparable to each other, so
  a one-word clue could plausibly fit several of them.
- Family-friendly. Nothing offensive, political, or tragic.
- No duplicate topics and no duplicate words within a topic.

Respond ONLY with valid JSON, no markdown:
{"topics": [{"topic": "Animals", "words": ["Elephant", "Penguin", "..."]}]}`;

async function generateBatch() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: PROMPT }],
        temperature: 1.05,
        max_tokens: 2400,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(`  … batch failed (HTTP ${resp.status})`);
      return [];
    }
    const data = await resp.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed.topics) ? parsed.topics : [];
  } catch (e) {
    console.warn('  … batch error:', e.message);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function cleanWord(t) {
  let s = String(t || '').trim().replace(/\s+/g, ' ');
  s = s.replace(/^["']|["']$/g, '').replace(/\.$/, '').trim();
  if (!s || s.length > MAX_WORD_LEN) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Returns a normalised entry, or null when the grid can't be made valid.
function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const topic = cleanWord(raw.topic);
  if (!topic || !Array.isArray(raw.words)) return null;
  const seen = new Set();
  const words = [];
  for (const w of raw.words) {
    const word = cleanWord(w);
    if (!word) continue;
    const key = word.toLowerCase();
    if (key === topic.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    words.push(word);
    if (words.length === GRID_SIZE) break;
  }
  if (words.length !== GRID_SIZE) return null;
  return { topic, words };
}

(async () => {
  const byTopic = new Map();
  for (const raw of loadExisting()) {
    const entry = cleanEntry(raw);
    if (!entry) continue;
    byTopic.set(entry.topic.toLowerCase(), entry);
  }

  console.log(`Starting with ${byTopic.size} existing topic(s). Target: ${TARGET}.`);
  let attempts = 0;
  while (byTopic.size < TARGET && attempts < 60) {
    attempts++;
    process.stdout.write(`  batch ${attempts} (have ${byTopic.size})… `);
    const batch = await generateBatch();
    let added = 0;
    for (const raw of batch) {
      const entry = cleanEntry(raw);
      if (!entry) continue;
      const key = entry.topic.toLowerCase();
      if (byTopic.has(key)) continue;
      byTopic.set(key, entry);
      added++;
    }
    console.log(`+${added}`);
    if (added === 0 && attempts > 3) break;
  }

  const out = Array.from(byTopic.values()).map((entry, i) => ({
    id: 't' + (i + 1),
    topic: entry.topic,
    words: entry.words,
  }));
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`✓ Wrote ${out.length} topic(s) to ${OUT_FILE}`);
})();
