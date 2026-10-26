import { readFileSync } from "node:fs";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export function checkRequiredVaults(configured: string[], result: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
}): void {
    if (result.isError) throw new Error("list_vaults failed");
    const text = result.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
    if (!text) throw new Error("list_vaults returned no text");
    const exposed = new Set([...text.matchAll(/^- ([a-z0-9][a-z0-9_-]*): /gm)].map(match => match[1]));
    const required = ["personal", "homelab"];
    const missingConfig = required.filter(id => !configured.includes(id));
    const missingMcp = required.filter(id => !exposed.has(id));
    if (missingConfig.length || missingMcp.length) {
        throw new Error(`Missing required vaults: config=${missingConfig.join(",") || "none"}; MCP=${missingMcp.join(",") || "none"}`);
    }
}

async function main() {
// Only allowlisted metadata is printed; never serialize runtime credentials.
const configs = JSON.parse(readFileSync(process.env.VAULTS_CONFIG_FILE!, "utf8"));
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const client = new Client({ name: "vault-coverage-audit", version: "1" });
try {
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } },
    }));
    const vaults = await client.callTool({ name: "list_vaults", arguments: {} });
    const inventory = { isError: vaults.isError, content: vaults.content } as Parameters<typeof checkRequiredVaults>[1];
    for (const config of configs) {
        const counts = await sql`SELECT count(*) AS documents FROM rag_documents WHERE vault_id=${config.id}`;
        const chunks = await sql`SELECT count(*) AS chunks FROM rag_chunks WHERE vault_id=${config.id}`;
        console.log(JSON.stringify({ configured: { id: config.id, name: config.name, mode: config.mode, database: config.database }, ...counts[0], ...chunks[0] }));
        const folders = await sql`SELECT split_part(path, '/', 1) AS root, count(*) AS documents FROM rag_documents WHERE vault_id=${config.id} GROUP BY 1 ORDER BY 1`;
        console.log(JSON.stringify({ vault: config.id, folders }));
        if (config.mode !== "couchdb") continue;
        const url = new URL(config.url);
        const headers = { Authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
        const response = await fetch(new URL("_all_dbs", `${url.href.replace(/\/$/, "")}/`), { headers, signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
            console.log(JSON.stringify({ databaseDiscoveryStatus: response.status }));
            continue;
        }
        const names = await response.json() as string[];
        console.log(JSON.stringify({ discoveredDatabases: names.filter(name => !name.startsWith("_")) }));
    }
    checkRequiredVaults(configs.map((config: { id: string }) => config.id), inventory);
    console.log(JSON.stringify({ requiredVaults: ["personal", "homelab"], registration: "complete" }));
} finally {
    await client.close();
    await sql.end({ timeout: 1 });
}
}

if (import.meta.main) await main();
