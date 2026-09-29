// Vendored from earendil-works/pi v0.87.1 (MIT): packages/ai/src/api/openai-prompt-cache.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/openai-prompt-cache.ts

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
