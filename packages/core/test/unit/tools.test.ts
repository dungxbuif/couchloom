import { describe, expect, test } from "bun:test";
import type { FastMCP } from "fastmcp";
import { SearchIndex } from "../../src/search.js";
import { registerTools } from "../../src/tools.js";
import type { VaultBackend } from "../../src/vault-backend.js";
import { VaultRegistry } from "../../src/vault-registry.js";

function registeredTools(
    readOnly = false,
    ragStatus?: () => unknown | Promise<unknown>,
): Array<{ name: string; parameters: { parse(value: unknown): unknown }; execute: (args: any) => Promise<unknown> }> {
    const tools: Array<any> = [];
    const server = {
        addTool(tool: any) {
            tools.push(tool);
        },
    } as unknown as FastMCP;
    const backend = { readNote: async () => "hello" } as VaultBackend;
    const registry = new VaultRegistry([
        { id: "personal", name: "Personal", backend, searchIndex: new SearchIndex(), ragStatus: ragStatus as never },
        { id: "work", name: "Work", backend, searchIndex: new SearchIndex() },
    ]);

    registerTools(server, registry, readOnly);
    return tools;
}

describe("safe MCP tool catalog", () => {
    test("allows reads, creation, and edits without destructive tools", () => {
        const names = registeredTools().map(({ name }) => name);
        expect(names).toContain("list_vaults");
        expect(names).toContain("read_note");
        expect(names).toContain("write_note");
        expect(names).toContain("edit_note");
        expect(names).toContain("search_notes");
        expect(names).toContain("get_index_status");
        expect(names).not.toContain("delete_note");
        expect(names).not.toContain("move_note");
    });

    test("read-only mode removes every write tool", () => {
        const names = registeredTools(true).map(({ name }) => name);
        expect(names).not.toContain("write_note");
        expect(names).not.toContain("edit_note");
        expect(names).not.toContain("delete_note");
        expect(names).not.toContain("move_note");
    });

    test("note tools require a valid vault_id", () => {
        const readNote = registeredTools().find(({ name }) => name === "read_note")!;
        expect(() => readNote.parameters.parse({ path: "note.md" })).toThrow();
        expect(readNote.parameters.parse({ vault_id: "work", path: "note.md" })).toMatchObject({ vault_id: "work" });
    });

    test("list_vaults returns safe registry summaries", async () => {
        const listVaults = registeredTools().find(({ name }) => name === "list_vaults")!;
        expect(await listVaults.execute({})).toContain("personal");
        expect(await listVaults.execute({})).toContain("work");
    });

    test("semantic search reports disabled without a RAG capability", async () => {
        const search = registeredTools().find(({ name }) => name === "search_notes")!;
        expect(await search.execute({ vault_id: "personal", query: "hello" })).toContain("disabled");
    });

    test("get_index_status returns stable disabled, ready, backfilling, and degraded states", async () => {
        const states = [
            {
                enabled: true,
                state: "ready",
                model: "nomic-embed-text",
                expected: 2,
                indexed: 2,
                backlog: 0,
                failed: 0,
                coverage: 1,
                oldestJobAgeSeconds: null,
                lastSuccessAt: "2026-10-13T00:00:00.000Z",
                lastError: null,
                lastReconciliationAt: "2026-10-13T00:00:00.000Z",
                checkpoint: "42",
            },
            {
                enabled: true,
                state: "backfilling",
                model: "nomic-embed-text",
                expected: 2,
                indexed: 1,
                backlog: 1,
                failed: 0,
                coverage: 0.5,
                oldestJobAgeSeconds: 3,
                lastSuccessAt: null,
                lastError: null,
                lastReconciliationAt: null,
                checkpoint: "41",
            },
            {
                enabled: true,
                state: "degraded",
                model: "nomic-embed-text",
                expected: 2,
                indexed: 1,
                backlog: 0,
                failed: 1,
                coverage: 0.5,
                oldestJobAgeSeconds: null,
                lastSuccessAt: null,
                lastError: "RAG indexing failed (Error)",
                lastReconciliationAt: null,
                checkpoint: "41",
            },
        ] as const;

        const disabledTool = registeredTools().find(({ name }) => name === "get_index_status")!;
        const disabled = JSON.parse(String(await disabledTool.execute({ vault_id: "personal" })));
        expect(disabled.rag).toMatchObject({ enabled: false, state: "disabled", coverage: 1 });

        for (const status of states) {
            const tool = registeredTools(false, () => status).find(({ name }) => name === "get_index_status")!;
            const output = JSON.parse(String(await tool.execute({ vault_id: "personal" })));
            expect(output.rag).toEqual(status);
        }
    });
});
