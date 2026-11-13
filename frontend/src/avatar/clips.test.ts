import { describe, expect, it } from "vitest";
import { TALK_HOLD_MS, chooseClip } from "./clips";

describe("chooseClip", () => {
  it("follows Leon's state", () => {
    expect(chooseClip("thinking", Infinity)).toBe("thinking");
    expect(chooseClip("listening", 0)).toBe("listening");
    expect(chooseClip("idle", 0)).toBe("listening");
  });

  it("shows the talking loop only while words are spoken", () => {
    expect(chooseClip("speaking", 0)).toBe("talking");
    expect(chooseClip("speaking", TALK_HOLD_MS - 1)).toBe("talking");
    expect(chooseClip("speaking", TALK_HOLD_MS + 1)).toBe("listening");
  });
});
