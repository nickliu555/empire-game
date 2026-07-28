require('dotenv').config();
const express = require('express');
const path = require('path');
const os = require('os');
const http = require('http');
const rateLimit = require('express-rate-limit');
const games = require('./games');
const mountTrivia = require('./server/trivia');
const mountTwentyFour = require('./server/twentyfour');
const mountHerdMind = require('./server/herdmind');
const mountCatClash = require('./server/catclash');
const mountBoggle = require('./server/noggle');
const mountSoccerHead = require('./server/soccerhead');
const mountSlingSoccer = require('./server/slingsoccer');
const mountRanking = require('./server/ranking');
const mountPacman = require('./server/pacman');
const app = express();

app.set('trust proxy', 1);

// Rate limit for submission endpoint (max 10 requests per minute per IP)
const submitLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a moment and try again.' },
});

// Rate limit for reactions (max 30 per minute per IP)
const reactLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many reactions.' },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Hub & Games API ────────────────────────────────────────

// Serve the hub page at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'hub.html'));
});

// Games registry API
app.get('/api/games', (req, res) => {
    res.json(games);
});

app.get('/api/games/:id', (req, res) => {
    const game = games.find(g => g.id === req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    res.json(game);
});

// ─── Empire Game Routes ─────────────────────────────────────

// Serve the empire host page
app.get('/empire/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'empire', 'host.html'));
});

// Serve the empire join page (entry point for players — submit form,
// "waiting for host", "game in progress" lock screen, kicked view).
app.get('/empire/join', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'empire', 'join.html'));
});

// Serve the empire play page (post-join — done/playing views, reactions,
// secret card, reset/new-round notifications, kicked view). Players land
// here automatically after a successful submission.
app.get('/empire/play', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'empire', 'player.html'));
});

// ─── Trivia Game Routes ─────────────────────────────────────
app.get('/trivia/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'trivia', 'host.html'));
});
app.get('/trivia/play', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'trivia', 'player.html'));
});
app.get('/trivia/join', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'trivia', 'join.html'));
});

// ─── Game State ─────────────────────────────────────────────
const SERVER_GAME_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
let gameState = createFreshState();

function createFreshState() {
    // If GROQ_API_KEY env var is set, skip the setup phase
    const envKey = process.env.GROQ_API_KEY || null;
    return {
        phase: envKey ? 'submission' : 'setup',
        groqApiKey: envKey,
        submissions: [],       // [{player, word}]
        shuffledWords: [],     // randomized once on game start
        round: 1,              // increments on each reset so clients detect it
        category: '',          // optional category set by host
        botCount: 0,           // number of AI decoy words (0–10)
        reactionsMuted: false, // host can mute all player reactions
        gameId: SERVER_GAME_ID, // stable for entire server lifetime
    };
}

// ─── Inactivity auto-reset (60 min) ─────────────────────────
let lastActivity = Date.now();

function touchActivity() {
    lastActivity = Date.now();
}

setInterval(() => {
    if (Date.now() - lastActivity >= 60 * 60 * 1000) {
        const nextRound = gameState.round + 1;
        gameState = createFreshState();
        gameState.round = nextRound;
        broadcast();
        console.log('Game auto-reset after 60 minutes of inactivity.');
    }
}, 60 * 1000);

// ─── Compute LAN IP once at startup ─────────────────────────
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}
const LOCAL_IP = getLocalIP();

// ─── SSE (Server-Sent Events) ───────────────────────────────
const sseClients = new Set();
const hostClients = new Set();
const HOST_GRACE_MS = 5000;
let hostGraceTimer = null;
let lastHostSeenAt = 0;
// Set true when the host explicitly clicks Hub. Forces isHostPresent() to
// return false even if the host's SSE briefly remains in `hostClients`
// (the SSE closes naturally on navigation a moment later). Cleared the next
// time a host actually opens the host page.
let hostLeftIntentionally = false;
// Host is "present" if any host SSE is connected, OR a host disconnected
// within the grace window (covers refresh races and brief blips).
function isHostPresent() {
    if (hostLeftIntentionally) return false;
    if (hostClients.size > 0) return true;
    return lastHostSeenAt > 0 && (Date.now() - lastHostSeenAt) < HOST_GRACE_MS;
}

