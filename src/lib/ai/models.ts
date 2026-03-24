/**
 * src/lib/ai/models.ts
 * Canonical list of OpenRouter free models.
 * Primary model is tried first; on 429 the client automatically falls
 * back to fallback1, then fallback2, before giving up.
 *
 * Real model IDs verified at https://openrouter.ai/models?max_price=0
 */

export interface ModelOption {
  id:          string;  // exact OpenRouter model ID
  label:       string;  // display name shown in UI
  description: string;  // short note
  default?:    boolean;
}

export const FREE_MODELS: ModelOption[] = [
  {
    id:          'deepseek/deepseek-r1-0528:free',
    label:       'DeepSeek R1 (May 2528)',
    description: 'Strong reasoning model — excellent for long-form rewriting',
    default:     true,
  },
  {
    id:          'meta-llama/llama-3.3-70b-instruct:free',
    label:       'Llama 3.3 70B',
    description: 'Fast & capable — good balance of speed and quality',
  },
  {
    id:          'mistralai/mistral-7b-instruct:free',
    label:       'Mistral 7B',
    description: 'Lightweight fallback — lowest rate-limit pressure',
  },
];

/** Ordered fallback chain given a chosen primary model ID */
export function buildFallbackChain(primaryId: string): string[] {
  const others = FREE_MODELS.map(m => m.id).filter(id => id !== primaryId);
  return [primaryId, ...others];
}

export const DEFAULT_MODEL = FREE_MODELS.find(m => m.default)?.id ?? FREE_MODELS[0].id;
