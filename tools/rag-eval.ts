import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import cases from "../eval/retrieval-cases.json";

const token = process.env.MCP_AUTH_TOKEN;
if (!token) throw new Error("MCP_AUTH_TOKEN is required");
const folder = process.env.EVAL_FOLDER || undefined;
const client = new Client({ name: "couchloom-eval", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
try {
    await client.connect(transport);
    const catalog = await client.listTools();
    if (!catalog.tools.some(t => t.name === "search_notes")) throw new Error("search_notes is missing");
    const results = [];
    for (const item of cases) {
        const started = performance.now();
        const result = await client.callTool({ name: "search_notes", arguments: { vault_id: "personal", query: item.query, limit: 5, ...(folder ? { folder } : {}) } });
        if (result.isError) throw new Error(`MCP tool failed for ${item.id}`);
        const text = (result.content as Array<{type: string; text?: string}>).filter(c => c.type === "text").map(c => c.text).join("\n");
        const paths = [...text.matchAll(/^- score=[^\n]*?\[([^\]]+)\]\(obsidian:/gm)].map(m => m[1]);
        if (!paths.length) throw new Error(`Missing search results for ${item.id}`);
        if (folder && paths.some(p => !p.startsWith(`${folder.replace(/\/$/, "")}/`))) throw new Error(`Folder scope violated for ${item.id}`);
        results.push({ id: item.id, rank: paths.indexOf(item.expected) + 1 || null, paths, latencyMs: Math.round(performance.now() - started) });
    }
    console.log(JSON.stringify({
        measuredAt: new Date().toISOString(),
        dataset: "retrieval-cases-v1-diagnostic-not-held-out",
        folder: folder ?? null,
        hitAt5: results.filter(r => r.rank !== null).length / results.length,
        mrrAt5: results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / results.length,
        allUnique: results.every(r => new Set(r.paths).size === r.paths.length),
        results,
    }, null, 2));
} finally {
    await client.close();
}
