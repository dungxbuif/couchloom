import type { RagStatus } from "@couchloom/core";
import type { RagQueueStats } from "./rag-job-queue.js";

export type RagIndexStatus = RagStatus;

export interface RagStatusInput {
    model: string;
    expected: number;
    indexed: number;
    queue: RagQueueStats;
    checkpoint: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastReconciliationAt: string | null;
    now?: number;
}

export function buildRagIndexStatus(input: RagStatusInput): RagIndexStatus {
    const coverage = input.expected === 0 ? 1 : Math.min(1, input.indexed / input.expected);
    const backlog = input.queue.queued + input.queue.active + input.queue.retrying;
    const state = input.queue.failed > 0 || (input.lastError !== null && (backlog > 0 || coverage < 1))
        ? "degraded"
        : backlog > 0 || coverage < 1
            ? "backfilling"
            : "ready";
    const oldestTimestamp = input.queue.oldestQueuedAt === null ? null : Date.parse(input.queue.oldestQueuedAt);
    const oldestJobAgeSeconds = oldestTimestamp === null || !Number.isFinite(oldestTimestamp)
        ? null
        : Math.max(0, ((input.now ?? Date.now()) - oldestTimestamp) / 1000);
    return {
        enabled: true,
        state,
        model: input.model,
        expected: input.expected,
        indexed: input.indexed,
        backlog,
        failed: input.queue.failed,
        coverage,
        oldestJobAgeSeconds,
        lastSuccessAt: input.lastSuccessAt,
        lastError: input.lastError,
        lastReconciliationAt: input.lastReconciliationAt,
        checkpoint: input.checkpoint,
    };
}

export function buildDisabledRagStatus(expected: number, checkpoint: string | null): RagIndexStatus {
    return {
        enabled: false,
        state: "disabled",
        model: null,
        expected,
        indexed: 0,
        backlog: 0,
        failed: 0,
        coverage: expected === 0 ? 1 : 0,
        oldestJobAgeSeconds: null,
        lastSuccessAt: null,
        lastError: null,
        lastReconciliationAt: null,
        checkpoint,
    };
}

export function summarizeRagError(error: unknown): string {
    const name = error instanceof Error && error.name ? error.name : "Error";
    return `RAG indexing failed (${name})`;
}
