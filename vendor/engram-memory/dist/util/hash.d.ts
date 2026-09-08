/** 32-bit FNV-1a hash. Fast, deterministic, good enough for feature hashing. */
export declare function fnv1a(str: string): number;
/** Stable content fingerprint used to skip unchanged rows on re-index. */
export declare function sha256(content: string): string;
/** Lowercase, hyphenate, strip noise — turns a path or title into a stable id. */
export declare function slugify(input: string): string;
//# sourceMappingURL=hash.d.ts.map