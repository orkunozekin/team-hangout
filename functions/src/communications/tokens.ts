/** Exact normalized word tokens. Keep the emoji allowlist aligned with shared/conversations.ts. */

export const MESSAGE_TOKEN_LIMIT = 200;
export const QUERY_TOKEN_LIMIT = 5;

export const REACTION_CHOICES = [
  { code: "yes", emoji: "👍" },
  { code: "heart", emoji: "❤️" },
  { code: "celebrate", emoji: "🎉" },
  { code: "laugh", emoji: "😂" },
  { code: "clap", emoji: "👏" },
  { code: "check", emoji: "✅" },
  { code: "question", emoji: "❓" },
] as const;

export type ReactionCode = (typeof REACTION_CHOICES)[number]["code"];

export function reactionChoice(emoji: string): (typeof REACTION_CHOICES)[number] | undefined {
  return REACTION_CHOICES.find((choice) => choice.emoji === emoji);
}

export function textTokens(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (part.length < 2 || seen.has(part)) continue;
    seen.add(part);
    tokens.push(part);
  }
  return tokens;
}

export function messageTokens(body: string): string[] {
  const tokens = textTokens(body);
  if (tokens.length > MESSAGE_TOKEN_LIMIT) {
    throw new Error("Use 200 or fewer distinct words.");
  }
  return tokens;
}

export function queryTokens(query: string): string[] {
  const tokens = textTokens(query);
  if (tokens.length < 1) throw new Error("Enter a word of at least 2 letters or numbers.");
  if (tokens.length > QUERY_TOKEN_LIMIT) throw new Error("Search for at most five words.");
  return tokens;
}
