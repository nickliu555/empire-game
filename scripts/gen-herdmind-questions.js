'use strict';

// ─────────────────────────────────────────────────────────────────────────
// ONE-TIME question-bank generator for Herd Mind.
//
// Run this ONCE (with a GROQ_API_KEY) to populate a large bank of
// Herd-Mentality-style "Name a/an…" questions, then hand-edit the JSON to
// taste. It is NOT part of the runtime server.
//
//   GROQ_API_KEY=sk-... node scripts/gen-herdmind-questions.js
//   GROQ_API_KEY=sk-... TARGET=250 node scripts/gen-herdmind-questions.js
//
// By default it MERGES new questions into the existing bank (deduped), so your
// hand-edits and the seed set are preserved. Pass FRESH=1 to overwrite.
// ─────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GROQ_MODEL, GROQ_CHAT_URL } = require('../server/groq');

const OUT_FILE = path.join(__dirname, '..', 'server', 'herdmind', 'questions.json');
const API_KEY = process.env.GROQ_API_KEY;
const TARGET = parseInt(process.env.TARGET || '250', 10);
const FRESH = /^(1|true|yes)$/i.test(process.env.FRESH || '');
const BATCH = 40;

if (!API_KEY) {
  console.error('✗ GROQ_API_KEY is not set. Export it and re-run:');
  console.error('    GROQ_API_KEY=sk-... node scripts/gen-herdmind-questions.js');
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
`You are writing questions for a party game like "Herd Mentality", where players
try to match the MOST POPULAR answer with the rest of the group.

Write ${BATCH} original, family-friendly questions. Rules for every question:
- Phrase it as "Name a…" / "Name an…" / "Name something…".
- It must be CONVERGENT: a crowd can plausibly agree on a top answer. Avoid
  questions with thousands of equally-valid answers (no "name a word", no
  "name a number").
- Keep it short (under ~12 words) and easy to answer instantly.
- Everyday topics: food, animals, movies, places, household items, sports,
  seasons, jobs, etc. Keep it broadly relatable, not niche trivia.
- No questions requiring specialized knowledge, and nothing offensive.

Respond ONLY with valid JSON, no markdown:
{"questions": ["Name a yellow fruit.", "Name a farm animal.", "..."]}`;

async function generateBatch() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: PROMPT }],
        temperature: 1.0,
        max_tokens: 6144,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(`  … batch failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`);
      return [];
    }
    const data = await resp.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch (e) {
    console.warn('  … batch error:', e.message);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function cleanText(t) {
  let s = String(t || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (!/[.?!]$/.test(s)) s += '.';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

(async () => {
  const existing = loadExisting();
  const byKey = new Map();
  const out = [];
  let idn = 0;
  for (const q of existing) {
    const text = cleanText(q && q.text);
    if (!text) continue;
    const key = text.toLowerCase();
    if (byKey.has(key)) continue;
    byKey.set(key, true);
    out.push({ id: q.id != null ? String(q.id) : 'q' + (++idn), text });
  }
  idn = out.length;

  console.log(`Starting with ${out.length} existing question(s). Target: ${TARGET}.`);
  let attempts = 0;
  while (out.length < TARGET && attempts < Math.ceil(TARGET / BATCH) + 6) {
    attempts++;
    process.stdout.write(`  batch ${attempts} … `);
    const batch = await generateBatch();
    let added = 0;
    for (const raw of batch) {
      const text = cleanText(raw);
      if (!text) continue;
      const key = text.toLowerCase();
      if (byKey.has(key)) continue;
      byKey.set(key, true);
      out.push({ id: 'q' + (++idn), text });
      added++;
    }
    console.log(`+${added} (total ${out.length})`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\n✓ Wrote ${out.length} questions to ${path.relative(process.cwd(), OUT_FILE)}`);
  console.log('  Review + hand-edit that file: prune weak ones, add your own.');
})();
