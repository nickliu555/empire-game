const express = require('express');
const path = require('path');
const os = require('os');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ─────────────────────────────────────────────
let gameState = createFreshState();

function createFreshState() {
    return {
        phase: 'setup',        // setup | submission | playing
        groqApiKey: null,
        submissions: [],       // [{player, word}]
        shuffledWords: [],     // randomized once on game start
    };
}

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

// ─── API Routes ─────────────────────────────────────────────

// Get current game state (public - no secrets)
app.get('/api/state', (req, res) => {
    // When deployed (Render etc), use the public URL; locally use LAN IP
    const playerUrl = process.env.RENDER_EXTERNAL_URL
        || process.env.PUBLIC_URL
        || `http://${LOCAL_IP}:${PORT}`;
    res.json({
        phase: gameState.phase,
        playerCount: gameState.submissions.length,
        hasApiKey: !!gameState.groqApiKey,
        playerUrl,
    });
});

// Save API key (host only)
app.post('/api/set-key', async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required' });

    const valid = await validateApiKey(key);
    if (!valid) return res.status(401).json({ error: 'Invalid API key' });

    gameState.groqApiKey = key;
    gameState.phase = 'submission';
    res.json({ ok: true });
});

// Submit a word (players)
app.post('/api/submit', async (req, res) => {
    if (gameState.phase !== 'submission') {
        return res.status(400).json({ error: 'Not accepting submissions right now.' });
    }

    const { player, word } = req.body;
    const cleanWord = (word || '').trim().toLowerCase();
    const cleanName = (player || '').trim();

    if (!cleanName || !cleanWord) {
        return res.status(400).json({ error: 'Name and word are required.' });
    }

    // Check if this player already submitted
    if (gameState.submissions.some(s => s.player.toLowerCase() === cleanName.toLowerCase())) {
        return res.status(400).json({ error: `${cleanName} has already submitted a word.` });
    }

    // Exact duplicate check
    if (gameState.submissions.some(s => s.word === cleanWord)) {
        return res.status(400).json({ error: `That word has already been submitted. Try another!` });
    }

    // LLM similarity check
    const existingWords = gameState.submissions.map(s => s.word);
    const sim = await checkSimilarity(cleanWord, existingWords, gameState.groqApiKey);
    if (sim && sim.is_similar) {
        return res.status(400).json({ error: `Your word is too similar to a previously submitted word. Try another!` });
    }

    gameState.submissions.push({ player: cleanName, word: cleanWord });
    res.json({ ok: true, playerCount: gameState.submissions.length });
});

// Start game (host only)
app.post('/api/start', (req, res) => {
    if (gameState.submissions.length < 2) {
        return res.status(400).json({ error: 'Need at least 2 players.' });
    }
    gameState.phase = 'playing';
    gameState.shuffledWords = [...gameState.submissions]
        .sort(() => Math.random() - 0.5)
        .map(s => s.word);
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
    const key = gameState.groqApiKey; // preserve the API key
    gameState = createFreshState();
    gameState.groqApiKey = key;
    gameState.phase = 'submission';
    res.json({ ok: true });
});

// Full reset (back to API key setup)
app.post('/api/full-reset', (req, res) => {
    gameState = createFreshState();
    res.json({ ok: true });
});

// ─── Groq API helpers ───────────────────────────────────────

async function validateApiKey(key) {
    try {
        const resp = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        return resp.ok;
    } catch (e) {
        return false;
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
            })
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
        console.log(`  Host (you):   http://localhost:${PORT}?host=true`);
        console.log(`  Players:      http://${LOCAL_IP}:${PORT}`);
    }
    console.log('═══════════════════════════════════════════');
    console.log('');
});
