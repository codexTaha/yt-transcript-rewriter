/**
 * src/lib/ai/client.ts
 * Thin AI client — supports Anthropic, Gemini, and OpenRouter.
 * Provider selected via AI_PROVIDER env: "anthropic" | "gemini" | "openrouter"
 */

export interface AIRequestOptions {
  systemPrompt: string;
  userContent:  string;
  model:        string;
  maxTokens?:   number;
}

export async function rewriteWithAI(opts: AIRequestOptions): Promise<string> {
  const provider  = (process.env.AI_PROVIDER ?? 'openrouter').toLowerCase();
  const maxTokens = opts.maxTokens ?? 8192;

  if (provider === 'anthropic')  return callAnthropic(opts.systemPrompt, opts.userContent, opts.model, maxTokens);
  if (provider === 'gemini')     return callGemini(opts.systemPrompt, opts.userContent, opts.model, maxTokens);
  if (provider === 'openrouter') return callOpenRouter(opts.systemPrompt, opts.userContent, opts.model, maxTokens);

  throw new Error(`Unsupported AI_PROVIDER: "${provider}". Valid values: "anthropic", "gemini", "openrouter".`);
}

// ── Anthropic ────────────────────────────────────────────────────────────────
async function callAnthropic(systemPrompt: string, userContent: string, model: string, maxTokens: number): Promise<string> {
  const apiKey  = process.env.ANTHROPIC_API_KEY ?? '';
  const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userContent }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  type R = { content?: Array<{ type: string; text?: string }>; error?: { message: string } };
  const data = await res.json() as R;
  if (data.error) throw new Error(`Anthropic error: ${data.error.message}`);
  const text = data.content?.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Anthropic returned empty content');
  return text;
}

// ── Google Gemini ────────────────────────────────────────────────────────────
async function callGemini(systemPrompt: string, userContent: string, model: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');
  const modelId = model.replace(/^models\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  type R = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>; error?: { message: string; code: number }; promptFeedback?: { blockReason?: string } };
  const data = await res.json() as R;
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked: ${data.promptFeedback.blockReason}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty content');
  return text;
}

// ── OpenRouter ───────────────────────────────────────────────────────────────
// Uses OpenAI-compatible chat completions endpoint.
// Docs: https://openrouter.ai/docs
async function callOpenRouter(systemPrompt: string, userContent: string, model: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set. Get one at https://openrouter.ai/keys');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer':  process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
      'X-Title':       'YT Transcript Rewriter',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent },
      ],
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // Surface rate-limit explicitly so the pump backoff logic catches it
    if (res.status === 429) throw new Error(`429 Rate limit: ${body.slice(0, 200)}`);
    throw new Error(`OpenRouter API error ${res.status}: ${body.slice(0, 400)}`);
  }

  type R = {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    error?:   { message: string; code?: number };
  };
  const data = await res.json() as R;
  if (data.error) throw new Error(`OpenRouter error: ${data.error.message}`);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned empty content');
  return text;
}
