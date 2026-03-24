/**
 * src/lib/ai/models.ts
 * Verified free model IDs on OpenRouter as of March 2026.
 * Full list: https://openrouter.ai/models?max_price=0
 */

export interface ModelOption {
  id:          string;
  label:       string;
  description: string;
  default?:    boolean;
}

export const FREE_MODELS: ModelOption[] = [
  {
    id:          'meta-llama/llama-3.3-70b-instruct:free',
    label:       'Llama 3.3 70B',
    description: 'GPT-4 level quality — best overall free model',
    default:     true,
  },
  {
    id:          'google/gemma-3-27b-it:free',
    label:       'Gemma 3 27B',
    description: 'Google open model — 131K context, reliable availability',
  },
  {
    id:          'mistralai/mistral-small-3.1-24b-instruct:free',
    label:       'Mistral Small 3.1 24B',
    description: 'Mistral free tier — 128K context, good instruction following',
  },
  {
    id:          'meta-llama/llama-3.2-3b-instruct:free',
    label:       'Llama 3.2 3B',
    description: 'Fast lightweight fallback — 131K context, lowest rate-limit pressure',
  },
];

/** Ordered fallback chain: primary first, then remaining models in list order */
export function buildFallbackChain(primaryId: string): string[] {
  const others = FREE_MODELS.map(m => m.id).filter(id => id !== primaryId);
  return [primaryId, ...others];
}

export const DEFAULT_MODEL = FREE_MODELS.find(m => m.default)?.id ?? FREE_MODELS[0].id;
