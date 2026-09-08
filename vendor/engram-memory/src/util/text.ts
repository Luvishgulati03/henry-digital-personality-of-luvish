/**
 * Shared tokenisation used by BOTH retrieval channels so they agree on what a
 * "meaningful word" is. Stripping stopwords here means the lexical (FTS) channel
 * ranks on rare, content-bearing terms ("migration", "admin") instead of being
 * diluted by filler ("how", "the", "with").
 */
export const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it",
  "was", "with", "as", "at", "by", "be", "this", "that", "i", "you", "we",
  "my", "me", "do", "did", "does", "how", "what", "why", "when", "where",
  "who", "can", "could", "should", "would", "will", "go", "up", "down",
  "after", "before", "new", "says", "say", "said", "am", "are", "if", "but",
  "so", "from", "into", "out", "over", "about", "there", "their", "they",
  "he", "she", "his", "her", "our", "your", "its", "have", "has", "had",
  "get", "got", "set", "make", "made", "any", "all", "no", "not",
]);

/** Lowercase word tokens with stopwords and 1-char tokens removed. */
export function meaningfulTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length >= 2 && !STOPWORDS.has(t),
  );
}
