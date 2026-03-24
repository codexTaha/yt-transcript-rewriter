/**
 * src/lib/ai/client.ts
 * AI client with automatic fallback chain.
 * Retries on: 429 (rate-limit), 404 (no endpoint), and model-specific 400s
 * (e.g. Gemma rejects system role — "Developer instruction is not enabled").
 */

import { buildFallbackChain, FREE_MODELS } from './models';

export interface AIRequestOptions {
  systemPrompt: string;
  userContent:  string;
  model:        string;
  maxTokens?:   number;
}

export async function rewriteWithAI(opts: AIRequestOptions): Promise<string> {
  const provider  = (process.env.AI_PROVIDER ?? 'openrouter').toLowerCase();
  const maxTokens = opts.maxTokens ?? parseInt(process.env.AI_MAX_TOKENS ?? '8192', 10);

  if (provider === 'anthropic') return callAnthropic(opts.systemPrompt, opts.userContent, opts.model, maxTokens);
  if (provider === 'gemini')    return callGemini(opts.systemPrompt, opts.userContent, opts.model, maxTokens);

  // OpenRouter — walk fallback chain on any retryable error
  const chain = buildFallbackChain(opts.model);
  let lastError: Error | null = null;

  for (const modelId of chain) {
    try {
      const modelDef  = FREE_MODELS.find(m => m.id === modelId);
      const noSysRole = modelDef?.noSystemPrompt ?? false;
      return await callOpenRouter(opts.systemPrompt, opts.userContent, modelId, maxTokens, noSysRole);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg       = lastError.message;
      const is429     = msg.includes('429');
      const is404     = msg.includes('404');             // "No endpoints found"
      const isSysPErr = msg.includes('Developer instruction') || msg.includes('system role');
      const retryable = is429 || is404 || isSysPErr;
      if (!retryable) throw lastError;
      const reason = is429 ? '429 rate-limit' : is404 ? '404 no endpoint' : '400 system-prompt unsupported';
      console.warn(`[ai/client] ${reason} on ${modelId}, trying next fallback…`);
    }
  }

  throw lastError ?? new Error('All AI models exhausted');
}

// ── Anthropic ───────────────────────────────────────────────────────────────
async function callAnthropic(sys: string, user: string, model: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
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
  if (data.error)                       throw new Error(`Gemini: ${data.error.message}`);
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked: ${data.promptFeedback.blockReason}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── OpenRouter ───────────────────────────────────────────────────────────────
async function callOpenRouter(
  sys: string,
  user: string,
  model: string,
  maxTokens: number,
  noSystemRole = false,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set. Get one free at https://openrouter.ai/keys');

  // Some models (e.g. Gemma via Google AI Studio) reject the "system" role.
  // For those we prepend the system instructions into the first user message.
  const messages = noSystemRole
    ? [{ role: 'user', content: `${sys}\n\n---\n\n${user}` }]
    : [
        { role: 'system', content: sys  },
        { role: 'user',   content: user },
      ];

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer':  process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
      'X-Title':       'YT Transcript Rewriter',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.7, messages }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) throw new Error(`429 Rate limit [${model}]: ${body.slice(0, 200)}`);
    if (res.status === 404) throw new Error(`404 No endpoint [${model}]: ${body.slice(0, 200)}`);
    // Surface 400 body so the caller can detect system-prompt rejections
    throw new Error(`OpenRouter API error ${res.status} [${model}]: ${body.slice(0, 300)}`);
  }

  type R = { choices?: Array<{ message?: { content?: string } }>; error?: { message: string } };
  const data = await res.json() as R;
  if (data.error) {
    const msg = data.error.message ?? '';
    if (msg.includes('rate') || msg.includes('429'))                      throw new Error(`429 Rate limit [${model}]: ${msg}`);
    if (msg.includes('endpoint') || msg.includes('not a valid model'))    throw new Error(`404 No endpoint [${model}]: ${msg}`);
    if (msg.includes('Developer instruction') || msg.includes('INVALID')) throw new Error(`Developer instruction is not enabled [${model}]: ${msg}`);
    throw new Error(`OpenRouter error [${model}]: ${msg}`);
  }
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter returned empty content [${model}]`);
  return text;
}
