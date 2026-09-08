import { l2normalize } from "../util/cosine.js";
import type { EmbeddingProvider } from "./provider.js";

const MODEL_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export interface OpenAIEmbeddingOptions {
  apiKey?: string;
  model?: string;
  /** Optional reduced dimensionality (text-embedding-3-* support this). */
  dim?: number;
  baseUrl?: string;
}

/**
 * Real semantic embeddings via the OpenAI embeddings API.
 *
 * Optional by design: engram never requires it. Supply an API key (arg or
 * OPENAI_API_KEY env) to upgrade from lexical-only recall to true semantic
 * recall. Uses the global `fetch` (Node 18+), so it adds no dependency.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly requestedDim?: number;

  constructor(opts: OpenAIEmbeddingOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = opts.model ?? "text-embedding-3-small";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.requestedDim = opts.dim;
    this.dim = opts.dim ?? MODEL_DIMS[this.model] ?? 1536;
    this.name = `openai:${this.model}@${this.dim}`;
    if (!this.apiKey) {
      throw new Error(
        "OpenAIEmbeddingProvider requires an API key (pass apiKey or set OPENAI_API_KEY).",
      );
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const body: Record<string, unknown> = { model: this.model, input: texts };
    if (this.requestedDim) body.dimensions = this.requestedDim;

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => l2normalize(Float32Array.from(d.embedding)));
  }
}
