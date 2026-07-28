'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Category Clash — answer bucketing + validity checking.
//
// For each category we must answer two questions:
//   (a) which typed answers are THE SAME WORD (duplicates cancel each other)?
//   (b) which answers don't actually belong (wrong letter / wrong category)?
//
// Layered pipeline — each layer catches what the prior one can't:
//
//   0. Letter check  — must start with the round letter, optionally after a
//                      leading "a" / "an" / "the".                   (offline)
//   1. Normalize     — case, spaces, articles, punctuation/diacritics,
//                      plurals, light stemming, number-words.        (offline)
//   2. Exact bucket  — identical normalized keys merge.              (offline)
//   3. Fuzzy typo    — Levenshtein-close keys merge, conservatively. (offline)
//   4. AI pass       — Groq merges remaining MISSPELLINGS of the same word and
//                      flags answers that don't fit the category. (needs key)
//   5. Host review   — final authority, applied in game.js.          (manual)
//
// IMPORTANT: unlike Herd Mind, synonyms are NEVER merged here. "Sofa" and
// "Settee" are different words, so both players keep their point. Only the
// same word (spelling/plural/tense variants and typos) collapses.
// ─────────────────────────────────────────────────────────────────────────

const NUMBER_WORDS = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
  '10': 'ten', '11': 'eleven', '12': 'twelve',
};

/**
 * Does `raw` start with `letter`? A single leading article (a / an / the) is
 * the one allowed exception, per the rules of Scattergories.
 */
