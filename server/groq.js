// Shared Groq config. `llama-3.3-70b-versatile` became Enterprise-only and now 404s on
// developer keys, so every caller must go through this constant.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

// Logs the HTTP status plus a truncated body so a dead model / bad key is never silent.
async function logGroqFailure(label, resp) {
    let body = '';
    try {
        body = (await resp.text()).slice(0, 500);
    } catch (e) {
        body = '<unreadable body>';
    }
    console.error(`${label}: Groq API returned ${resp.status} ${resp.statusText} (model "${GROQ_MODEL}") — ${body}`);
}

module.exports = { GROQ_MODEL, GROQ_CHAT_URL, GROQ_MODELS_URL, logGroqFailure };
