/**
 * src/lib/ai/client.ts
 * AI client with automatic 3-model fallback on 429.
 * Supports Anthropic, Gemini, and OpenRouter (default).
 */

import { buildFallbackChain } from './models';

export interface AIRequestOptions {
  systemPrompt: string;
  userContent:  string;
  model:        string; // primary model ID — fallbacks tried automatically on 429
  maxTokens?:   number;
}

/**
 * Main entry point.
 * On 429 from OpenRouter it walks the fallback chain before throwing.
 */
export async function rewriteWithAI(opts: AIRequestOptions): Promise<string> {
  const provider  = (process.env.AI_PROVIDER ?? 'openrouter').toLowerCase();
  const maxTokens = opts.maxTokens ?? parseInt(process.env.AI_MAX_TOKENS ?? '8192', 10);

  if (provider === 'anthropic') return callAnthropic(opts.systemPrompt, opts.userContent, opts.model, maxTokens);
  if (provider === 'gemini')    return callGemini(opts.systemPrompt, opts.userContent, opts.model, maxTokens);

  // OpenRouter — try primary then fallbacks automatically
  const chain = buildFallbackChain(opts.model);
  let lastError: Error | null = null;
  for (const modelId of chain) {
    try {
      const result = await callOpenRouter(opts.systemPrompt, opts.userContent, modelId, maxTokens);
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const is429 = lastError.message.includes('429');
      if (!is429) throw lastError; // non-rate-limit error — don't try fallbacks
      console.warn(`[ai/client] 429 on ${modelId}, trying next fallback…`);
    }
  }
  // All models rate-limited — surface the last 429 so the pump backs off
  throw lastError ?? new Error('All AI models rate-limited (429)');
}

// ── Anthropic ────────────────────────────────────────────────────────────────
async function callAnthropic(sys: string, user: string, model: string, maxTokens: number): Promise<string> {
  const apiKey  = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: sys, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  type R = { content?: Array<{ type: string; text?: string }>; error?: { message: string } };
  const data = await res.json() as R;
  if (data.error) throw new Error(`Anthropic: ${data.error.message}`);
  return data.content?.find(b => b.type === 'text')?.text ?? '';
}

// ── Google Gemini ────────────────────────────────────────────────────────────
async function callGemini(sys: string, user: string, model: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');
  const id  = model.replace(/^models\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  type R = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message: string }; promptFeedback?: { blockReason?: string } };
  const data = await res.json() as R;
  if (data.error)                      throw new Error(`Gemini: ${data.error.message}`);
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked: ${data.promptFeedback.blockReason}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── OpenRouter ───────────────────────────────────────────────────────────────
async function callOpenRouter(sys: string, user: string, model: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set. Get one free at https://openrouter.ai/keys');

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
      max_tokens:  maxTokens,
      temperature: 0.7,
      messages: [
        { role: 'system', content: sys  },
        { role: 'user',   content: user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // Preserve 429 prefix so callers can detect rate-limit
    if (res.status === 429) throw new Error(`429 Rate limit [${model}]: ${body.slice(0, 200)}`);
    throw new Error(`OpenRouter API error ${res.status} [${model}]: ${body.slice(0, 300)}`);
  }

  type R = {
    choices?: Array<{ message?: { content?: string } }>;
    error?:   { message: string };
  };
  const data = await res.json() as R;
  if (data.error) throw new Error(`OpenRouter error [${model}]: ${data.error.message}`);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter returned empty content [${model}]`);
  return text;
}
