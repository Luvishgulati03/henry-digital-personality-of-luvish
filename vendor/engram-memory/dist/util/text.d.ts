/**
 * Shared tokenisation used by BOTH retrieval channels so they agree on what a
 * "meaningful word" is. Stripping stopwords here means the lexical (FTS) channel
 * ranks on rare, content-bearing terms ("migration", "admin") instead of being
 * diluted by filler ("how", "the", "with").
 */
export declare const STOPWORDS: Set<string>;
/** Lowercase word tokens with stopwords and 1-char tokens removed. */
export declare function meaningfulTokens(text: string): string[];
//# sourceMappingURL=text.d.ts.map