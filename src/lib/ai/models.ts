/**
 * src/lib/ai/models.ts
 * Verified free model IDs on OpenRouter — March 2026.
 * Full list: https://openrouter.ai/models?max_price=0
 */

export interface ModelOption {
  id:          string;
  label:       string;
  description: string;
  default?:    boolean;
  noSystemPrompt?: boolean; // true = model rejects system role; send sys as first user msg instead
}

export const FREE_MODELS: ModelOption[] = [
  {
    id:          'meta-llama/llama-3.3-70b-instruct:free',
    label:       'Llama 3.3 70B',
    description: 'Best quality free model — GPT-4 level',
    default:     true,
  },
  {
    id:          'qwen/qwen3-next-80b-a3b-instruct:free',
    label:       'Qwen3 Next 80B',
    description: 'Alibaba large model — very capable, good for long-form rewrites',
  },
  {
    id:          'z-ai/glm-4.5-air:free',
    label:       'GLM-4.5 Air',
    description: 'ZhipuAI — lightweight, low rate-limit pressure',
  },
  {
    id:          'meta-llama/llama-3.2-3b-instruct:free',
    label:       'Llama 3.2 3B',
    description: 'Emergency fallback — fastest, lowest rate-limit ceiling',
  },
];

/** Set of known-valid model IDs for quick lookup */
export const KNOWN_MODEL_IDS = new Set(FREE_MODELS.map(m => m.id));

/** Ordered fallback chain: primary first, then remaining models in list order */
export function buildFallbackChain(primaryId: string): string[] {
  const others = FREE_MODELS.map(m => m.id).filter(id => id !== primaryId);
  return [primaryId, ...others];
}

/**
 * Sanitize a model ID read from the DB.
 * If it's unknown/stale (e.g. old job rows with a retired model),
 * fall back to the default model instead of hammering a dead endpoint.
 */
export function sanitizeModelId(id: string | null | undefined): string {
  if (id && KNOWN_MODEL_IDS.has(id)) return id;
  return DEFAULT_MODEL;
}

export const DEFAULT_MODEL = FREE_MODELS.find(m => m.default)?.id ?? FREE_MODELS[0].id;
