/**
 * Cosine similarity. Engram's embedding providers return L2-normalised vectors,
 * so for those this reduces to a dot product — but we normalise defensively here
 * so a non-normalised custom provider still behaves correctly.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** In-place L2 normalisation. Returns the same array for chaining. */
export function l2normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) * (v[i] ?? 0);
  n = Math.sqrt(n);
  if (n > 0) {
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / n;
  }
  return v;
}
