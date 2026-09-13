import { describe, expect, test } from "bun:test";
import { loadVaultConfigs } from "./vault-config.js";

describe("multi-vault configuration", () => {
    test("loads multiple CouchDB databases from inline JSON", () => {
        const vaults = loadVaultConfigs({
            VAULTS_CONFIG: JSON.stringify([
                { id: "personal", name: "Personal", mode: "couchdb", url: "http://db:5984", database: "personal", user: "admin", password: "secret" },
                { id: "work", name: "Work", mode: "couchdb", url: "http://db:5984", database: "work", user: "admin", password: "secret" },
            ]),
        });
        expect(vaults.map((vault) => vault.id)).toEqual(["personal", "work"]);
    });

    test("rejects duplicate vault IDs", () => {
        const config = JSON.stringify([
            { id: "same", name: "One", mode: "local", path: "/vault/one" },
            { id: "same", name: "Two", mode: "local", path: "/vault/two" },
        ]);
        expect(() => loadVaultConfigs({ VAULTS_CONFIG: config })).toThrow("Duplicate vault id: same");
    });

    test("rejects relative local paths", () => {
        const config = JSON.stringify([{ id: "notes", name: "Notes", mode: "local", path: "./notes" }]);
        expect(() => loadVaultConfigs({ VAULTS_CONFIG: config })).toThrow("absolute");
    });

    test("supports the legacy single CouchDB environment", () => {
        const [vault] = loadVaultConfigs({
            VAULT_NAME: "My Vault",
            COUCHDB_URL: "http://db:5984",
            COUCHDB_DATABASE: "obsidian",
            COUCHDB_USER: "admin",
            COUCHDB_PASSWORD: "secret",
        });
        expect(vault).toMatchObject({ id: "my-vault", name: "My Vault", mode: "couchdb", database: "obsidian" });
    });

    test("rejects simultaneous inline and file sources", () => {
        expect(() => loadVaultConfigs({ VAULTS_CONFIG: "[]", VAULTS_CONFIG_FILE: "/config/vaults.json" })).toThrow("only one");
    });
});
