'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Answer bucketing for Herd Mind.
//
// The whole game hinges on deciding which typed answers count as "the same".
// This runs as a layered pipeline (each layer catches what the prior can't):
//
//   1. Normalize    — case, spaces, articles, punctuation/diacritics,
//                     plurals, light stemming, number-words. (offline)
//   2. Exact bucket — identical normalized keys merge.                (offline)
//   3. Fuzzy typo   — Levenshtein-close keys merge, conservatively.   (offline)
//   4. AI cluster   — Groq groups synonyms/acronyms/aliases.  (needs GROQ key)
//   5. Host review  — final authority, applied in game.js.           (manual)
//
// buildGroups() runs layers 1–4 and returns provisional groups. The host can
// then merge/split/rename before scoring.
// ─────────────────────────────────────────────────────────────────────────

const { GROQ_MODEL, GROQ_CHAT_URL, logGroqFailure } = require('../groq');

const NUMBER_WORDS = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
  '10': 'ten', '11': 'eleven', '12': 'twelve',
};

/**
 * Reduce a raw answer to a canonical key used for exact-match bucketing.
 * Deterministic and offline. Returns '' for blank input.
 */
function normalizeAnswer(raw) {
  let s = String(raw == null ? '' : raw).toLowerCase();
  // Strip accents/diacritics: café -> cafe.
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Collapse whitespace.
  s = s.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  // Drop a single leading article.
  s = s.replace(/^(a|an|the)\s+/, '');
  // Keep only letters, numbers and spaces (drops punctuation/emoji).
  s = s.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  // Normalize each token: digit -> number word, then light singular/stem.
  const tokens = s.split(' ').map((tok) => {
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, tok)) return NUMBER_WORDS[tok];
    return stemToken(tok);
  });
  return tokens.join(' ');
}

// Very light, conservative stemmer: handles common plural / verb endings so
// dog/dogs, run/running, bake/baking collapse together. Intentionally simple —
// the AI + host review catch the rest, and over-stemming risks false merges.
function stemToken(tok) {
  if (tok.length <= 3) return tok;
  // plural: buses -> bus, boxes -> box (…es after s/x/z/ch/sh)
  if (/(?:s|x|z|ch|sh)es$/.test(tok)) return tok.slice(0, -2);
  // plural: babies -> baby
  if (/[^aeiou]ies$/.test(tok)) return tok.slice(0, -3) + 'y';
  // gerund: running -> run (undo doubled consonant), baking -> bake handled loosely
  if (tok.length > 5 && /ing$/.test(tok)) {
    let base = tok.slice(0, -3);
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
      base = base.slice(0, -1); // running -> run
    }
    return base;
  }
  // past tense: baked -> bake (loose)
  if (tok.length > 4 && /ed$/.test(tok)) {
    let base = tok.slice(0, -2);
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
      base = base.slice(0, -1);
    }
    return base;
  }
  // simple plural: cats -> cat (but not double-s like 'grass')
  if (/[^s]s$/.test(tok)) return tok.slice(0, -1);
  return tok;
}

// Classic iterative Levenshtein edit distance.
function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

// Should two distinct normalized keys be treated as a typo of each other?
// Conservative: >=4 chars, tight edit budget, and never merge two keys that
// were EACH typed by multiple players (independent repetition ≠ typo).
function fuzzyShouldMerge(keyA, keyB, aMulti, bMulti) {
  if (keyA === keyB) return true;
  if (Math.min(keyA.length, keyB.length) < 4) return false;
  if (aMulti && bMulti) return false;
  const L = Math.max(keyA.length, keyB.length);
  const budget = L <= 6 ? 1 : 2;
  return levenshtein(keyA, keyB) <= budget;
}

let _gidCounter = 0;
function makeGroup(label) {
  return {
    id: 'g' + (_gidCounter++) + '_' + Math.random().toString(36).slice(2, 6),
    label,
    members: [],          // [{ playerId, name, raw }]
    keys: [],             // normalized keys folded into this group
    autoMerged: false,    // true if layers 3/4 combined >1 distinct answer
    mergeSource: null,    // 'fuzzy' | 'ai' | null
  };
}