function getPublicState() {
    const baseUrl = process.env.RENDER_EXTERNAL_URL
        || process.env.PUBLIC_URL
        || `http://${LOCAL_IP}:${PORT}`;
    const playerUrl = `${baseUrl}/empire/join`;
    return {
        phase: gameState.phase,
        playerCount: gameState.submissions.filter(s => !s.isBot).length,
        playerNames: gameState.submissions.filter(s => !s.isBot).map(s => s.player),
        hasApiKey: !!gameState.groqApiKey,
        playerUrl,
        round: gameState.round,
        category: gameState.category,
        botCount: gameState.botCount,
        reactionsMuted: gameState.reactionsMuted,
        gameId: gameState.gameId,
        hostPresent: isHostPresent(),
    };
}

function broadcast() {
    const data = JSON.stringify(getPublicState());
    for (const client of sseClients) {
        client.write(`data: ${data}\n\n`);
    }
}

function broadcastReaction(emoji) {
    for (const client of sseClients) {
        client.write(`event: reaction\ndata: ${JSON.stringify({ emoji })}\n\n`);
    }
}

function broadcastKicked(player) {
    const data = JSON.stringify({ player });
    for (const client of sseClients) {
        client.write(`event: kicked\ndata: ${data}\n\n`);
    }
}

app.get('/api/empire/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    const isHost = req.query.role === 'host';
    if (isHost) {
        // Cancel any pending "host left" broadcast — host is back.
        if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
        const wasAbsent = !isHostPresent();
        hostLeftIntentionally = false; // host is here now
        hostClients.add(res);
        lastHostSeenAt = Date.now();
        if (wasAbsent) broadcast(); // tell players the host arrived
    }
    // Send current state AFTER host registration so the host sees themselves.
    res.write(`data: ${JSON.stringify(getPublicState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
        sseClients.delete(res);
        if (isHost) {
            hostClients.delete(res);
            lastHostSeenAt = Date.now();
            if (hostClients.size === 0) {
                if (hostGraceTimer) clearTimeout(hostGraceTimer);
                hostGraceTimer = setTimeout(() => {
                    hostGraceTimer = null;
                    broadcast();
                }, HOST_GRACE_MS);
            }
        }
    });
});

// ─── API Routes ─────────────────────────────────────────────

// Get current game state (public - no secrets)
app.get('/api/empire/state', (req, res) => {
    res.json(getPublicState());
});

// Save API key (host only)
app.post('/api/empire/set-key', async (req, res) => {
    touchActivity();
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required' });

    const valid = await validateApiKey(key);
    if (!valid) return res.status(401).json({ error: 'Invalid API key' });

    gameState.groqApiKey = key;
    gameState.phase = 'submission';
    broadcast();
    res.json({ ok: true });
});

// Submit a word (players)
app.post('/api/empire/submit', submitLimiter, async (req, res) => {
    touchActivity();
    if (!isHostPresent()) {
        return res.status(503).json({ error: 'Host has left the game.' });
    }
    if (gameState.phase !== 'submission') {
        return res.status(400).json({ error: 'Not accepting submissions right now.' });
    }

    const { player, word, skipCategoryCheck } = req.body;
    const cleanWord = (word || '').trim().toLowerCase();
    const cleanName = (player || '').trim();

    if (!cleanName || !cleanWord) {
        return res.status(400).json({ error: 'Name and word are required.' });
    }

    // Block reserved bot name
    if (cleanName.toLowerCase().replace(/\s+/g, ' ') === 'ai bot 🤖' || cleanName.toLowerCase().replace(/\s+/g, ' ') === 'ai bot') {
        return res.status(400).json({ error: 'That name is reserved. Please choose another.' });
    }

    // Check if this player already submitted
    if (gameState.submissions.some(s => s.player.toLowerCase() === cleanName.toLowerCase())) {
        const displayName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1).toLowerCase();
        return res.status(400).json({ error: `${displayName} is already another player's name.` });
    }

    // Exact duplicate check
    if (gameState.submissions.some(s => s.word === cleanWord)) {
        return res.status(400).json({ error: `That word is not available. Try another!` });
    }

    // LLM similarity check
    const existingWords = gameState.submissions.map(s => s.word);
    const sim = await checkSimilarity(cleanWord, existingWords, gameState.groqApiKey);
    if (sim && sim.is_similar) {
        console.log(`Similarity rejection: "${cleanWord}" too similar to "${sim.similar_to}" (reason: ${sim.reason || 'n/a'})`);
        return res.status(400).json({ error: `That word is not available. Try another!` });
    }

    // LLM category fit check (soft warning, not a hard reject)
    if (gameState.category && !skipCategoryCheck) {
        console.log(`Category check: word="${cleanWord}", category="${gameState.category}"`);
        const fit = await checkCategoryFit(cleanWord, gameState.category, gameState.groqApiKey);
        console.log('Category check result:', fit);
        if (fit && !fit.fits_category) {
            return res.status(200).json({ categoryWarning: true, reason: `"${cleanWord}" doesn't typically fall under "${gameState.category}".` });
        }
    }

    gameState.submissions.push({ player: cleanName, word: cleanWord });
    broadcast();
    res.json({ ok: true, playerCount: gameState.submissions.length });
});

