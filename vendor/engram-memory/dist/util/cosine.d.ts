/**
 * Cosine similarity. Engram's embedding providers return L2-normalised vectors,
 * so for those this reduces to a dot product — but we normalise defensively here
 * so a non-normalised custom provider still behaves correctly.
 */
export declare function cosine(a: Float32Array, b: Float32Array): number;
/** In-place L2 normalisation. Returns the same array for chaining. */
export declare function l2normalize(v: Float32Array): Float32Array;
//# sourceMappingURL=cosine.d.ts.map