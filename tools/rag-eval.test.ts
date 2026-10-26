import { expect, test } from "bun:test";
import { parseCases, scoreRetrieval, summarize } from "./rag-eval";

test("legacy cases retain personal and new cases select Homelab", () => {
    const cases = parseCases([
        { id: "old", query: "question", expected: "wiki/a.md" },
        { id: "new", vaultId: "homelab", query: "question", expected: ["docs/a.md", "docs/b.md"] },
    ]);
    expect(cases[0].vaultId).toBe("personal");
    expect(cases[1].vaultId).toBe("homelab");
    expect(scoreRetrieval(cases[1], ["docs/b.md"]).rank).toBe(1);
});

test("missing results count as misses, unsupported cases remain unscored", () => {
    const [answerable, unsupported] = parseCases([
        { id: "answerable", query: "q", expected: "a.md" },
        { id: "unsupported", query: "q", expected: [] },
    ]);
    expect(scoreRetrieval(answerable, [])).toMatchObject({ answerable: true, rank: null });
    expect(scoreRetrieval(unsupported, ["irrelevant.md"])).toMatchObject({ answerable: false, rank: null });
});

test("rejects ambiguous or invalid evaluation labels before requesting MCP", () => {
    for (const input of [[], {}, [{ id: "x", query: "q" }],
        [{ id: "x", query: "q", expected: [4] }],
        [{ id: "x", vaultId: "", query: "q", expected: "a.md" }],
        [{ id: "x", query: " ", expected: "a.md" }],
        [{ id: "x", query: "q", expected: "a.md" }, { id: "x", query: "q", expected: "b.md" }]]) {
        expect(() => parseCases(input)).toThrow();
    }
});

test("top five rank cannot be inflated by a sixth result", () => {
    const [item] = parseCases([{ id: "q", query: "q", expected: "a.md" }]);
    expect(scoreRetrieval(item, ["1", "2", "3", "4", "5", "a.md"]).rank).toBeNull();
});

test("unsupported cases do not inflate or dilute hit rate and MRR", () => {
    const unsupported = { answerable: false, rank: null, latencyMs: 300 };
    expect(summarize([
        { answerable: true, rank: 2, latencyMs: 100 },
        { answerable: true, rank: null, latencyMs: 200 }, unsupported,
    ])).toMatchObject({ cases: 3, answerableCases: 2, hitAt5: .5, mrrAt5: .25,
        unsupportedCasesRequiringAnswerReview: 1, p50Ms: 200, p95Ms: 300 });
    expect(summarize([unsupported])).toMatchObject({ hitAt5: null, mrrAt5: null });
});
