import { describe, expect, test } from "bun:test";
import type { FastMCP } from "fastmcp";
import { SearchIndex } from "./search.js";
import { registerTools } from "./tools.js";
import type { VaultBackend } from "./vault-backend.js";

function registeredToolNames(readOnly = false): string[] {
    const names: string[] = [];
    const server = {
        addTool(tool: { name: string }) {
            names.push(tool.name);
        },
    } as unknown as FastMCP;

    registerTools(server, {} as VaultBackend, new SearchIndex(), "TestVault", readOnly);
    return names;
}

describe("safe MCP tool catalog", () => {
    test("allows reads, creation, and edits without destructive tools", () => {
        const names = registeredToolNames();
        expect(names).toContain("read_note");
        expect(names).toContain("write_note");
        expect(names).toContain("edit_note");
        expect(names).not.toContain("delete_note");
        expect(names).not.toContain("move_note");
    });

    test("read-only mode removes every write tool", () => {
        const names = registeredToolNames(true);
        expect(names).not.toContain("write_note");
        expect(names).not.toContain("edit_note");
        expect(names).not.toContain("delete_note");
        expect(names).not.toContain("move_note");
    });
});
