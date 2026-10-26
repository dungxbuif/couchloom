import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import diagnosticCases from "../eval/retrieval-cases.json";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

type EvalCase = { id: string; vaultId: string; query: string; expected: string[] };

export function parseCases(value: unknown): EvalCase[] {
    if (!Array.isArray(value) || !value.length) throw new Error("Evaluation cases must be a non-empty array");
    const ids = new Set<string>();
    return value.map((item, index) => {
        if (!item || typeof item !== "object") throw new Error(`Invalid case at index ${index}`);
        const expected = typeof item.expected === "string" ? [item.expected] : item.expected;
        const vaultId = item.vaultId ?? "personal";
        if (typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)
            || typeof item.query !== "string" || !item.query.trim()
            || typeof vaultId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(vaultId)
            || !Array.isArray(expected) || !expected.every(path => typeof path === "string" && path.trim())) {
            throw new Error(`Invalid or duplicate case at index ${index}`);
        }
        ids.add(item.id);
        return { id: item.id, query: item.query, vaultId, expected };
    });
}

export function scoreRetrieval(item: EvalCase, paths: string[]) {
    const index = paths.slice(0, 5).findIndex(path => item.expected.includes(path));
    return { answerable: item.expected.length > 0, rank: index < 0 ? null : index + 1 };
}

export function summarize(rows: Array<{ answerable: boolean; rank: number | null; latencyMs: number }>) {
    const answerable = rows.filter(row => row.answerable);
    const latency = rows.map(row => row.latencyMs).sort((a, b) => a - b);
    return {
        cases: rows.length,
        answerableCases: answerable.length,
        unsupportedCasesRequiringAnswerReview: rows.length - answerable.length,
        hitAt5: answerable.length ? answerable.filter(row => row.rank !== null).length / answerable.length : null,
        mrrAt5: answerable.length ? answerable.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / answerable.length : null,
        p50Ms: latency[Math.ceil(latency.length * .5) - 1],
        p95Ms: latency[Math.ceil(latency.length * .95) - 1],
    };
}

async function main() {
    const customFile = process.env.EVAL_CASES_FILE;
    const cases = parseCases(customFile ? JSON.parse(readFileSync(customFile, "utf8")) : diagnosticCases);

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
            const result = await client.callTool({ name: "search_notes", arguments: { vault_id: item.vaultId, query: item.query, limit: 5, ...(folder ? { folder } : {}) } });
            if (result.isError) throw new Error(`MCP tool failed for ${item.id}`);
            const text = (result.content as Array<{type: string; text?: string}>).filter(c => c.type === "text").map(c => c.text).join("\n");
            const paths = [...text.matchAll(/^- score=[^\n]*?\[([^\]]+)\]\(obsidian:/gm)].map(m => m[1]);
            if (!paths.length && text.trim() !== `No semantic matches found in vault: ${item.vaultId}`) {
                throw new Error(`Invalid search response for ${item.id}`);
            }
            if (folder && paths.some(p => !p.startsWith(`${folder.replace(/\/$/, "")}/`))) throw new Error(`Folder scope violated for ${item.id}`);
            results.push({ id: item.id, vaultId: item.vaultId, ...scoreRetrieval(item, paths), paths, latencyMs: Math.round(performance.now() - started) });
        }
        console.log(JSON.stringify({
            measuredAt: new Date().toISOString(),
            dataset: customFile ? "external-cases-review-status-not-certified" : "retrieval-cases-v1-diagnostic-not-held-out",
            datasetSha256: createHash("sha256").update(JSON.stringify(cases)).digest("hex"),
            folder: folder ?? null,
            ...summarize(results),
            byVault: Object.fromEntries([...new Set(results.map(row => row.vaultId))].map(id => [id, summarize(results.filter(row => row.vaultId === id))])),
            allUnique: results.every(r => new Set(r.paths).size === r.paths.length),
            results,
        }, null, 2));
    } finally {
        await client.close();
    }
}

if (import.meta.main) await main();
