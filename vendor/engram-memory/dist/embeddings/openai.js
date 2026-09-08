import { l2normalize } from "../util/cosine.js";
const MODEL_DIMS = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
};
/**
 * Real semantic embeddings via the OpenAI embeddings API.
 *
 * Optional by design: engram never requires it. Supply an API key (arg or
 * OPENAI_API_KEY env) to upgrade from lexical-only recall to true semantic
 * recall. Uses the global `fetch` (Node 18+), so it adds no dependency.
 */
export class OpenAIEmbeddingProvider {
    name;
    dim;
    apiKey;
    model;
    baseUrl;
    requestedDim;
    constructor(opts = {}) {
        this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
        this.model = opts.model ?? "text-embedding-3-small";
        this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
        this.requestedDim = opts.dim;
        this.dim = opts.dim ?? MODEL_DIMS[this.model] ?? 1536;
        this.name = `openai:${this.model}@${this.dim}`;
        if (!this.apiKey) {
            throw new Error("OpenAIEmbeddingProvider requires an API key (pass apiKey or set OPENAI_API_KEY).");
        }
    }
    async embed(texts) {
        if (texts.length === 0)
            return [];
        const body = { model: this.model, input: texts };
        if (this.requestedDim)
            body.dimensions = this.requestedDim;
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
        const json = (await res.json());
        const sorted = json.data.sort((a, b) => a.index - b.index);
        return sorted.map((d) => l2normalize(Float32Array.from(d.embedding)));
    }
}
//# sourceMappingURL=openai.js.map