import type { ProviderName } from "./api";

export type { ProviderName };

/** The AI for the next answer: the user's choice, otherwise Claude when a key is set. */
export function effectiveProvider(choice: ProviderName | null, claudeConfigured: boolean): ProviderName {
  return choice ?? (claudeConfigured ? "claude" : "ollama");
}

/** Claude problems where the local AI is a good way out (offered with a button). */
const CLAUDE_TROUBLE = new Set([
  "no_key",
  "auth",
  "forbidden",
  "billing",
  "spend_limit",
  "rate_limit",
  "network",
  "timeout",
  "overloaded",
  "model_missing",
]);

export function offerOllama(code: string | null, provider: ProviderName): boolean {
  return provider === "claude" && code !== null && CLAUDE_TROUBLE.has(code);
}

/** "0.8 ¢" under a dollar, "$1.24" above. */
export function formatCost(usd: number): string {
  if (usd < 1) {
    const cents = usd * 100;
    return `${cents < 0.1 ? cents.toFixed(2) : cents.toFixed(1)} ¢`;
  }
  return `$${usd.toFixed(2)}`;
}

export const PROVIDER_LABEL: Record<ProviderName, string> = {
  claude: "Claude (Cloud)",
  ollama: "Local (Ollama)",
};
