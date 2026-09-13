import { describe, expect, test } from "bun:test";
import { SearchIndex } from "./search.js";
import { VaultRegistry } from "./vault-registry.js";
import type { VaultBackend } from "./vault-backend.js";

function backend(events: string[], id: string, closeError = false): VaultBackend {
    return {
        async init() { events.push(`init:${id}`); },
        async close() { events.push(`close:${id}`); if (closeError) throw new Error(id); },
    } as VaultBackend;
}

describe("VaultRegistry", () => {
    test("resolves stable contexts and lists no secrets", async () => {
        const events: string[] = [];
        const registry = new VaultRegistry([
            { id: "personal", name: "Personal", backend: backend(events, "personal"), searchIndex: new SearchIndex() },
            { id: "work", name: "Work", backend: backend(events, "work"), searchIndex: new SearchIndex() },
        ]);
        await registry.initAll();
        expect(registry.get("work").name).toBe("Work");
        expect(registry.list()).toEqual([{ id: "personal", name: "Personal" }, { id: "work", name: "Work" }]);
        expect(events).toEqual(["init:personal", "init:work"]);
    });

    test("rejects unknown vault IDs", () => {
        const registry = new VaultRegistry([]);
        expect(() => registry.get("missing")).toThrow("Unknown vault_id: missing");
    });

    test("attempts to close every vault", async () => {
        const events: string[] = [];
        const registry = new VaultRegistry([
            { id: "one", name: "One", backend: backend(events, "one", true), searchIndex: new SearchIndex() },
            { id: "two", name: "Two", backend: backend(events, "two"), searchIndex: new SearchIndex() },
        ]);
        await expect(registry.closeAll()).rejects.toThrow();
        expect(events).toEqual(["close:one", "close:two"]);
    });
});