function letterStartOk(raw, letter) {
  const L = String(letter || '').trim().toLowerCase();
  if (!L) return true;
  let s = String(raw == null ? '' : raw).toLowerCase();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Drop anything that isn't a letter, number or space, then collapse spaces.
  s = s.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().replace(/\s+/g, ' ');
  if (!s) return false;
  s = s.replace(/^(a|an|the)\s+/, '');
  if (!s) return false;
  return s[0] === L[0];
}

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
  // gerund: running -> run (undo doubled consonant), baking -> bake loosely
  if (tok.length > 5 && /ing$/.test(tok)) {
    let base = tok.slice(0, -3);
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
      base = base.slice(0, -1);
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
// Only used when the AI layer is unavailable, so it is deliberately strict:
// >=4 chars, tight edit budget, never merges two keys that were EACH typed by
// multiple players (independent repetition ≠ typo), and on short keys it only
// accepts an added/dropped character.
function fuzzyShouldMerge(keyA, keyB, aMulti, bMulti) {
  if (keyA === keyB) return true;
  if (Math.min(keyA.length, keyB.length) < 4) return false;
  if (aMulti && bMulti) return false;
  const L = Math.max(keyA.length, keyB.length);
  const budget = L <= 6 ? 1 : 2;
  if (levenshtein(keyA, keyB) > budget) return false;
  // On a short key a single swapped letter is almost always a DIFFERENT word
  // ("bear"/"beer", "mango"/"mangy") rather than a typo. Real typos at that
  // length double or drop a character, which changes the length.
  if (L <= 6 && keyA.length === keyB.length) return false;
  return true;
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
  if (counts.size === 0) return '(blank)';
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

function fuzzyPass(groups) {
  const real = groups.slice();
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
  return real;
}

/**
 * One Groq call per category that does BOTH jobs at once:
 *   - clusters answers that are the SAME WORD (misspellings/variants only)
 *   - flags answers that don't belong to the category
 *
 * Returns { clusters, invalid } with indices into `labels`, or null on any
 * failure (bad key, timeout, non-JSON) so callers fall back to the offline
 * result. The host review screen is always the final authority.
 */
async function aiJudge(labels, category, letter, groqKey) {
  if (!groqKey || labels.length === 0) return null;
  const listed = labels.map((l, i) => `${i}: "${l}"`).join('\n');
  const prompt =
`You are judging answers in a game of Scattergories.

Category: "${category}"
Required starting letter: "${letter}"

Here are the distinct answers players typed:
${listed}

Do TWO things.

1) CLUSTER answers that are literally THE SAME WORD, written differently:
   - Misspellings and typos (e.g. "Elefant" / "Elephant", "Bannana" / "Banana")
   - Plural / tense / spacing / hyphenation variants (e.g. "Apple" / "Apples",
     "Ice cream" / "Ice-cream")
   - The same proper noun written differently (e.g. "Mcdonalds" / "McDonald's")
   NEVER cluster different words, even if they mean the same thing.
   Synonyms stay SEPARATE: "Sofa" and "Settee" are different answers.
   Related things stay SEPARATE: "Cat" and "Kitten", "Car" and "Truck".
   Words that merely LOOK or SOUND alike stay SEPARATE: "Bear" and "Beer",
   "Mango" and "Mangy", "Boston" and "Bolton".
   More specific vs. less specific stay SEPARATE: "New York" and
   "New York City", "Apple" and "Apple Pie".
   Cluster ONLY when both spellings are unmistakably attempts at the exact
   same word. If there is ANY doubt, leave them in separate clusters.

2) Mark as INVALID any answer that does NOT genuinely belong to the category
   "${category}". Be generous and accept any reasonable, real example — only
   flag answers that are clearly wrong, nonsense, gibberish, or off-topic.
   Do NOT mark an answer invalid merely for being unusual, obscure, or for its
   spelling. Ignore the starting letter; that is already checked elsewhere.

Respond ONLY with valid JSON, no markdown:
{"clusters": [[0,3],[1],[2,4]], "invalid": [2]}
Every index 0..${labels.length - 1} must appear exactly once in "clusters".
"invalid" lists indices that don't fit the category (use [] if all are fine).`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = ((data.choices && data.choices[0] && data.choices[0].message.content) || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      clusters: Array.isArray(parsed.clusters) ? parsed.clusters : null,
      invalid: Array.isArray(parsed.invalid) ? parsed.invalid : [],
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Apply the model's clusters to the offline groups (fail-safe: any index the
// model drops or repeats simply stays in its own group).
function applyClusters(groups, clusters) {
  const used = new Set();
  const out = [];
  for (const cluster of clusters) {
    if (!Array.isArray(cluster) || cluster.length === 0) continue;
    const idxs = cluster
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < groups.length && !used.has(n));
    if (idxs.length === 0) continue;
    const head = groups[idxs[0]];
    used.add(idxs[0]);
    for (let k = 1; k < idxs.length; k++) {
      absorb(head, groups[idxs[k]], 'ai');
      used.add(idxs[k]);
    }
    out.push(head);
  }
  for (let i = 0; i < groups.length; i++) if (!used.has(i)) out.push(groups[i]);
  return out;
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

/**
 * Build the host's review payload for a single category.
 *
 * @param {Object} args
 * @param {string} args.category   The category prompt (e.g. "Fruits").
 * @param {string} args.letter     The round's letter (e.g. "B").
 * @param {Array<{playerId:string,name:string,raw:string}>} args.submissions
 *        Non-blank answers only — one entry per player who wrote something.
 * @param {string|null} [args.groqKey]  Groq API key; enables the AI layer.
 * @returns {Promise<{buckets:Array, invalid:Array}>}
 *          buckets: [{ id, label, members, autoMerged, mergeSource }]
 *          invalid: [{ playerId, name, raw, reason: 'letter'|'category' }]
 */
async function buildCategoryReview({ category, letter, submissions, groqKey } = {}) {
  const list = Array.isArray(submissions) ? submissions : [];
  const invalid = [];
  const ok = [];

  // Layer 0: deterministic starting-letter check. Failures are auto-invalid
  // and never reach the AI (saves tokens and can't be argued with).
  for (const s of list) {
    const raw = s && s.raw != null ? String(s.raw).trim() : '';
    if (!raw) continue;
    const member = { playerId: s.playerId, name: s.name, raw };
    if (!letterStartOk(raw, letter)) invalid.push({ ...member, reason: 'letter' });
    else ok.push(member);
  }

  // Layers 1+2: normalize + exact bucket.
  const byKey = new Map();
  let groups = [];
  for (const member of ok) {
    const key = normalizeAnswer(member.raw);
    // A "key-less" answer (pure punctuation) can't be compared — keep it alone.
    if (!key) {
      const g = makeGroup(member.raw);
      g.keys.push('__uniq__' + member.playerId);
      g.members.push(member);
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

  // Layer 3: AI same-word clustering + category-fit check.
  let aiApplied = false;
  if (groqKey && groups.length > 0) {
    try {
      const verdict = await aiJudge(groups.map((g) => g.label), category, letter, groqKey);
      if (verdict) {
        // Flag before clustering so indices still line up with `groups`.
        const badIdx = new Set(
          verdict.invalid
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n >= 0 && n < groups.length)
        );
        const flagged = new Set();
        for (const i of badIdx) flagged.add(groups[i].id);

        if (verdict.clusters) groups = applyClusters(groups, verdict.clusters);

        const kept = [];
        for (const g of groups) {
          if (flagged.has(g.id)) {
            for (const m of g.members) invalid.push({ ...m, reason: 'category' });
          } else {
            kept.push(g);
          }
        }
        groups = kept;
        aiApplied = true;
      }
    } catch (_) { /* offline groups + host review remain */ }
  }

  // Layer 4 (fallback only): offline typo merge. Skipped whenever the AI ran,
  // so an approximate match can never be folded in behind the model's back —
  // the model decides what is the same word, and the host has the final say.
  if (!aiApplied) groups = fuzzyPass(groups);

  return { buckets: groups.map(publicGroup), invalid };
}

module.exports = {
  buildCategoryReview,
  letterStartOk,
  normalizeAnswer,
  levenshtein,
  // exported for unit tests
  _internal: { stemToken, fuzzyShouldMerge, pickLabel, applyClusters, makeGroup },
};
