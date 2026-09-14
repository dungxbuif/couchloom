import { expect, test } from "bun:test";
import { RagRuntime } from "../../src/rag-runtime.js";

test("RAG stays optional without DATABASE_URL", () => {
    expect(RagRuntime.fromEnvironment({})).toBeNull();
});

test("RAG validates all provider settings before connecting", () => {
    expect(() => RagRuntime.fromEnvironment({ DATABASE_URL: "postgres://db" })).toThrow("EMBEDDING_BASE_URL");
    expect(() => RagRuntime.fromEnvironment({
        DATABASE_URL: "postgres://db",
        EMBEDDING_BASE_URL: "http://embed/v1",
        EMBEDDING_MODEL: "model",
        EMBEDDING_DIMENSIONS: "invalid",
    })).toThrow("positive integer");
});
