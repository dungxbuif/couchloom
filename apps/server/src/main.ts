import { FastMCP } from "fastmcp";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEVEL_INFO, setGlobalLogFunction } from "octagonal-wheels/common/logger";
import { parseWriteFolders, registerTools, VaultRegistry } from "@couchloom/core";
import { mountPasswordAuth, type AuthHandle } from "./auth.js";
import { buildAllowedHosts, isHostAllowed, isOriginAllowed } from "./host-guard.js";
import { loadVaultConfigs } from "./vault-config.js";
import { RagRuntime } from "./rag-runtime.js";
import { VaultRuntime } from "./vault-runtime.js";

const debugLogging = process.env.LOG_LEVEL === "debug";
setGlobalLogFunction((message, level = LEVEL_INFO) => {
    if (level < LEVEL_INFO) return;
    if (!debugLogging && typeof message === "string") {
        if (/^(GET|PUT|DELETE|WATCH|FOLLOW|Sensible merge|Object merge):/.test(message)) return;
        if (/replicator/i.test(message)) return;
    }
    console.log(message);
});

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
const authToken = process.env.MCP_AUTH_TOKEN;
const readOnly = process.env.READ_ONLY === "true";
const writeFolders = parseWriteFolders(process.env.WRITE_FOLDERS);
const baseDataDir = process.env.DATA_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".couchloom");

function loadExtraInstructions(): string | undefined {
    const file = process.env.MCP_INSTRUCTIONS_FILE?.trim();
    const inline = process.env.MCP_INSTRUCTIONS?.trim();
    if (!file) return inline || undefined;
    try {
        const size = statSync(file).size;
        if (size > 32 * 1024) throw new Error(`file is ${size} bytes, exceeds 32768 byte cap`);
        if (inline) console.warn("MCP_INSTRUCTIONS_FILE is set; ignoring MCP_INSTRUCTIONS env var.");
        return readFileSync(file, "utf8").trim() || undefined;
    } catch (error) {
        console.error(`Failed to read MCP_INSTRUCTIONS_FILE (${file}): ${(error as Error).message}`);
        process.exit(1);
    }
}

let configs;
let rag: RagRuntime | null = null;
try {
    configs = loadVaultConfigs();
    rag = RagRuntime.fromEnvironment();
    await rag?.start();
} catch (error) {
    console.error(`Invalid service configuration: ${(error as Error).message}`);
    process.exit(1);
}

const runtimes = configs.map((config) => new VaultRuntime(
    config,
    baseDataDir,
    debugLogging,
    rag ? (path, content, mtime) => rag!.apply(config.id, path, content, mtime).then(() => undefined) : undefined,
));
try {
    await Promise.all(runtimes.map((runtime) => runtime.start()));
} catch (error) {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    console.error(`Vault startup failed: ${(error as Error).message}`);
    process.exit(1);
}
const registry = new VaultRegistry(runtimes.map(({ context }) => ({
    ...context,
    onDocumentChange: rag ? (path: string, content: string | null, mtime?: number) => rag!.apply(context.id, path, content, mtime).then(() => undefined) : undefined,
    semanticSearch: rag ? async (query: string, limit?: number) => (await rag!.search(query, [context.id], limit)).map(({ path, chunkIndex, content, score }) => ({ path, chunkIndex, content, score })) : undefined,
    ragStatus: () => ({ enabled: !!rag, ...(rag ? { model: rag.model } : {}) }),
})));
console.log(`CouchLoom loaded ${registry.list().length} vault(s): ${registry.list().map(({ id }) => id).join(", ")}`);

const baseInstructions = "Access multiple Obsidian vaults. Call list_vaults first, then pass vault_id to every note tool. You can read, list, search, create, and edit markdown notes. Deleting, moving, or renaming notes is not available. Always show returned Obsidian deep links to the user.";
const extraInstructions = loadExtraInstructions();
const serverOptions: ConstructorParameters<typeof FastMCP>[0] = {
    name: "couchloom",
    version: process.env.npm_package_version ?? "0.0.0",
    instructions: extraInstructions ? `${baseInstructions}\n\n${extraInstructions}` : baseInstructions,
};

let auth: AuthHandle | null = null;
if (authToken) {
    serverOptions.authenticate = async (request: import("http").IncomingMessage) => {
        const header = request.headers.authorization;
        const expected = `Bearer ${authToken}`;
        if (header && header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected))) return { authenticated: true };
        if (auth?.validateToken(header)) return { authenticated: true };
        throw new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"` },
        });
    };
    console.log("Auth enabled (password-gated OAuth). ");
} else {
    const allowedHosts = buildAllowedHosts(process.env.MCP_ALLOWED_HOSTS);
    serverOptions.authenticate = async (request: import("http").IncomingMessage) => {
        if (!isHostAllowed(request.headers.host, allowedHosts)) throw new Response("Forbidden: Host not allowed", { status: 403 });
        if (!isOriginAllowed(request.headers.origin, allowedHosts)) throw new Response("Forbidden: cross-origin request rejected", { status: 403 });
        return { authenticated: true };
    };
    console.log(`Auth disabled — allowed Host/Origin values: ${[...allowedHosts].join(", ")}.`);
    if ((process.env.HOST ?? "0.0.0.0") === "0.0.0.0") console.warn("WARNING: no authentication while listening on all interfaces; set MCP_AUTH_TOKEN for remote access.");
}

const server = new FastMCP(serverOptions);
server.getApp().get("/health", (context) => context.json({ status: "ok" }));
server.getApp().get("/ready", (context) => context.json({ status: "ready", vaults: registry.list().length, rag: !!rag }));
if (authToken) {
    auth = mountPasswordAuth(server.getApp(), baseUrl, authToken, join(baseDataDir, "server", "auth-tokens.json"));
    await auth.loadTokens();
}
registerTools(server, registry, readOnly, writeFolders);

let shuttingDown = false;
async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    const results = await Promise.allSettled([
        ...runtimes.map((runtime) => runtime.close()),
        ...(rag ? [rag.close()] : []),
        ...(auth ? [auth.saveTokens()] : []),
    ]);
    const failed = results.filter(({ status }) => status === "rejected");
    if (failed.length) console.error(`Shutdown completed with ${failed.length} error(s).`);
    process.exit(failed.length ? 1 : 0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

setInterval(async () => {
    await Promise.allSettled(runtimes.map((runtime) => runtime.save()));
    if (auth) {
        auth.cleanup();
        await auth.saveTokens();
    }
}, 5 * 60 * 1000).unref();

server.start({
    transportType: "httpStream",
    httpStream: { port, endpoint: "/mcp", host: process.env.HOST ?? "0.0.0.0" },
});
console.log(`CouchLoom v${process.env.npm_package_version ?? "unknown"} listening on port ${port}`);

process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
