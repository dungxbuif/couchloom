import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type LocalVaultConfig = {
    id: string;
    name: string;
    mode: "local";
    path: string;
};

export type CouchDbVaultConfig = {
    id: string;
    name: string;
    mode: "couchdb";
    url: string;
    database: string;
    user: string;
    password: string;
    passphrase?: string;
    obfuscatePaths?: boolean;
};

export type AppVaultConfig = LocalVaultConfig | CouchDbVaultConfig;
type Environment = Record<string, string | undefined>;

const VAULT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function legacyId(name: string): string {
    const id = name.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return id || "default";
}

function parseSource(raw: string, source: string): unknown {
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid JSON in ${source}: ${(error as Error).message}`);
    }
}

function validateVault(value: unknown, index: number): AppVaultConfig {
    if (!value || typeof value !== "object") throw new Error(`Vault at index ${index} must be an object`);
    const vault = value as Record<string, unknown>;
    const id = vault.id;
    const name = vault.name;
    if (typeof id !== "string" || !VAULT_ID.test(id)) throw new Error(`Invalid vault id at index ${index}`);
    if (typeof name !== "string" || !name.trim()) throw new Error(`Vault ${id} requires a name`);

    if (vault.mode === "local") {
        if (typeof vault.path !== "string" || !isAbsolute(vault.path)) throw new Error(`Local vault ${id} path must be absolute`);
        return { id, name, mode: "local", path: vault.path };
    }
    if (vault.mode === "couchdb") {
        for (const key of ["url", "database", "user", "password"] as const) {
            if (typeof vault[key] !== "string" || !vault[key]) throw new Error(`CouchDB vault ${id} requires ${key}`);
        }
        return {
            id,
            name,
            mode: "couchdb",
            url: vault.url as string,
            database: vault.database as string,
            user: vault.user as string,
            password: vault.password as string,
            passphrase: typeof vault.passphrase === "string" ? vault.passphrase : undefined,
            obfuscatePaths: vault.obfuscatePaths === true,
        };
    }
    throw new Error(`Vault ${id} mode must be 'local' or 'couchdb'`);
}

export function loadVaultConfigs(env: Environment = process.env): AppVaultConfig[] {
    if (env.VAULTS_CONFIG && env.VAULTS_CONFIG_FILE) {
        throw new Error("Set only one of VAULTS_CONFIG or VAULTS_CONFIG_FILE");
    }

    let values: unknown;
    if (env.VAULTS_CONFIG_FILE) {
        values = parseSource(readFileSync(env.VAULTS_CONFIG_FILE, "utf8"), "VAULTS_CONFIG_FILE");
    } else if (env.VAULTS_CONFIG) {
        values = parseSource(env.VAULTS_CONFIG, "VAULTS_CONFIG");
    } else if (env.VAULT_PATH) {
        values = [{ id: legacyId(env.VAULT_NAME ?? "default"), name: env.VAULT_NAME ?? "MyVault", mode: "local", path: env.VAULT_PATH }];
    } else if (env.COUCHDB_URL) {
        values = [{
            id: legacyId(env.VAULT_NAME ?? "default"),
            name: env.VAULT_NAME ?? "MyVault",
            mode: "couchdb",
            url: env.COUCHDB_URL,
            database: env.COUCHDB_DATABASE ?? "obsidian",
            user: env.COUCHDB_USER ?? "admin",
            password: env.COUCHDB_PASSWORD,
            passphrase: env.COUCHDB_PASSPHRASE || undefined,
            obfuscatePaths: env.COUCHDB_OBFUSCATE_PROPERTIES === "true",
        }];
    } else {
        throw new Error("Configure VAULTS_CONFIG_FILE, VAULTS_CONFIG, VAULT_PATH, or COUCHDB_URL");
    }

    if (!Array.isArray(values) || values.length === 0) throw new Error("Vault configuration must be a non-empty array");
    const configs = values.map(validateVault);
    const ids = new Set<string>();
    for (const vault of configs) {
        if (ids.has(vault.id)) throw new Error(`Duplicate vault id: ${vault.id}`);
        ids.add(vault.id);
    }
    return configs;
}
