import { describe, expect, test } from "bun:test";
import { AcknowledgedChangeStream } from "../../src/change-ack.js";
import { Vault } from "../../src/vault.js";

describe("AcknowledgedChangeStream", () => {
    test("runs changes in order and advances the checkpoint only after acknowledgement", async () => {
        const stream = new AcknowledgedChangeStream("0");
        const firstGate = deferred<void>();
        const events: string[] = [];

        const first = stream.enqueue("1", async () => {
            events.push("first:start");
            await firstGate.promise;
            events.push("first:end");
        });
        const second = stream.enqueue("2", async () => {
            events.push("second");
        });
        await Bun.sleep(0);

        expect(events).toEqual(["first:start"]);
        expect(stream.checkpoint).toBe("0");

        firstGate.resolve();
        await Promise.all([first, second]);
        await stream.drain();

        expect(events).toEqual(["first:start", "first:end", "second"]);
        expect(stream.checkpoint).toBe("2");
    });

    test("keeps the checkpoint and discards later work after the first failure", async () => {
        const stream = new AcknowledgedChangeStream("7");
        const failure = new Error("durable enqueue unavailable");
        let laterApplied = false;

        const rejected = stream.enqueue("8", async () => {
            throw failure;
        });
        const later = stream.enqueue("9", async () => {
            laterApplied = true;
        });

        await expect(rejected).rejects.toThrow("durable enqueue unavailable");
        await expect(later).rejects.toThrow("durable enqueue unavailable");
        await expect(stream.drain()).rejects.toThrow("durable enqueue unavailable");
        expect(stream.checkpoint).toBe("7");
        expect(laterApplied).toBe(false);
    });

    test("a new feed generation replays successfully from the last acknowledged sequence", async () => {
        const failed = new AcknowledgedChangeStream("10");
        await expect(
            failed.enqueue("11", async () => {
                throw new Error("temporary outage");
            }),
        ).rejects.toThrow("temporary outage");

        const replay = new AcknowledgedChangeStream(failed.checkpoint);
        let applications = 0;
        await replay.enqueue("11", async () => {
            applications += 1;
        });

        expect(applications).toBe(1);
        expect(replay.checkpoint).toBe("11");
    });
});

test("CouchDB catch-up waits for each change acknowledgement before saving its batch checkpoint", async () => {
    const callbackGate = deferred<void>();
    const events: string[] = [];
    const vault = Object.create(Vault.prototype) as Vault;
    Object.assign(vault as unknown as Record<string, unknown>, {
        passphrase: undefined,
        manipulator: {
            since: "0",
            getByMeta: async (meta: unknown) => meta,
            liveSyncLocalDB: {
                clearCaches() {},
                localDatabase: {
                    changes: async () => ({
                        results: [
                            {
                                seq: "5",
                                doc: { _id: "note", type: "plain", path: "note.md", data: ["body"], mtime: 42 },
                            },
                        ],
                        last_seq: "5",
                    }),
                },
            },
        },
    });

    const catchUp = vault.catchUp(
        "0",
        async (_path, _content, _mtime, seq) => {
            events.push(`callback:${seq}:start`);
            await callbackGate.promise;
            events.push(`callback:${seq}:end`);
        },
        async (since) => {
            events.push(`checkpoint:${since}`);
        },
    );
    await Bun.sleep(0);

    expect(events).toEqual(["callback:5:start"]);

    callbackGate.resolve();
    expect(await catchUp).toBe("5");
    expect(events).toEqual(["callback:5:start", "callback:5:end", "checkpoint:5"]);
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
