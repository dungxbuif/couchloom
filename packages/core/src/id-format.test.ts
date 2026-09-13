import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyIds } from "./id-format.js";

/**
 * Regression tests for the obfuscation mismatch behind issues #4 and #10:
 * a vault with "Obfuscate properties" enabled has `f:`-prefixed document IDs,
 * and the server must detect this rather than trust the configured flag.
 */

describe("classifyIds", () => {
    it("classifies f:-prefixed ids as obfuscated", () => {
        assert.equal(classifyIds(["f:abc123", "f:def456"]), "obfuscated");
    });

    it("classifies path-based ids as plain", () => {
        assert.equal(classifyIds(["inbox/тест.md", "daily/2026-07-21.md"]), "plain");
    });

    it("classifies a mix of both as mixed", () => {
        assert.equal(classifyIds(["f:abc123", "inbox/note.md"]), "mixed");
    });

    it("classifies no ids as empty", () => {
        assert.equal(classifyIds([]), "empty");
    });

    it("treats a path that merely contains f: as plain", () => {
        assert.equal(classifyIds(["notes/f: prefix study.md"]), "plain");
    });
});
