/**
 * src/lib/ai/client.ts
 * Thin AI client abstraction — Phase 4.1
 * Provider is selected via AI_PROVIDER env:
 *   "anthropic" → Anthropic Claude API (or compatible proxy)
 *   "gemini"    → Google Gemini API (AI Studio)
 */

export interface AIRequestOptions {
  systemPrompt: string;
  userContent:  string;
  model:        string;
  maxTokens?:   number;
}

/**
 * Call the configured AI provider and return the generated text.
 * Throws on API errors so the caller can handle retries.
 */
export async function rewriteWithAI(opts: AIRequestOptions): Promise<string> {
  const provider  = (process.env.AI_PROVIDER ?? 'anthropic').toLowerCase();
  const maxTokens = opts.maxTokens ?? 8192;

  if (provider === 'anthropic') {
    return callAnthropic(opts.systemPrompt, opts.userContent, opts.model, maxTokens);
  }

  if (provider === 'gemini') {
    return callGemini(opts.systemPrompt, opts.userContent, opts.model, maxTokens);
  }

  throw new Error(`Unsupported AI_PROVIDER: "${provider}". Valid values: "anthropic", "gemini".`);
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function callAnthropic(
  systemPrompt: string,
  userContent:  string,
  model:        string,
  maxTokens:    number
): Promise<string> {
  const apiKey  = process.env.ANTHROPIC_API_KEY ?? '';
  const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');

  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in environment variables.');

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 400)}`);
  }

  type AnthropicResponse = {
    content?: Array<{ type: string; text?: string }>;
    error?:   { message: string };
  };

  const data = await res.json() as AnthropicResponse;
  if (data.error) throw new Error(`Anthropic error: ${data.error.message}`);

  const text = data.content?.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Anthropic returned empty content');
  return text;
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
// Uses the Google AI Studio REST API (v1beta)
// Docs: https://ai.google.dev/api/generate-content

async function callGemini(
  systemPrompt: string,
  userContent:  string,
  model:        string,
  maxTokens:    number
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in environment variables.');

  // Normalize model name — strip "models/" prefix if user included it
  const modelId = model.replace(/^models\//, '');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // System instruction — Gemini treats this separately from user content
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role:  'user',
          parts: [{ text: userContent }],
        },
      ],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature:     0.7,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 400)}`);
  }

  type GeminiResponse = {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
      finishReason?: string;
    }>;
    error?: { message: string; code: number };
    promptFeedback?: { blockReason?: string };
  };

  const data = await res.json() as GeminiResponse;

  // Surface API-level errors
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);

  // Surface safety blocks
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked request: ${data.promptFeedback.blockReason}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty content');
  return text;
}
