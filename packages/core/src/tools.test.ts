import { describe, expect, test } from "bun:test";
import type { FastMCP } from "fastmcp";
import { SearchIndex } from "./search.js";
import { registerTools } from "./tools.js";
import type { VaultBackend } from "./vault-backend.js";
import { VaultRegistry } from "./vault-registry.js";

function registeredTools(readOnly = false): Array<{ name: string; parameters: { parse(value: unknown): unknown }; execute: (args: any) => Promise<unknown> }> {
    const tools: Array<any> = [];
    const server = {
        addTool(tool: any) {
            tools.push(tool);
        },
    } as unknown as FastMCP;
    const backend = { readNote: async () => "hello" } as VaultBackend;
    const registry = new VaultRegistry([
        { id: "personal", name: "Personal", backend, searchIndex: new SearchIndex() },
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
});
