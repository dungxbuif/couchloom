import { expect, test } from "bun:test";

test("core imports without starting an application", async () => {
    const core = await import("../../src/index");
    expect(typeof core.Vault).toBe("function");
    expect(typeof core.LocalVault).toBe("function");
    expect(typeof core.registerTools).toBe("function");
    expect(typeof core.SearchIndex).toBe("function");
});
