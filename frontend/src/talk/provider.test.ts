import { describe, expect, it } from "vitest";
import { effectiveProvider, formatCost, offerOllama } from "./provider";

describe("effectiveProvider", () => {
  it("uses Claude when a key is set and nothing was chosen", () => {
    expect(effectiveProvider(null, true)).toBe("claude");
    expect(effectiveProvider(null, false)).toBe("ollama");
  });

  it("keeps the user's choice", () => {
    expect(effectiveProvider("ollama", true)).toBe("ollama");
    // Claude chosen without a key: stays Claude, the page explains how to add the key
    expect(effectiveProvider("claude", false)).toBe("claude");
  });
});

describe("offerOllama", () => {
  it("offers the local AI for Claude problems only", () => {
    for (const code of ["no_key", "auth", "billing", "rate_limit", "network", "overloaded", "spend_limit"]) {
      expect(offerOllama(code, "claude")).toBe(true);
    }
    expect(offerOllama("refusal", "claude")).toBe(false);
    expect(offerOllama("offline", "ollama")).toBe(false);
    expect(offerOllama(null, "claude")).toBe(false);
  });
});

describe("formatCost", () => {
  it("shows cents for small amounts", () => {
    expect(formatCost(0.008)).toBe("0.8 ¢");
    expect(formatCost(0.0004)).toBe("0.04 ¢");
    expect(formatCost(1.234)).toBe("$1.23");
  });
});