// Withdraw a submission (player changes their mind before game starts)
app.post('/api/empire/withdraw', (req, res) => {
    touchActivity();
    if (gameState.phase !== 'submission') {
        return res.status(400).json({ error: 'Cannot withdraw right now.' });
    }
    const { player } = req.body;
    const cleanName = (player || '').trim();
    if (!cleanName) {
        return res.status(400).json({ error: 'Player name is required.' });
    }
    const idx = gameState.submissions.findIndex(s => s.player.toLowerCase() === cleanName.toLowerCase());
    if (idx === -1) {
        return res.status(404).json({ error: 'Submission not found.' });
    }
    gameState.submissions.splice(idx, 1);
    broadcast();
    res.json({ ok: true });
});

// Kick a player (host only — removes their submission. They can rejoin
// with the same name from their phone, matching Trivia's UX.)
app.post('/api/empire/kick', (req, res) => {
    touchActivity();
    if (gameState.phase !== 'submission') {
        return res.status(400).json({ error: 'Can only kick during submission phase.' });
    }
    const { player } = req.body || {};
    const cleanName = (player || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Player name is required.' });
    const lower = cleanName.toLowerCase();
    const idx = gameState.submissions.findIndex(s => s.player.toLowerCase() === lower);
    if (idx === -1) return res.status(404).json({ error: 'Player not found.' });
    const removed = gameState.submissions.splice(idx, 1)[0];
    broadcastKicked(removed.player);
    broadcast();
    res.json({ ok: true });
});

// Set category (host only)
app.post('/api/empire/category', (req, res) => {
    touchActivity();
    const { category } = req.body;
    gameState.category = (category || '').trim().substring(0, 100);
    broadcast();
    res.json({ ok: true });
});

// Set AI Bot count (host only)
const MAX_BOTS = 10;
app.post('/api/empire/ai-bot', (req, res) => {
    touchActivity();
    if (gameState.phase !== 'submission') {
        return res.status(400).json({ error: 'Can only change AI Bots during submission phase.' });
    }
    let count = parseInt(req.body && req.body.count, 10);
    if (!Number.isFinite(count)) count = 0;
    gameState.botCount = Math.max(0, Math.min(MAX_BOTS, count));
    broadcast();
    res.json({ ok: true, botCount: gameState.botCount });
});

// Send a reaction (players)
const ALLOWED_REACTIONS = ['😂', '🔥', '👀', '👑', '💀', '🎉', '😱', '😡'];
app.post('/api/empire/react', reactLimiter, (req, res) => {
    if (!isHostPresent()) {
        return res.status(503).json({ error: 'Host has left the game.' });
    }
    if (gameState.reactionsMuted) {
        return res.status(403).json({ error: 'Reactions are muted by the host.' });
    }
    if (gameState.phase !== 'playing' && gameState.phase !== 'submission') {
        return res.status(400).json({ error: 'Reactions not available right now.' });
    }
    const { emoji } = req.body;
    if (!emoji || !ALLOWED_REACTIONS.includes(emoji)) {
        return res.status(400).json({ error: 'Invalid reaction.' });
    }
    broadcastReaction(emoji);
    res.json({ ok: true });
});

// Toggle reactions muted (host only)
app.post('/api/empire/reactions-muted', (req, res) => {
    touchActivity();
    const next = !!(req.body && req.body.muted);
    gameState.reactionsMuted = next;
    broadcast();
    res.json({ ok: true, reactionsMuted: gameState.reactionsMuted });
});

// Start game (host only)
app.post('/api/empire/start', async (req, res) => {
    touchActivity();
    if (gameState.submissions.length < 2) {
        return res.status(400).json({ error: 'Need at least 2 players.' });
    }

    // Generate AI Bot decoy words if requested (before shuffling)
    if (gameState.botCount > 0) {
        try {
            const aiWords = await generateAiBotWords(
                gameState.submissions.map(s => s.word),
                gameState.category,
                gameState.groqApiKey,
                gameState.botCount
            );
            for (const aiWord of aiWords) {
                gameState.submissions.push({ player: 'AI Bot 🤖', word: aiWord, isBot: true });
            }
            if (aiWords.length) {
                console.log(`AI Bot words generated (${aiWords.length}/${gameState.botCount}): ${aiWords.map(w => `"${w}"`).join(', ')}`);
            } else {
                console.warn('AI Bot word generation returned none, proceeding without bots.');
            }
        } catch (e) {
            console.error('AI Bot word generation failed, proceeding without bots:', e.message);
        }
    }

    gameState.phase = 'playing';
    // Fisher-Yates shuffle for uniform randomness
    const arr = gameState.submissions.map(s => s.word);
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    gameState.shuffledWords = arr;
    broadcast();
    res.json({ ok: true });
});

// Get shuffled words (no names)
app.get('/api/empire/words', (req, res) => {
    if (gameState.phase !== 'playing') {
        return res.status(400).json({ error: 'Game not started yet.' });
    }
    res.json({ words: gameState.shuffledWords });
});

// Get words with names (host only reveal)
app.get('/api/empire/attribution', (req, res) => {
    if (gameState.phase !== 'playing') {
        return res.status(400).json({ error: 'Game not started yet.' });
    }
    res.json({ attribution: gameState.submissions });
});

// Host explicitly leaving via the Hub button. Resets the game AND immediately
// flips host-presence to false (skipping the grace window) so every player
// page shows the "no host" overlay before the host's tab even navigates.
app.post('/api/empire/host-leave', (req, res) => {
    touchActivity();
    const key = gameState.groqApiKey;
    const nextRound = gameState.round + 1;
    gameState = createFreshState();
    gameState.groqApiKey = key;
    gameState.phase = 'submission';
    gameState.round = nextRound;
    hostLeftIntentionally = true;
    if (hostGraceTimer) { clearTimeout(hostGraceTimer); hostGraceTimer = null; }
    broadcast(); // players now see hostPresent=false → overlay
    res.json({ ok: true });
});

// Reset game (new round)
app.post('/api/empire/reset', (req, res) => {
    touchActivity();
    const key = gameState.groqApiKey;
    const nextRound = gameState.round + 1;
    gameState = createFreshState();
    gameState.groqApiKey = key;
    gameState.phase = 'submission';
    gameState.round = nextRound;
    broadcast();
    res.json({ ok: true });
});

// Full reset (back to API key setup, unless env var is set)
app.post('/api/empire/full-reset', (req, res) => {
    touchActivity();
    const nextRound = gameState.round + 1;
    gameState = createFreshState();
    gameState.round = nextRound;
    broadcast();
    res.json({ ok: true });
});

// ─── Groq API helpers ───────────────────────────────────────

async function generateAiBotWords(existingWords, category, apiKey, count) {
    if (!apiKey || count <= 0) return [];

    const existingList = existingWords.map(w => `"${w}"`).join(', ');
    // Ask for enough candidates to comfortably fill `count` distinct decoys.
    const numCandidates = Math.max(10, count * 2);
    let categoryInstruction;
    if (category) {
        categoryInstruction = `The category for this round is: "${category}". Generate ${numCandidates} words or short phrases that fit this category.`;
    } else {
        categoryInstruction = `There is no category set. Generate ${numCandidates} random interesting words or short phrases that would be fun for a party game.`;
    }

    const prompt = `You are generating decoy word candidates for a party game called "Empire".
Players have each submitted a secret word. You need to generate a list of ${numCandidates} candidate words — ${count} will be randomly selected and mixed in to throw off the other players. The decoys must BLEND IN with the real player words so nobody can tell which ones are fake.

${categoryInstruction}

Real player words already submitted: ${existingList}

STEP 1 — IDENTIFY THE SPECIFIC SUB-GENRE (MOST IMPORTANT STEP):
Ignore the broad category. Instead, look ONLY at the actual player words and identify the NARROW sub-genre, style, era, or theme they share.
For example: if the category is "Albums" but most players picked a hip-hop album → the sub-genre is "hip-hop albums". If the category is "Movies" but most players picked a horror film → the sub-genre is "horror movies". If the category is "Athletes" but most players picked NBA players → the sub-genre is "NBA players".
ALL 10 of your candidates MUST belong to that same narrow sub-genre. Do NOT pick from the broader category — ONLY from the specific cluster the players defined.
If players are picking mainstream → pick mainstream. If players are picking underground/niche → pick underground/niche. Match the popularity level too.

STEP 2 — MAKE SURE EACH CANDIDATE IS TRULY UNIQUE:
This is CRITICAL. Every candidate you generate must be a COMPLETELY DIFFERENT entity from every player word. This means:
- NOT the same person by a different name (e.g., if "Drake" exists, do NOT pick "Drizzy", "Aubrey Graham", or "Champagne Papi")
- NOT a spelling variation (e.g., if "Kanye" exists, do NOT pick "Ye" or "Kanye West")
- NOT the same thing rephrased (e.g., if "golden retriever" exists, do NOT pick "goldie" or "retriever")
- NOT an abbreviation or acronym of an existing word
- NOT a nickname, alias, or stage name that refers to the same entity as any player word
Each candidate must refer to a GENUINELY DIFFERENT entity/concept that happens to fit the same vibe.

STEP 3 — TYPE IT LIKE A HUMAN WOULD:
Use the most common, casual way real people refer to things — the way you'd type it in a group chat, not a Wikipedia article.
- "Chris Hemsworth" NOT "Christopher Hemsworth"
- "Scarlett Johansson" NOT "Scarlett Ingrid Johansson"
- "LeBron" or "LeBron James" NOT "LeBron Raymone James"
- "The Godfather" NOT "The Godfather (1972 film)"
- "golden retriever" NOT "Golden Retriever dog breed"
Match how the PLAYERS are typing — look at their words for cues on formality level. If they wrote "Bron" you can be casual. If they wrote "LeBron James" match that level.

Rules:
- Each candidate must pass ALL THREE tests: blends in with the vibe, is a completely different entity from every player word, and is typed the way a human would
- Keep each to 1-4 words maximum
- Include variety — different picks within the same energy

Respond ONLY with valid JSON (no markdown, no extra text):
{"detected_subgenre": "the specific narrow sub-genre/style/era you identified from the player words", "words": ["word1", "word2", "...up to ${numCandidates} candidates"]}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.9,
                max_tokens: 600,
                seed: Math.floor(Math.random() * 2147483647)
            }),
            signal: controller.signal,
        });

        if (!resp.ok) return [];

        const data = await resp.json();
        const text = data.choices[0].message.content.trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return [];
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.detected_subgenre) console.log(`AI Bot detected vibe: "${parsed.detected_subgenre}"`);
        const candidates = (parsed.words || [])
            .map(w => (w || '').trim().toLowerCase())
            .filter(w => w && !existingWords.some(e => e.toLowerCase() === w));
        if (!candidates.length) return [];
        // Shuffle candidates and pick up to `count` distinct decoys (no dupes).
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        const picks = [];
        for (const c of candidates) {
            if (picks.length >= count) break;
            if (!picks.includes(c)) picks.push(c);
        }
        return picks;
    } catch (e) {
        console.error('AI Bot word generation error:', e);
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

async function validateApiKey(key) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const resp = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { 'Authorization': `Bearer ${key}` },
            signal: controller.signal,
        });
        return resp.ok;
    } catch (e) {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

async function checkSimilarity(newWord, existingWords, apiKey) {
    if (!existingWords.length || !apiKey) return null;

    const existingList = existingWords.map(w => `"${w}"`).join(', ');
    const prompt = `You are a word similarity checker for a party game called "Empire". 
Your job is to reject words that are TOO SIMILAR - only reject if they refer to the SAME concept or entity.

New word submitted: "${newWord}"
Existing words: ${existingList}

Check if the new word is similar to ANY of the existing words. ONLY REJECT if:
- Exact match or spelling variation (e.g., "color" vs "colour") → REJECT
- Same root word in a different form - plurals, verb tenses, gerunds, etc. (e.g., "bike" vs "biking", "run" vs "running", "cat" vs "cats", "swim" vs "swimmer", "drive" vs "driving") → REJECT
- Same person/entity with minor variations (e.g., "Kanye" vs "Kanye West", "Taylor" vs "Taylor Swift") → REJECT
- Nicknames, aliases, or stage names referring to the same person/thing (e.g., "Drake" vs "Drizzy", "The Rock" vs "Dwayne Johnson", "MJ" vs "Michael Jordan", "Bey" vs "Beyoncé") → REJECT
- Same concept phrased differently (e.g., "egg roll" and "spring roll" are both types of rolls) → REJECT
- Obvious typos (e.g., "Chirs" vs "Chris") → REJECT
- Abbreviations or acronyms for the same thing (e.g., "NBA" vs "National Basketball Association", "NYC" vs "New York City") → REJECT

DO NOT REJECT if:
- Different people who share a first name (e.g., "Chris Pratt" vs "Chris Hemsworth") → ACCEPT
- Different concepts that happen to share a word (e.g., "hot dog" vs "hot tub") → ACCEPT
- Synonyms that are distinct enough (e.g., "happy" vs "joyful") → ACCEPT

Respond ONLY with valid JSON (no markdown, no extra text):
{"is_similar": true/false, "similar_to": "word or null", "reason": "brief explanation"}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 200
            }),
            signal: controller.signal,
        });

        if (!resp.ok) return null;

        const data = await resp.json();
        const text = data.choices[0].message.content.trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error('Similarity check error:', e);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function checkCategoryFit(word, category, apiKey) {
    if (!category || !apiKey) return null;

    const prompt = `You are a category checker for a party game called "Empire".
Players submit a word that should fit a given category.

Category: "${category}"
Word submitted: "${word}"

Be lenient for borderline cases — this is a casual party game, not a strict quiz.
But the word should reasonably belong in the category based on what it is PRIMARILY KNOWN FOR.
Do not stretch to find tenuous connections.

For example:
- "swimmer" for "Occupations" → ACCEPT (professional swimmers exist)
- "runner" for "Occupations" → ACCEPT (people run professionally)
- "pizza" for "Occupations" → REJECT (pizza is a food, not an occupation)
- "cake" for "Movies" → REJECT (not a well-known movie)
- "kanye" for "Athletes" → REJECT (he is primarily a musician, not an athlete)
- "lebron" for "Athletes" → ACCEPT (he is primarily known as an athlete)
- "shaq" for "Actors" → REJECT (he is primarily known as a basketball player)

Respond ONLY with valid JSON (no markdown, no extra text):
{"fits_category": true/false}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 200
            }),
            signal: controller.signal,
        });

        if (!resp.ok) return null;

        const data = await resp.json();
        const text = data.choices[0].message.content.trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error('Category check error:', e);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

// ─── Start server ───────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);

// Build the public base URL once — both games need it for QR generation.
const getPublicBaseUrl = () => {
    if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    return `http://${LOCAL_IP}:${PORT}`;
};

