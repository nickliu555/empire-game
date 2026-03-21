require('dotenv').config();
const express = require('express');
const path = require('path');
const os = require('os');
const rateLimit = require('express-rate-limit');
const app = express();

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

// Serve the player page at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// Serve the host page at /host
app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
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
        aiBotEnabled: false,   // toggle for AI decoy word
        gameId: SERVER_GAME_ID, // stable for entire server lifetime
    };
}

// ─── Inactivity auto-reset (45 min) ─────────────────────────
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

function getPublicState() {
    const playerUrl = process.env.RENDER_EXTERNAL_URL
        || process.env.PUBLIC_URL
        || `http://${LOCAL_IP}:${PORT}`;
    return {
        phase: gameState.phase,
        playerCount: gameState.submissions.length,
        playerNames: gameState.submissions.map(s => s.player),
        hasApiKey: !!gameState.groqApiKey,
        playerUrl,
        round: gameState.round,
        category: gameState.category,
        aiBotEnabled: gameState.aiBotEnabled,
        gameId: gameState.gameId,
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

app.get('/api/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    // Send current state immediately on connect
    res.write(`data: ${JSON.stringify(getPublicState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

// ─── API Routes ─────────────────────────────────────────────

// Get current game state (public - no secrets)
app.get('/api/state', (req, res) => {
    res.json(getPublicState());
});

// Save API key (host only)
app.post('/api/set-key', async (req, res) => {
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
app.post('/api/submit', submitLimiter, async (req, res) => {
    touchActivity();
    if (gameState.phase !== 'submission') {
        return res.status(400).json({ error: 'Not accepting submissions right now.' });
    }

    const { player, word, skipCategoryCheck } = req.body;
    const cleanWord = (word || '').trim().toLowerCase();
    const cleanName = (player || '').trim();

    if (!cleanName || !cleanWord) {
        return res.status(400).json({ error: 'Name and word are required.' });
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
app.post('/api/withdraw', (req, res) => {
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

// Set category (host only)
app.post('/api/category', (req, res) => {
    touchActivity();
    const { category } = req.body;
    gameState.category = (category || '').trim().substring(0, 100);
    broadcast();
    res.json({ ok: true });
});

// Toggle AI Bot (host only)
app.post('/api/ai-bot', (req, res) => {
    touchActivity();
    if (gameState.phase !== 'submission') {
        return res.status(400).json({ error: 'Can only toggle AI Bot during submission phase.' });
    }
    const { enabled } = req.body;
    gameState.aiBotEnabled = !!enabled;
    broadcast();
    res.json({ ok: true });
});

// Send a reaction (players)
const ALLOWED_REACTIONS = ['😂', '🔥', '👀', '👑', '💀', '🎉', '😱', '🤬'];
app.post('/api/react', reactLimiter, (req, res) => {
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

// Start game (host only)
app.post('/api/start', async (req, res) => {
    touchActivity();
    if (gameState.submissions.length < 2) {
        return res.status(400).json({ error: 'Need at least 2 players.' });
    }

    // Generate AI Bot word if enabled (before shuffling)
    if (gameState.aiBotEnabled) {
        try {
            const aiWord = await generateAiBotWord(
                gameState.submissions.map(s => s.word),
                gameState.category,
                gameState.groqApiKey
            );
            if (aiWord) {
                gameState.submissions.push({ player: 'AI Bot 🤖', word: aiWord });
                console.log(`AI Bot word generated: "${aiWord}"`);
            } else {
                console.warn('AI Bot word generation returned null, proceeding without it.');
            }
        } catch (e) {
            console.error('AI Bot word generation failed, proceeding without it:', e.message);
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
app.get('/api/words', (req, res) => {
    if (gameState.phase !== 'playing') {
        return res.status(400).json({ error: 'Game not started yet.' });
    }
    res.json({ words: gameState.shuffledWords });
});

// Get words with names (host only reveal)
app.get('/api/attribution', (req, res) => {
    if (gameState.phase !== 'playing') {
        return res.status(400).json({ error: 'Game not started yet.' });
    }
    res.json({ attribution: gameState.submissions });
});

// Reset game (new round)
app.post('/api/reset', (req, res) => {
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
app.post('/api/full-reset', (req, res) => {
    touchActivity();
    const nextRound = gameState.round + 1;
    gameState = createFreshState();
    gameState.round = nextRound;
    broadcast();
    res.json({ ok: true });
});

// ─── Groq API helpers ───────────────────────────────────────

async function generateAiBotWord(existingWords, category, apiKey) {
    if (!apiKey) return null;

    const existingList = existingWords.map(w => `"${w}"`).join(', ');
    let categoryInstruction;
    if (category) {
        categoryInstruction = `The category for this round is: "${category}". Generate 10 words or short phrases that fit this category.`;
    } else {
        categoryInstruction = `There is no category set. Generate 10 random interesting words or short phrases that would be fun for a party game.`;
    }

    const prompt = `You are generating decoy word candidates for a party game called "Empire".
Players have each submitted a secret word. You need to generate a list of 10 candidate words — one will be randomly selected and mixed in to throw off the other players.

${categoryInstruction}

Existing player words (every candidate MUST be DIFFERENT from all of these): ${existingList}

Rules:
- Each candidate must be COMPLETELY DIFFERENT from every existing word and from each other (not synonyms, not the same concept, not variations)
- They should be believable — something a real player might submit
- Keep each to 1-3 words maximum
- Include a wide variety — mix well-known and lesser-known picks, mainstream and niche
- Do NOT cluster around similar sub-topics. Spread across different areas within the category.

Respond ONLY with valid JSON (no markdown, no extra text):
{"words": ["word1", "word2", "word3", "word4", "word5", "word6", "word7", "word8", "word9", "word10"]}`;

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
                temperature: 1.5,
                max_tokens: 300,
                seed: Math.floor(Math.random() * 2147483647)
            }),
            signal: controller.signal,
        });

        if (!resp.ok) return null;

        const data = await resp.json();
        const text = data.choices[0].message.content.trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);
        const candidates = (parsed.words || [])
            .map(w => (w || '').trim().toLowerCase())
            .filter(w => w && !existingWords.some(e => e.toLowerCase() === w));
        if (!candidates.length) return null;
        // Randomly pick one candidate server-side
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        return pick;
    } catch (e) {
        console.error('AI Bot word generation error:', e);
        return null;
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
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  👑 Empire Game Server ⚔️');
    console.log('═══════════════════════════════════════════');
    if (process.env.RENDER_EXTERNAL_URL) {
        console.log(`  Live at: ${process.env.RENDER_EXTERNAL_URL}`);
    } else {
        console.log(`  Host (you):   http://localhost:${PORT}/host`);
        console.log(`  Players:      http://${LOCAL_IP}:${PORT}`);
    }
    console.log('═══════════════════════════════════════════');
    console.log('');
});
