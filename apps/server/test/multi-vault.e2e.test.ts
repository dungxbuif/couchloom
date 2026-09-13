import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const port = 9881;
const endpoint = `http://localhost:${port}/mcp`;
let processHandle: ChildProcess;
let root: string;
let sessionId = "";

function parseSse(raw: string): any {
    const data = raw.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : raw);
}

async function rpc(method: string, params: unknown): Promise<any> {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!sessionId) sessionId = response.headers.get("mcp-session-id") ?? "";
    return parseSse(await response.text());
}

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "couchloom-multi-"));
    const personal = join(root, "personal");
    const work = join(root, "work");
    await mkdir(personal);
    await mkdir(work);
    await writeFile(join(personal, "identity.md"), "personal-only");
    await writeFile(join(work, "identity.md"), "work-only");
    const config = [
        { id: "personal", name: "Personal", mode: "local", path: personal },
        { id: "work", name: "Work", mode: "local", path: work },
    ];
    processHandle = spawn(process.execPath, ["apps/server/dist/main.js"], {
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", VAULTS_CONFIG: JSON.stringify(config), DATA_DIR: join(root, "data") },
        stdio: "ignore",
    });
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "multi-e2e", version: "1" } } }),
            });
            if (response.ok) {
                sessionId = response.headers.get("mcp-session-id") ?? "";
                await response.text();
                return;
            }
        } catch {}
        await Bun.sleep(100);
    }
    throw new Error("multi-vault server did not start");
});

afterAll(async () => {
    processHandle?.kill("SIGTERM");
    await Bun.sleep(300);
    if (root) await rm(root, { recursive: true, force: true });
});

test("lists and isolates two vaults", async () => {
    const listed = await rpc("tools/call", { name: "list_vaults", arguments: {} });
    expect(listed.result.content[0].text).toContain("personal: Personal");
    expect(listed.result.content[0].text).toContain("work: Work");

    const personal = await rpc("tools/call", { name: "read_note", arguments: { vault_id: "personal", path: "identity.md" } });
    const work = await rpc("tools/call", { name: "read_note", arguments: { vault_id: "work", path: "identity.md" } });
    expect(personal.result.content[0].text).toContain("personal-only");
    expect(personal.result.content[0].text).not.toContain("work-only");
    expect(work.result.content[0].text).toContain("work-only");
});
