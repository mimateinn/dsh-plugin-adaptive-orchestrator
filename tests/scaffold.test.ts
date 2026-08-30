import { describe, expect, it } from "vitest";
import { Config, name } from "../src/index.js";

describe("package scaffold", () => {
  it("exposes a disabled-by-default global switch", () => {
    expect(name).toBe("adaptive-orchestrator");
    expect(Config.properties.enabled.default).toBe(false);
  });
});