// Mount the Trivia game (Socket.IO namespace + REST endpoints).
mountTrivia(app, httpServer, { getPublicBaseUrl });

// Mount the "24" math game (Socket.IO namespace + REST endpoints + page routes).
mountTwentyFour(app, httpServer, { getPublicBaseUrl });

// Mount the "Herd Mind" game (Socket.IO namespace + REST endpoints + page routes).
mountHerdMind(app, httpServer, { getPublicBaseUrl });

// Mount the "Category Clash" Scattergories-style game (Socket.IO namespace + REST + page routes).
mountCatClash(app, httpServer, { getPublicBaseUrl });

// Mount the Boggle word game (Socket.IO namespace + REST endpoints + page routes).
mountBoggle(app, httpServer, { getPublicBaseUrl });

// Mount the Soccer Head arcade-soccer game (Socket.IO namespace + REST + page routes).
mountSoccerHead(app, httpServer, { getPublicBaseUrl });

// Mount the Sling Soccer turn-based flick-soccer game (Socket.IO namespace + REST + page routes).
mountSlingSoccer(app, httpServer, { getPublicBaseUrl });

// Mount the Ranking co-op guessing game (Socket.IO namespace + REST + page routes).
mountRanking(app, httpServer, { getPublicBaseUrl });

// Mount the Pac-Man Royale arcade game (Socket.IO namespace + REST + page routes).
mountPacman(app, httpServer, { getPublicBaseUrl });

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  🎮 Game Hub');
    console.log('═══════════════════════════════════════════');
    if (process.env.RENDER_EXTERNAL_URL) {
        console.log(`  Live at: ${process.env.RENDER_EXTERNAL_URL}`);
    } else {
        console.log(`  Hub:            http://localhost:${PORT}`);
    }
    console.log('═══════════════════════════════════════════');
    console.log('');
});
