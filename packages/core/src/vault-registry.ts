import type { SearchIndex } from "./search.js";
import type { VaultBackend } from "./vault-backend.js";

export interface VaultContext {
    id: string;
    name: string;
    backend: VaultBackend;
    searchIndex: SearchIndex;
    onDocumentChange?: (path: string, content: string | null, mtime?: number) => Promise<void>;
    semanticSearch?: (query: string, limit?: number, folder?: string) => Promise<SemanticSearchResult[]>;
    ragStatus?: () => RagStatus | Promise<RagStatus>;
}

export type RagState = "disabled" | "ready" | "backfilling" | "degraded";

export interface RagStatus {
    enabled: boolean;
    state: RagState;
    model: string | null;
    expected: number;
    indexed: number;
    backlog: number;
    failed: number;
    coverage: number;
    oldestJobAgeSeconds: number | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastReconciliationAt: string | null;
    checkpoint: string | null;
}

export interface SemanticSearchResult {
    path: string;
    chunkIndex: number;
    content: string;
    score: number;
}

export type VaultSummary = Pick<VaultContext, "id" | "name">;

export class VaultRegistry {
    readonly #contexts = new Map<string, VaultContext>();

    constructor(contexts: VaultContext[]) {
        for (const context of contexts) {
            if (this.#contexts.has(context.id)) throw new Error(`Duplicate vault id: ${context.id}`);
            this.#contexts.set(context.id, context);
        }
    }

    get(id: string): VaultContext {
        const context = this.#contexts.get(id);
        if (!context) throw new Error(`Unknown vault_id: ${id}`);
        return context;
    }

    list(): VaultSummary[] {
        return [...this.#contexts.values()].map(({ id, name }) => ({ id, name }));
    }

    async initAll(): Promise<void> {
        for (const context of this.#contexts.values()) await context.backend.init();
    }

    async closeAll(): Promise<void> {
        const results = await Promise.allSettled([...this.#contexts.values()].map(({ backend }) => backend.close()));
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "Failed to close one or more vaults");
    }
}
