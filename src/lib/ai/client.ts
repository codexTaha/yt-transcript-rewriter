/**
 * src/lib/ai/client.ts
 * Thin AI client abstraction — Phase 4.1
 * Provider is selected via AI_PROVIDER env (default: anthropic)
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
  const maxTokens = opts.maxTokens ?? 4096;

  if (provider === 'anthropic') {
    return callAnthropic(opts.systemPrompt, opts.userContent, opts.model, maxTokens);
  }

  throw new Error(`Unsupported AI_PROVIDER: "${provider}". Only "anthropic" is currently supported.`);
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
