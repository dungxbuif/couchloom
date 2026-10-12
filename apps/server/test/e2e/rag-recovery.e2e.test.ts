import { expect, test } from "bun:test";
import { Vault } from "@couchloom/core";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import postgres, { type Sql } from "postgres";

const execFileAsync = promisify(execFile);
const authToken = "recovery-e2e-token";
const vaultId = "recovery";

test("durable RAG recovers across dependency and worker failures", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const postgresContainer = `couchloom-rag-pg-${suffix}`;
    const postgresVolume = `couchloom-rag-pg-${suffix}`;
    const couchdbContainer = `couchloom-rag-couchdb-${suffix}`;
    const root = await mkdtemp(join(tmpdir(), "couchloom-rag-recovery-"));
    const dataDir = join(root, "data");
    const postgresPort = await freePort();
    const couchdbPort = await freePort();
    let sql: Sql | null = null;
    let writer: Vault | null = null;
    let app: ReturnType<typeof createAppHarness> | null = null;
    const embeddings = createEmbeddingHarness();

    try {
        await docker(
            "run", "-d", "--name", postgresContainer,
            "-e", "POSTGRES_USER=test",
            "-e", "POSTGRES_PASSWORD=test",
            "-e", "POSTGRES_DB=test",
            "-v", `${postgresVolume}:/var/lib/postgresql/data`,
            "-p", `127.0.0.1:${postgresPort}:5432`,
            "pgvector/pgvector:0.8.6-pg17-bookworm",
        );
        await docker(
            "run", "-d", "--name", couchdbContainer,
            "-e", "COUCHDB_USER=admin",
            "-e", "COUCHDB_PASSWORD=test",
            "-p", `127.0.0.1:${couchdbPort}:5984`,
            "couchdb:3.4.3",
        );

        const databaseUrl = `postgres://test:test@127.0.0.1:${postgresPort}/test`;
        const couchdbUrl = `http://127.0.0.1:${couchdbPort}`;

        await waitFor(async () => {
            try {
                await docker("exec", postgresContainer, "pg_isready", "-U", "test", "-d", "test");
                return true;
            } catch {
                return false;
            }
        }, 30_000, "PostgreSQL readiness");
        await waitFor(async () => {
            try {
                return (await fetch(`${couchdbUrl}/_up`, {
                    headers: { authorization: basicAuth("admin", "test") },
                })).ok;
            } catch {
                return false;
            }
        }, 30_000, "CouchDB readiness");

        const createDb = await fetch(`${couchdbUrl}/recoveryvault`, {
            method: "PUT",
            headers: { authorization: basicAuth("admin", "test") },
        });
        expect([201, 202, 412]).toContain(createDb.status);

        writer = new Vault({
            couchdbUrl,
            couchdbUser: "admin",
            couchdbPassword: "test",
            database: "recoveryvault",
        });
        await writer.init();
        expect(await writer.writeNote("seed.md", "# Seed\ninitial recovery fixture")).toBe(true);

        sql = postgres(databaseUrl, { max: 2, idle_timeout: 5 });
        app = createAppHarness({
            dataDir,
            databaseUrl,
            couchdbUrl,
            embeddingBaseUrl: embeddings.baseUrl,
        });
        await app.start();
        await waitForReady(app, { expected: 1, indexed: 1 });

        // Duplicate CouchDB revisions with unchanged content must stay idempotent.
        expect(await writer.writeNote("duplicate.md", "# Duplicate\nsame content")).toBe(true);
        expect(await writer.writeNote("duplicate.md", "# Duplicate\nsame content")).toBe(true);
        await waitForDocument(sql, "duplicate.md", true);
        await waitFor(async () => (await chunkCount(sql!, "duplicate.md")) === 1, 15_000, "deduplicated chunk");

        // A CouchDB delete must evict metadata and cascade vector chunks.
        expect(await writer.deleteNote("duplicate.md")).toBe(true);
        await waitForDocument(sql, "duplicate.md", false);
        await waitFor(async () => !(await app!.callTool("list_notes")).includes("duplicate.md"), 15_000, "metadata delete");

        // Ollama outage: metadata stays readable while the durable job retries.
        embeddings.mode = "unavailable";
        expect(await writer.writeNote("outage.md", "# Outage\nmetadata survives")).toBe(true);
        await waitFor(async () => {
            const readiness = await app!.readiness();
            return readiness.rag.backlog > 0 && ["backfilling", "degraded"].includes(readiness.rag.state);
        }, 15_000, "RAG retry backlog");
        expect(await app.callTool("read_note", { path: "outage.md" })).toContain("metadata survives");
        embeddings.mode = "available";
        await waitForDocument(sql, "outage.md", true);
        await waitForReady(app, { expected: 2, indexed: 2 });

        // PostgreSQL restart preserves already queued work.
        embeddings.mode = "unavailable";
        expect(await writer.writeNote("postgres-restart.md", "# PostgreSQL restart")).toBe(true);
        await waitFor(async () => (await app!.readiness()).rag.backlog > 0, 15_000, "queued work before PostgreSQL stop");
        await docker("stop", "--time", "2", postgresContainer);
        await docker("start", postgresContainer);
        await waitFor(async () => {
            try {
                await docker("exec", postgresContainer, "pg_isready", "-U", "test", "-d", "test");
                return true;
            } catch {
                return false;
            }
        }, 30_000, "PostgreSQL restart");
        await app.stop("SIGTERM");
        await sql.end({ timeout: 2 }).catch(() => undefined);
        sql = postgres(databaseUrl, { max: 2, idle_timeout: 5 });
        await waitFor(async () => {
            try {
                const rows = await sql!<Array<{ ok: number }>>`SELECT 1::int AS ok`;
                return rows[0]?.ok === 1;
            } catch {
                return false;
            }
        }, 30_000, "PostgreSQL client reconnect before CouchLoom restart");
        await app.start();
        embeddings.mode = "available";
        try {
            await waitForDocument(sql, "postgres-restart.md", true, 45_000);
        } catch {
            throw new Error(`PostgreSQL recovery did not drain queued work. Logs:\n${app.logs}`);
        }

        // Hard-crash an active worker. The bounded claim expiry and supervisor
        // must reclaim it after the process restarts.
        embeddings.blockNextRequest();
        expect(await writer.writeNote("active-restart.md", "# Active restart")).toBe(true);
        await embeddings.waitUntilBlocked();
        await waitFor(async () => (await activeJobCount(sql!, "active-restart.md")) === 1, 15_000, "active job claim");
        await app.stop("SIGKILL");
        embeddings.releaseBlockedRequest();
        embeddings.mode = "available";
        await app.start();
        await waitForDocument(sql, "active-restart.md", true, 15_000);

        const finalStatus = await waitForReady(app, { expected: 4, indexed: 4 }, 60_000);
        expect(finalStatus.rag).toMatchObject({
            state: "ready",
            expected: 4,
            indexed: 4,
            backlog: 0,
            failed: 0,
            coverage: 1,
        });
    } finally {
        await app?.stop("SIGTERM").catch(() => undefined);
        await writer?.close().catch(() => undefined);
        await sql?.end({ timeout: 2 }).catch(() => undefined);
        embeddings.stop();
        await docker("rm", "-f", postgresContainer).catch(() => undefined);
        await docker("rm", "-f", couchdbContainer).catch(() => undefined);
        await docker("volume", "rm", postgresVolume).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
    }
}, 180_000);

