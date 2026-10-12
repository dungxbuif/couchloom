import { describe, expect, test } from "bun:test";
import type { RagStatus } from "@couchloom/core";
import { CouchLoomMetrics, aggregateReadiness } from "../../src/metrics.js";

describe("CouchLoomMetrics", () => {
    test("exports documented metric types without note-path or query labels", async () => {
        const metrics = new CouchLoomMetrics();
        metrics.recordStatus("personal", status("backfilling"));
        metrics.recordQueueStats("personal", { queued: 1, active: 0, retrying: 1, failed: 0, oldestQueuedAt: null });
        metrics.recordRetry("personal");
        metrics.recordFailure("personal");
        metrics.observeReconciliation("personal", 0.25);
        metrics.observeEmbedding("personal", 0.5);
        metrics.observeSearch("personal", 0.05);
        metrics.setWatcherLag("personal", 2);

        const output = await metrics.metrics();

        for (const name of [
            "couchloom_rag_documents_expected",
            "couchloom_rag_documents_indexed",
            "couchloom_rag_coverage_ratio",
            "couchloom_rag_queue_jobs",
            "couchloom_rag_oldest_job_age_seconds",
            "couchloom_rag_retries_total",
            "couchloom_rag_failures_total",
            "couchloom_rag_reconciliation_duration_seconds",
            "couchloom_rag_embedding_duration_seconds",
            "couchloom_rag_search_duration_seconds",
            "couchloom_couchdb_watcher_lag",
        ]) {
            expect(output).toContain(`# HELP ${name}`);
            expect(output).toContain(`# TYPE ${name}`);
        }
        expect(output).not.toContain("path=");
        expect(output).not.toContain("query=");
        expect(output).not.toContain("secret.md");
    });

    test("uses an isolated registry so repeated initialization is safe", async () => {
        const first = new CouchLoomMetrics();
        const second = new CouchLoomMetrics();
        first.recordRetry("personal");

        expect(await first.metrics()).toContain("couchloom_rag_retries_total{vault_id=\"personal\"} 1");
        expect(await second.metrics()).not.toContain("vault_id=\"personal\"");
    });
});

describe("readiness aggregation", () => {
    test.each(["ready", "backfilling", "degraded"] as const)(
        "returns HTTP 200 while core is usable and RAG is %s",
        (stateName) => {
            const readiness = aggregateReadiness(true, 1, [status(stateName)]);
            expect(readiness.httpStatus).toBe(200);
            expect(readiness.body).toMatchObject({
                status: "ready",
                vaults: 1,
                rag: { enabled: true, state: stateName },
            });
        },
    );

    test("returns HTTP 503 only when core vault metadata is unavailable", () => {
        const unavailable = aggregateReadiness(false, 1, [status("ready")]);
        expect(unavailable.httpStatus).toBe(503);
        expect(unavailable.body.status).toBe("unavailable");

        const degraded = aggregateReadiness(true, 1, [status("degraded")]);
        expect(degraded.httpStatus).toBe(200);
    });
});

function status(stateName: RagStatus["state"]): RagStatus {
    const failed = stateName === "degraded" ? 1 : 0;
    const backlog = stateName === "backfilling" ? 2 : 0;
    const indexed = stateName === "ready" ? 10 : 8;
    return {
        enabled: true,
        state: stateName,
        model: "nomic-embed-text",
        expected: 10,
        indexed,
        backlog,
        failed,
        coverage: indexed / 10,
        oldestJobAgeSeconds: backlog ? 4 : null,
        lastSuccessAt: null,
        lastError: failed ? "RAG indexing failed (Error)" : null,
        lastReconciliationAt: null,
        checkpoint: "1",
    };
}
