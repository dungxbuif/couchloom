import { expect, test } from "bun:test";
import { checkRequiredVaults } from "./audit-vault-coverage";

const listed = (text: string) => ({ content: [{ type: "text", text }] });

test("missing Homelab fails even if personal is available", () => {
    expect(() => checkRequiredVaults(["personal"], listed("- personal: Personal")))
        .toThrow("Missing required vaults: config=homelab; MCP=homelab");
});

test("both configured and exposed vaults pass", () => {
    expect(() => checkRequiredVaults(["personal", "homelab"], listed("- personal: Personal\n- homelab: Homelab")))
        .not.toThrow();
});

test("configuration alone cannot satisfy MCP availability", () => {
    expect(() => checkRequiredVaults(["personal", "homelab"], listed("- personal: Personal")))
        .toThrow("MCP=homelab");
});

test("tool failure and malformed results cannot pass", () => {
    expect(() => checkRequiredVaults(["personal", "homelab"], { isError: true }))
        .toThrow("list_vaults failed");
    expect(() => checkRequiredVaults(["personal", "homelab"], {}))
        .toThrow("list_vaults returned no text");
});