function createEmbeddingHarness() {
    let mode: "available" | "unavailable" | "blocked" = "available";
    let blockedStarted = deferred<void>();
    let blockedRelease = deferred<void>();
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            if (mode === "unavailable") return new Response("unavailable", { status: 503 });
            if (mode === "blocked") {
                blockedStarted.resolve();
                await blockedRelease.promise;
            }
            const payload = await request.json() as { input?: string[] | string };
            const input = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];
            return Response.json({
                data: input.map((_text, index) => ({ index, embedding: [1, 0.5, 0.25] })),
            });
        },
    });
    return {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        get mode() {
            return mode;
        },
        set mode(value: "available" | "unavailable" | "blocked") {
            mode = value;
        },
        blockNextRequest() {
            blockedStarted = deferred<void>();
            blockedRelease = deferred<void>();
            mode = "blocked";
        },
        waitUntilBlocked() {
            return withTimeout(blockedStarted.promise, 15_000, "embedding request did not become active");
        },
        releaseBlockedRequest() {
            blockedRelease.resolve();
        },
        stop() {
            blockedRelease.resolve();
            server.stop(true);
        },
    };
}

function createAppHarness(options: {
    dataDir: string;
    databaseUrl: string;
    couchdbUrl: string;
    embeddingBaseUrl: string;
}) {
    let processHandle: ChildProcess | null = null;
    let port = 0;
    let sessionId = "";
    let logs = "";

    return {
        get logs() {
            return logs;
        },
        async start() {
            port = await freePort();
            sessionId = "";
            processHandle = spawn(process.execPath, ["apps/server/dist/main.js"], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PORT: String(port),
                    HOST: "127.0.0.1",
                    BASE_URL: `http://127.0.0.1:${port}`,
                    MCP_AUTH_TOKEN: authToken,
                    DATA_DIR: options.dataDir,
                    VAULTS_CONFIG: JSON.stringify([{
                        id: vaultId,
                        name: "Recovery",
                        mode: "couchdb",
                        url: options.couchdbUrl,
                        user: "admin",
                        password: "test",
                        database: "recoveryvault",
                    }]),
                    DATABASE_URL: options.databaseUrl,
                    EMBEDDING_BASE_URL: options.embeddingBaseUrl,
                    EMBEDDING_API_KEY: "local-test",
                    EMBEDDING_MODEL: "recovery-test",
                    EMBEDDING_DIMENSIONS: "3",
                    RAG_CHUNK_CHARS: "4096",
                    RAG_CHUNK_OVERLAP: "0",
                    RAG_RETRY_LIMIT: "20",
                    RAG_RETRY_DELAY_SECONDS: "1",
                    RAG_RETRY_DELAY_MAX_SECONDS: "1",
                    RAG_JOB_HEARTBEAT_SECONDS: "10",
                    RAG_JOB_EXPIRE_SECONDS: "2",
                    RAG_QUEUE_SUPERVISE_INTERVAL_SECONDS: "1",
                    RAG_DATABASE_CONNECT_TIMEOUT_MS: "1000",
                    RAG_RECONCILE_INTERVAL_MS: "1000",
                    RAG_WORKER_CONCURRENCY: "1",
                    RAG_SHUTDOWN_GRACE_MS: "2000",
                },
                stdio: "pipe",
            });
            processHandle.stdout?.on("data", (chunk) => { logs += chunk.toString(); });
            processHandle.stderr?.on("data", (chunk) => { logs += chunk.toString(); });
            try {
                await waitFor(async () => {
                    try {
                        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
                    } catch {
                        return false;
                    }
                }, 20_000, "CouchLoom startup");
            } catch {
                throw new Error(`CouchLoom did not start. Logs:\n${logs}`);
            }
            const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
                method: "POST",
                headers: rpcHeaders(),
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 0,
                    method: "initialize",
                    params: {
                        protocolVersion: "2024-11-05",
                        capabilities: {},
                        clientInfo: { name: "rag-recovery-e2e", version: "1" },
                    },
                }),
            });
            if (!response.ok) throw new Error(`MCP initialize failed: ${response.status} ${await response.text()}`);
            sessionId = response.headers.get("mcp-session-id") ?? "";
            await response.text();
        },
        async stop(signal: "SIGTERM" | "SIGKILL") {
            if (!processHandle) return;
            const handle = processHandle;
            processHandle = null;
            const exited = new Promise<void>((resolve) => handle.once("exit", () => resolve()));
            handle.kill(signal);
            await withTimeout(exited, 10_000, `CouchLoom did not stop: ${logs}`);
        },
        async readiness(): Promise<any> {
            const response = await fetch(`http://127.0.0.1:${port}/ready`);
            if (!response.ok) throw new Error(`readiness failed: ${response.status}`);
            return response.json();
        },
        async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
            const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
                method: "POST",
                headers: rpcHeaders(),
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name, arguments: { vault_id: vaultId, ...args } },
                }),
            });
            const payload = parseSse(await response.text());
            const text = payload?.result?.content?.[0]?.text;
            if (typeof text !== "string") throw new Error(`tool ${name} failed: ${JSON.stringify(payload)}`);
            return text;
        },
    };

    function rpcHeaders(): Record<string, string> {
        return {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${authToken}`,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        };
    }
}

async function waitForReady(
    app: ReturnType<typeof createAppHarness>,
    counts: { expected: number; indexed: number },
    timeout = 30_000,
): Promise<any> {
    let result: any;
    try {
        await waitFor(async () => {
            try {
                const text = await app.callTool("get_index_status");
                result = JSON.parse(text);
                return result.rag.state === "ready"
                    && result.rag.expected === counts.expected
                    && result.rag.indexed === counts.indexed
                    && result.rag.backlog === 0
                    && result.rag.failed === 0;
            } catch {
                return false;
            }
        }, timeout, `RAG ready ${counts.expected}/${counts.indexed}`);
    } catch {
        throw new Error(`RAG did not become ready: ${JSON.stringify(result)}`);
    }
    return result;
}

async function waitForDocument(sql: Sql, path: string, present: boolean, timeout = 20_000): Promise<void> {
    await waitFor(async () => {
        try {
            const rows = await sql<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM rag_documents
                WHERE vault_id = ${vaultId} AND path = ${path}`;
            return (rows[0]?.count === 1) === present;
        } catch {
            return false;
        }
    }, timeout, `${present ? "index" : "delete"} ${path}`);
}

async function chunkCount(sql: Sql, path: string): Promise<number> {
    const rows = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM rag_chunks
        WHERE vault_id = ${vaultId} AND path = ${path}`;
    return rows[0]?.count ?? 0;
}

async function activeJobCount(sql: Sql, path: string): Promise<number> {
    const rows = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pgboss.job
        WHERE name = 'rag-index' AND state = 'active' AND data->>'path' = ${path}`;
    return rows[0]?.count ?? 0;
}

async function docker(...args: string[]): Promise<string> {
    const result = await execFileAsync("docker", args, { timeout: 60_000 });
    return result.stdout.trim();
}

async function freePort(): Promise<number> {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    return port;
}

async function waitFor(check: () => Promise<boolean>, timeout: number, label: string): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
    return Promise.race([
        promise,
        Bun.sleep(timeout).then(() => { throw new Error(message); }),
    ]);
}

function parseSse(raw: string): any {
    const data = raw.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : raw);
}

function basicAuth(user: string, password: string): string {
    return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
