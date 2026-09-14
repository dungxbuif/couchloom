import { describe, expect, test } from "bun:test";
import {
    createBinaryBlob,
    isTextBlob,
} from "../../lib/livesync-commonlib/src/common/utils.ts";
import { splitPieces2 } from "../../lib/livesync-commonlib/src/string_and_binary/chunks.ts";
import { createLiveSyncTextBlob } from "../../src/vault.ts";

describe("LiveSync blob content type detection", () => {
    test("recognizes Bun text blobs that include a charset parameter", () => {
        const blob = createLiveSyncTextBlob("# Markdown");

        expect(isTextBlob(blob)).toBe(true);
        expect(isTextBlob(createBinaryBlob(new TextEncoder().encode("binary").buffer))).toBe(false);
    });

    test("splits a Bun text blob as Markdown rather than Base64", async () => {
        const createPieces = await splitPieces2(createLiveSyncTextBlob("# Markdown"), 1_000, true, 20, "note.md");
        const pieces: string[] = [];
        for await (const piece of createPieces()) pieces.push(piece);

        expect(pieces).toEqual(["# Markdown"]);
    });
});
