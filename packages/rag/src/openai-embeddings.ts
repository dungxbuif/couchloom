import type { EmbeddingProvider } from "./indexer.js";

export interface OpenAIEmbeddingOptions {
    baseUrl: string;
    apiKey?: string;
    model: string;
    dimensions: number;
}

export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
    readonly dimensions: number;
    readonly model: string;
    readonly #baseUrl: string;
    readonly #apiKey?: string;

    constructor(options: OpenAIEmbeddingOptions) {
        this.#baseUrl = options.baseUrl.replace(/\/$/, "");
        this.#apiKey = options.apiKey;
        this.model = options.model;
        this.dimensions = options.dimensions;
    }

    async embed(texts: string[]): Promise<number[][]> {
        const response = await fetch(`${this.#baseUrl}/embeddings`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
            },
            body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions }),
        });
        if (!response.ok) throw new Error(`Embedding API failed with HTTP ${response.status}`);
        const payload = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
        if (!payload.data) throw new Error("Embedding API response is missing data");
        return payload.data.sort((a, b) => a.index - b.index).map(({ embedding }) => embedding);
    }
}
