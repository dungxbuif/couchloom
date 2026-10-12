import type { RagStatus } from "@couchloom/core";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { RagQueueStats } from "./rag-job-queue.js";

export class CouchLoomMetrics {
    readonly #registry = new Registry();
    readonly #expected = this.#gauge(
        "couchloom_rag_documents_expected",
        "Expected Markdown documents in the RAG index.",
    );
    readonly #indexed = this.#gauge(
        "couchloom_rag_documents_indexed",
        "Documents currently present in the RAG index.",
    );
    readonly #coverage = this.#gauge(
        "couchloom_rag_coverage_ratio",
        "RAG index coverage ratio from zero to one.",
    );
    readonly #queueJobs = new Gauge({
        name: "couchloom_rag_queue_jobs",
        help: "RAG jobs by durable queue state.",
        labelNames: ["vault_id", "state"] as const,
        registers: [this.#registry],
    });
    readonly #oldestJob = this.#gauge(
        "couchloom_rag_oldest_job_age_seconds",
        "Age in seconds of the oldest queued or retrying RAG job.",
    );
    readonly #retries = this.#counter(
        "couchloom_rag_retries_total",
        "RAG processing retry attempts observed by CouchLoom.",
    );
    readonly #failures = this.#counter(
        "couchloom_rag_failures_total",
        "RAG processing failures observed by CouchLoom.",
    );
    readonly #reconciliation = this.#histogram(
        "couchloom_rag_reconciliation_duration_seconds",
        "RAG reconciliation duration in seconds.",
    );
    readonly #embedding = this.#histogram(
        "couchloom_rag_embedding_duration_seconds",
        "RAG document embedding and persistence duration in seconds.",
    );
    readonly #search = this.#histogram(
        "couchloom_rag_search_duration_seconds",
        "Semantic search duration in seconds.",
    );
    readonly #watcherLag = this.#gauge(
        "couchloom_couchdb_watcher_lag",
        "Observed CouchDB watcher lag in changes.",
    );

    get contentType(): string {
        return this.#registry.contentType;
    }

    metrics(): Promise<string> {
        return this.#registry.metrics();
    }

    recordStatus(vaultId: string, status: RagStatus): void {
        this.#expected.set({ vault_id: vaultId }, status.expected);
        this.#indexed.set({ vault_id: vaultId }, status.indexed);
        this.#coverage.set({ vault_id: vaultId }, status.coverage);
        this.#oldestJob.set({ vault_id: vaultId }, status.oldestJobAgeSeconds ?? 0);
    }

    recordQueueStats(vaultId: string, stats: RagQueueStats): void {
        this.#queueJobs.set({ vault_id: vaultId, state: "queued" }, stats.queued);
        this.#queueJobs.set({ vault_id: vaultId, state: "active" }, stats.active);
        this.#queueJobs.set({ vault_id: vaultId, state: "retrying" }, stats.retrying);
        this.#queueJobs.set({ vault_id: vaultId, state: "failed" }, stats.failed);
    }

    recordRetry(vaultId: string): void {
        this.#retries.inc({ vault_id: vaultId });
    }

    recordFailure(vaultId: string): void {
        this.#failures.inc({ vault_id: vaultId });
    }

    observeReconciliation(vaultId: string, seconds: number): void {
        this.#reconciliation.observe({ vault_id: vaultId }, seconds);
    }

    observeEmbedding(vaultId: string, seconds: number): void {
        this.#embedding.observe({ vault_id: vaultId }, seconds);
    }

    observeSearch(vaultId: string, seconds: number): void {
        this.#search.observe({ vault_id: vaultId }, seconds);
    }

    setWatcherLag(vaultId: string, changes: number): void {
        this.#watcherLag.set({ vault_id: vaultId }, changes);
    }

    #gauge(name: string, help: string): Gauge<"vault_id"> {
        return new Gauge({ name, help, labelNames: ["vault_id"] as const, registers: [this.#registry] });
    }

    #counter(name: string, help: string): Counter<"vault_id"> {
        return new Counter({ name, help, labelNames: ["vault_id"] as const, registers: [this.#registry] });
    }

    #histogram(name: string, help: string): Histogram<"vault_id"> {
        return new Histogram({
            name,
            help,
            labelNames: ["vault_id"] as const,
            buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
            registers: [this.#registry],
        });
    }
}

export interface ReadinessResult {
    httpStatus: 200 | 503;
    body: {
        status: "ready" | "unavailable";
        vaults: number;
        rag: {
            enabled: boolean;
            state: RagStatus["state"];
            coverage: number;
            backlog: number;
            failed: number;
        };
    };
}

export function aggregateReadiness(coreReady: boolean, vaults: number, statuses: RagStatus[]): ReadinessResult {
    const enabled = statuses.some((status) => status.enabled);
    const expected = statuses.reduce((total, status) => total + status.expected, 0);
    const indexed = statuses.reduce((total, status) => total + status.indexed, 0);
    const coverage = expected === 0 ? 1 : Math.min(1, indexed / expected);
    const backlog = statuses.reduce((total, status) => total + status.backlog, 0);
    const failed = statuses.reduce((total, status) => total + status.failed, 0);
    const state = selectRagState(statuses);
    return {
        httpStatus: coreReady ? 200 : 503,
        body: {
            status: coreReady ? "ready" : "unavailable",
            vaults,
            rag: { enabled, state, coverage, backlog, failed },
        },
    };
}

function selectRagState(statuses: RagStatus[]): RagStatus["state"] {
    if (statuses.some((status) => status.state === "degraded")) return "degraded";
    if (statuses.some((status) => status.state === "backfilling")) return "backfilling";
    if (statuses.some((status) => status.state === "ready")) return "ready";
    return "disabled";
}
