// Local OpenAI-compatible shim in front of headless `claude -p`.
//
// utils/ai-text-service.js talks to text providers through the real `openai`
// npm SDK (POST {baseURL}/chat/completions). This server implements just
// enough of that surface for the SDK to work, but instead of calling a paid
// API it shells out to the Claude Code CLI, which is authenticated via the
// operator's Claude Pro/Max subscription login (no ANTHROPIC_API_KEY here).
//
// Only agents/script-writer-agent.js is wired to request this provider
// (see PROVIDERS.claudecode in ai-text-service.js) — every other agent keeps
// using the channel's default provider (e.g. free-tier Gemini), because each
// `claude -p` call carries a large fixed context/cache-creation overhead
// that isn't worth paying for cheap, high-volume calls like SEO tags or
// per-scene image prompts.
//
// Run this alongside the main app: `npm run claude-shim`.

require('dotenv').config();
const express = require('express');
const { execFile } = require('child_process');

const PORT = Number(process.env.CLAUDECODE_SHIM_PORT || 8787);
const REQUIRED_KEY = process.env.CLAUDECODE_SHIM_KEY || null;
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDECODE_SHIM_TIMEOUT_MS || 300000);

const app = express();
app.use(express.json({ limit: '10mb' }));

function promptFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  // ai-text-service.js always sends a single { role: 'user', content } message,
  // but concatenate defensively in case a caller sends a system + user pair.
  return messages
    .map((m) => (m && typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--restricted', '--permission-prompts', 'none'],
      { maxBuffer: 1024 * 1024 * 50, timeout: CLAUDE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`claude CLI failed: ${error.message}${stderr ? ` | stderr: ${stderr}` : ''}`));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch (parseError) {
          reject(new Error(`claude CLI returned non-JSON output: ${parseError.message}`));
          return;
        }
        if (parsed.is_error) {
          reject(new Error(`claude CLI reported an error: ${parsed.result || parsed.subtype || 'unknown error'}`));
          return;
        }
        if (typeof parsed.result !== 'string' || !parsed.result.trim()) {
          reject(new Error('claude CLI returned an empty result'));
          return;
        }
        resolve({ text: parsed.result, raw: parsed });
      }
    );
  });
}

app.post('/v1/chat/completions', async (req, res) => {
  if (REQUIRED_KEY) {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token !== REQUIRED_KEY) {
      return res.status(401).json({ error: { message: 'Invalid shim API key' } });
    }
  }

  try {
    const prompt = promptFromMessages(req.body && req.body.messages);
    console.log(`[claude-cli-shim] generating (${prompt.length} chars prompt)...`);
    const { text, raw } = await runClaude(prompt);
    console.log(`[claude-cli-shim] done in ${raw.duration_ms || '?'}ms, cost≈$${raw.total_cost_usd ?? '?'}`);

    res.json({
      id: `chatcmpl-shim-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: (req.body && req.body.model) || 'claude-code-cli',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: raw.usage?.input_tokens || 0,
        completion_tokens: raw.usage?.output_tokens || 0,
        total_tokens: (raw.usage?.input_tokens || 0) + (raw.usage?.output_tokens || 0),
      },
    });
  } catch (error) {
    console.error('[claude-cli-shim] error:', error.message);
    res.status(500).json({ error: { message: error.message } });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, provider: 'claude-code-cli' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[claude-cli-shim] listening on http://127.0.0.1:${PORT} (proxying to headless \`claude -p\`)`);
});