// Pick a human-friendly label for a group: the raw answer form that the most
// players typed (ties broken by shortest, then alphabetical).
function pickLabel(members) {
  if (!members.length) return '';
  const counts = new Map();
  for (const m of members) {
    const r = (m.raw || '').trim();
    if (!r) continue;
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  if (counts.size === 0) return '(no answer)';
  let best = null, bestCount = -1;
  for (const [raw, c] of counts) {
    if (c > bestCount ||
       (c === bestCount && (raw.length < best.length ||
       (raw.length === best.length && raw.localeCompare(best) < 0)))) {
      best = raw; bestCount = c;
    }
  }
  return best;
}

// Fold group `src` into `dst` (dst keeps its id). Marks the merge source.
function absorb(dst, src, source) {
  for (const m of src.members) dst.members.push(m);
  for (const k of src.keys) dst.keys.push(k);
  dst.autoMerged = true;
  // Keep the strongest signal for the badge; 'ai' wins over 'fuzzy'.
  if (source === 'ai' || !dst.mergeSource) dst.mergeSource = source;
  dst.label = pickLabel(dst.members);
}

/**
 * Build provisional answer groups from a round's submissions.
 *
 * @param {Array<{playerId:string, name:string, raw:string}>} submissions
 *        One entry per player. A blank/whitespace `raw` becomes its own unique
 *        "(no answer)" group (eligible for the Pink Cow), never grouped with
 *        other blanks.
 * @param {Object} [opts]
 * @param {string|null} [opts.groqKey]  Groq API key; enables the AI layer.
 * @returns {Promise<Array>} groups: [{ id, label, members, autoMerged, mergeSource }]
 */
async function buildGroups(submissions, opts = {}) {
  const groqKey = opts.groqKey || null;
  const list = Array.isArray(submissions) ? submissions : [];

  // Layer 1+2: normalize + exact bucket. Blanks each get their own group.
  const byKey = new Map();
  let groups = [];
  for (const s of list) {
    const raw = s && s.raw != null ? String(s.raw) : '';
    const key = normalizeAnswer(raw);
    const member = { playerId: s.playerId, name: s.name, raw: raw.trim() };
    if (!key) {
      const g = makeGroup('(no answer)');
      g.members.push(member);
      g.keys.push('__blank__' + s.playerId);
      groups.push(g);
      continue;
    }
    let g = byKey.get(key);
    if (!g) {
      g = makeGroup('');
      g.keys.push(key);
      byKey.set(key, g);
      groups.push(g);
    }
    g.members.push(member);
  }
  for (const g of groups) if (!g.label) g.label = pickLabel(g.members);

  // Layer 3: fuzzy typo merge (skip blanks — their keys are unique sentinels).
  groups = fuzzyPass(groups);

  // Layer 4: AI semantic clustering (synonyms / acronyms / aliases).
  if (groqKey) {
    try {
      groups = await aiPass(groups, groqKey);
    } catch (_) { /* deterministic groups + host review remain */ }
  }

  return groups.map(publicGroup);
}

function isBlankGroup(g) {
  return g.keys.length === 1 && g.keys[0].startsWith('__blank__');
}

function fuzzyPass(groups) {
  const real = groups.filter((g) => !isBlankGroup(g));
  const blanks = groups.filter(isBlankGroup);
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < real.length; i++) {
      for (let j = i + 1; j < real.length; j++) {
        const A = real[i], B = real[j];
        const aMulti = A.members.length >= 2;
        const bMulti = B.members.length >= 2;
        let hit = false;
        for (const ka of A.keys) {
          for (const kb of B.keys) {
            if (fuzzyShouldMerge(ka, kb, aMulti, bMulti)) { hit = true; break; }
          }
          if (hit) break;
        }
        if (hit) {
          absorb(A, B, 'fuzzy');
          real.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return real.concat(blanks);
}

async function aiPass(groups, groqKey) {
  const real = groups.filter((g) => !isBlankGroup(g));
  const blanks = groups.filter(isBlankGroup);
  if (real.length < 2) return groups;

  const labels = real.map((g, i) => `${i}: "${g.label}"`).join('\n');
  const prompt =
`You are grouping short party-game answers that MEAN THE SAME THING.
Below is a numbered list of distinct answers players typed for one question.
Cluster together the indices whose answers refer to the SAME concept/thing.

Merge indices when they are:
- Synonyms (e.g. "couch" / "sofa")
- Acronyms or abbreviations of each other (e.g. "NBA" / "National Basketball Association", "NYC" / "New York City")
- Nicknames/aliases for the same entity (e.g. "The Rock" / "Dwayne Johnson")
- Obvious typos or spelling variants (e.g. "Chirs" / "Chris")
- Different tense/plural/spelling of the same word

Do NOT merge:
- Different things that merely share a word (e.g. "hot dog" / "hot tub")
- Distinct but related things (e.g. "cat" / "dog")

Answers:
${labels}

Respond ONLY with valid JSON, no markdown:
{"clusters": [[0,3],[1],[2,4]]}
Every index 0..${real.length - 1} must appear exactly once.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let clusters;
  try {
    const resp = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 2048,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      await logGroqFailure('Herd Mind AI grouping', resp);
      return groups;
    }
    const data = await resp.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return groups;
    clusters = JSON.parse(m[0]).clusters;
  } catch (e) {
    console.error('Herd Mind AI grouping error:', e.message);
    return groups;
  } finally {
    clearTimeout(timeout);
  }

  if (!Array.isArray(clusters)) return groups;
  // Apply clusters: fold every extra index in a cluster into the first one.
  const used = new Set();
  const out = [];
  for (const cluster of clusters) {
    if (!Array.isArray(cluster) || cluster.length === 0) continue;
    const idxs = cluster
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < real.length && !used.has(n));
    if (idxs.length === 0) continue;
    const head = real[idxs[0]];
    used.add(idxs[0]);
    for (let k = 1; k < idxs.length; k++) {
      absorb(head, real[idxs[k]], 'ai');
      used.add(idxs[k]);
    }
    out.push(head);
  }
  // Any indices the model dropped stay as their own groups (fail safe).
  for (let i = 0; i < real.length; i++) {
    if (!used.has(i)) out.push(real[i]);
  }
  return out.concat(blanks);
}

function publicGroup(g) {
  return {
    id: g.id,
    label: g.label,
    members: g.members.map((m) => ({ playerId: m.playerId, name: m.name, raw: m.raw })),
    autoMerged: !!g.autoMerged,
    mergeSource: g.mergeSource || null,
  };
}

module.exports = {
  buildGroups,
  normalizeAnswer,
  levenshtein,
  // exported for unit tests
  _internal: { stemToken, fuzzyShouldMerge, pickLabel },
};
