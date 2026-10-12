import { PgBoss } from "pg-boss";

export const RAG_INDEX_QUEUE = "rag-index";
export const RAG_DEAD_LETTER_QUEUE = "rag-index-dead-letter";

export interface RagIndexJob {
    vaultId: string;
    path: string;
    observedMtime?: number;
}

export interface RagQueueStats {
    queued: number;
    active: number;
    retrying: number;
    failed: number;
    oldestQueuedAt: string | null;
}

export interface PgBossJob<T> {
    id: string;
    data: T;
    state: "created" | "retry" | "active" | "completed" | "cancelled" | "failed";
    singletonKey: string | null;
    createdOn: Date;
}

export interface PgBossLike {
    start(): Promise<unknown>;
    createQueue(name: string, options?: Record<string, unknown>): Promise<void>;
    updateQueue(name: string, options: Record<string, unknown>): Promise<void>;
    upsert(
        name: string,
        data: RagIndexJob,
        options: Record<string, unknown>,
    ): Promise<{ jobs: string[]; updated: number; inserted: number }>;
    work(
        name: string,
        options: Record<string, unknown>,
        handler: (jobs: PgBossJob<RagIndexJob>[]) => Promise<void>,
    ): Promise<string>;
    findJobs(name: string, options?: { data?: Partial<RagIndexJob> }): Promise<PgBossJob<RagIndexJob>[]>;
    redrive(name: string, options?: Record<string, unknown>): Promise<number>;
    stop(options?: Record<string, unknown>): Promise<void>;
}

export interface RagJobQueueOptions {
    boss?: PgBossLike;
    concurrency?: number;
    retryLimit?: number;
    retryDelaySeconds?: number;
    retryDelayMaxSeconds?: number;
    heartbeatSeconds?: number;
    shutdownGraceMs?: number;
}

export class RagJobQueue {
    readonly #boss: PgBossLike;
    readonly #concurrency: number;
    readonly #retryLimit: number;
    readonly #retryDelaySeconds: number;
    readonly #retryDelayMaxSeconds: number;
    readonly #heartbeatSeconds: number;
    readonly #shutdownGraceMs: number;
    #started = false;

    constructor(databaseUrl: string, options: RagJobQueueOptions = {}) {
        this.#boss = options.boss ?? (new PgBoss(databaseUrl) as unknown as PgBossLike);
        this.#concurrency = positiveInteger(options.concurrency ?? 1, "concurrency");
        this.#retryLimit = nonNegativeInteger(options.retryLimit ?? 10, "retryLimit");
        this.#retryDelaySeconds = positiveInteger(options.retryDelaySeconds ?? 1, "retryDelaySeconds");
        this.#retryDelayMaxSeconds = positiveInteger(options.retryDelayMaxSeconds ?? 900, "retryDelayMaxSeconds");
        this.#heartbeatSeconds = positiveInteger(options.heartbeatSeconds ?? 30, "heartbeatSeconds");
        this.#shutdownGraceMs = positiveInteger(options.shutdownGraceMs ?? 30_000, "shutdownGraceMs");
    }

    async start(): Promise<void> {
        if (this.#started) return;
        await this.#boss.start();
        await this.#boss.createQueue(RAG_DEAD_LETTER_QUEUE);
        await this.#boss.createQueue(RAG_INDEX_QUEUE, {
            policy: "standard",
            ...this.#queuePolicy(),
        });
        await this.#boss.updateQueue(RAG_INDEX_QUEUE, this.#queuePolicy());
        this.#started = true;
    }

    async enqueue(job: RagIndexJob): Promise<void> {
        validateJob(job);
        await this.#boss.upsert(RAG_INDEX_QUEUE, job, {
            singletonKey: `${job.vaultId}:${job.path}`,
            ...this.#queuePolicy(),
        });
    }

    async work(handler: (job: RagIndexJob) => Promise<void>): Promise<void> {
        await this.#boss.work(
            RAG_INDEX_QUEUE,
            { batchSize: 1, localConcurrency: this.#concurrency },
            async (jobs) => {
                for (const job of jobs) {
                    validateJob(job.data);
                    await handler(job.data);
                }
            },
        );
    }

    async stats(vaultId?: string): Promise<RagQueueStats> {
        const filter = vaultId ? { data: { vaultId } } : undefined;
        const [jobs, deadLetters] = await Promise.all([
            this.#boss.findJobs(RAG_INDEX_QUEUE, filter),
            this.#boss.findJobs(RAG_DEAD_LETTER_QUEUE, filter),
        ]);
        const pending = jobs.filter((job) => job.state === "created" || job.state === "retry");
        const oldest = pending.reduce<Date | null>(
            (current, job) => (!current || job.createdOn < current ? job.createdOn : current),
            null,
        );
        return {
            queued: jobs.filter((job) => job.state === "created").length,
            active: jobs.filter((job) => job.state === "active").length,
            retrying: jobs.filter((job) => job.state === "retry").length,
            failed: deadLetters.filter((job) => job.state !== "completed" && job.state !== "cancelled").length,
            oldestQueuedAt: oldest?.toISOString() ?? null,
        };
    }

    redrive(): Promise<number> {
        return this.#boss.redrive(RAG_DEAD_LETTER_QUEUE, { sourceName: RAG_INDEX_QUEUE });
    }

    async close(): Promise<void> {
        if (!this.#started) return;
        await this.#boss.stop({ graceful: true, timeout: this.#shutdownGraceMs });
        this.#started = false;
    }

    #queuePolicy(): Record<string, unknown> {
        return {
            retryLimit: this.#retryLimit,
            retryDelay: this.#retryDelaySeconds,
            retryBackoff: true,
            retryDelayMax: this.#retryDelayMaxSeconds,
            heartbeatSeconds: this.#heartbeatSeconds,
            deadLetter: RAG_DEAD_LETTER_QUEUE,
        };
    }
}

function validateJob(job: RagIndexJob): void {
    if (!job || typeof job.vaultId !== "string" || job.vaultId.length === 0) throw new Error("Invalid RAG job vault");
    if (typeof job.path !== "string" || job.path.length === 0) throw new Error("Invalid RAG job path");
    if (job.observedMtime !== undefined && !Number.isFinite(job.observedMtime)) throw new Error("Invalid RAG job mtime");
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
}

function nonNegativeInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
}
