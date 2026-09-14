import { expect, test } from "bun:test";
import * as core from "@couchloom/core"; // public workspace boundary

test("server consumes the core public package", () => {
    expect(typeof core.registerTools).toBe("function");
    expect(typeof core.applyIndexChange).toBe("function");
});
