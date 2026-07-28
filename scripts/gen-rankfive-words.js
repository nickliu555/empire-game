'use strict';

// ─────────────────────────────────────────────────────────────────────────
// ONE-TIME word/phrase bank generator for Rank Five.
//
// Run this ONCE (with a GROQ_API_KEY) to seed a large bank of interesting,
// opinion-worthy things to rank, then hand-edit the JSON to taste. It is NOT
// part of the runtime server.
//
//   GROQ_API_KEY=sk-... node scripts/gen-rankfive-words.js
//   GROQ_API_KEY=sk-... TARGET=400 node scripts/gen-rankfive-words.js
//
// By default it MERGES new items into the existing bank (deduped), so your
// hand-edits and the seed set are preserved. Pass FRESH=1 to overwrite.
// ─────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'server', 'rankfive', 'words.json');
const API_KEY = process.env.GROQ_API_KEY;
const TARGET = parseInt(process.env.TARGET || '400', 10);
const FRESH = /^(1|true|yes)$/i.test(process.env.FRESH || '');
const BATCH = 50;

if (!API_KEY) {
  console.error('✗ GROQ_API_KEY is not set. Export it and re-run:');
  console.error('    GROQ_API_KEY=sk-... node scripts/gen-rankfive-words.js');
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
`You are writing content for a party game called "Rank Five". Each round a player
is secretly given 5 of these items and ranks them 1-5 by their own personal
opinion, while the rest of the group tries to guess that person's order. There
is NO fixed category — items are drawn at random and mixed together.

Write ${BATCH} original items. Rules for every item:
- It must be a thing PEOPLE HAVE STRONG, DIVIDED OPINIONS ABOUT — great to rank
  by "love it → hate it", "best → worst", or "most → least fun".
- Mix of foods, animals, experiences, chores, activities, places, decades,
  superpowers, hobbies, everyday annoyances, and small joys.
- Short: 1-4 words, or a short phrase (e.g. "Getting a tattoo", "Cold pizza for
  breakfast", "Public speaking", "The 1980s").
- Concrete and instantly understood — no abstract concepts, no trivia, nothing
  requiring specialized knowledge.
- Family-friendly. Nothing offensive, political, or tragic.
- No duplicates, no near-duplicates within your list.

Respond ONLY with valid JSON, no markdown:
{"items": ["Pizza", "Getting a tattoo", "Mondays", "..."]}`;

async function generateBatch() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
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
        temperature: 1.1,
        max_tokens: 1600,
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
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (e) {
    console.warn('  … batch error:', e.message);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function cleanText(t) {
  let s = String(t || '').trim().replace(/\s+/g, ' ');
  // Strip surrounding quotes and a trailing period (items read best bare).
  s = s.replace(/^["']|["']$/g, '').replace(/\.$/, '').trim();
  if (!s) return '';
  if (s.length > 40) return '';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

(async () => {
  const existing = loadExisting();
  const byKey = new Map();
  const out = [];
  for (const item of existing) {
    const text = cleanText(typeof item === 'string' ? item : (item && item.text));
    if (!text) continue;
    const key = text.toLowerCase();
    if (byKey.has(key)) continue;
    byKey.set(key, true);
    out.push(text);
  }

  console.log(`Starting with ${out.length} existing item(s). Target: ${TARGET}.`);
  let attempts = 0;
  while (out.length < TARGET && attempts < 40) {
    attempts++;
    process.stdout.write(`  batch ${attempts} (have ${out.length})… `);
    const batch = await generateBatch();
    let added = 0;
    for (const raw of batch) {
      const text = cleanText(raw);
      if (!text) continue;
      const key = text.toLowerCase();
      if (byKey.has(key)) continue;
      byKey.set(key, true);
      out.push(text);
      added++;
    }
    console.log(`+${added}`);
    if (added === 0 && attempts > 3) break;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`✓ Wrote ${out.length} item(s) to ${OUT_FILE}`);
})();
