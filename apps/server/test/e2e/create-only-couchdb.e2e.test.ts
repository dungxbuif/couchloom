/** Isolated real CouchDB proof. Uses only a random test database on loopback. */
import {describe, test, expect} from "bun:test";
import {randomUUID} from "node:crypto";
import {Vault} from "@couchloom/core";

const endpoint = process.env.CREATE_ONLY_TEST_COUCHDB_URL;
const enabled = process.env.RUN_CREATE_ONLY_COUCHDB_E2E === "1";
const suite = enabled ? describe : describe.skip;
const user = "hub-test";
const password = "synthetic-test-only";

suite("create-only against isolated CouchDB", () => {
    async function withVaults(obfuscatePaths: boolean, run: (vaults: Vault[]) => Promise<void>) {
        if (!endpoint || new URL(endpoint).hostname !== "127.0.0.1") {
            throw new Error("Explicit loopback-only CREATE_ONLY_TEST_COUCHDB_URL required");
        }
        const database = "knowledge_hub_createonly_test_" + randomUUID().replaceAll("-", "");
        const headers = {Authorization: "Basic " + Buffer.from(user + ":" + password).toString("base64")};
        const url = endpoint + "/" + database;
        const created = await fetch(url, {method: "PUT", headers});
        expect(created.status).toBe(201);
        const config = {couchdbUrl: endpoint, couchdbUser: user, couchdbPassword: password,
            database, passphrase: "synthetic-encryption-test", obfuscatePaths};
        const vaults = [new Vault(config), new Vault(config), new Vault(config)];
        try {
            await Promise.all(vaults.map(vault => vault.init()));
            await run(vaults);
        } finally {
            await Promise.allSettled(vaults.map(vault => vault.close()));
            const deleted = await fetch(url, {method: "DELETE", headers});
            expect(deleted.status).toBe(200);
        }
    }

    for (const obfuscatePaths of [false, true]) {
        test("preserves the concurrent winner and later human edit, obfuscated=" + obfuscatePaths, async () => {
            await withVaults(obfuscatePaths, async vaults => {
                const path = "raw/ghi-chu-tiếng-Việt.md";
                const results = await Promise.all(vaults.map((vault, index) => vault.createNote(path, "winner-" + index)));
                expect(results.filter(Boolean)).toHaveLength(1);
                const winner = await vaults[0].readNote(path);
                expect(["winner-0", "winner-1", "winner-2"]).toContain(winner);
                for (const vault of vaults) expect(await vault.readNote(path)).toBe(winner);
                expect(await vaults[1].writeNote(path, "human-edit")).toBe(true);
                expect(await vaults[2].createNote(path, "AI-replacement")).toBe(false);
                expect(await vaults[0].readNote(path)).toBe("human-edit");
            });
        }, 30000);
    }
});
