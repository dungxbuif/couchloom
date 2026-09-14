import { expect, test } from "bun:test";
import { chunkMarkdown } from "../../src/chunker.js";

test("chunks deterministically with bounded overlap", () => {
    const content = "# One\n\n" + "a".repeat(80) + "\n\n# Two\n\n" + "b".repeat(80);
    const first = chunkMarkdown(content, { maxChars: 80, overlapChars: 10 });
    const second = chunkMarkdown(content, { maxChars: 80, overlapChars: 10 });
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((chunk) => chunk.content.length <= 90)).toBe(true);
    expect(first.map(({ index }) => index)).toEqual(first.map((_, index) => index));
});
