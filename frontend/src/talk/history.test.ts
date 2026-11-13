import { describe, expect, it } from "vitest";
import {
  type ChatMessage,
  type KeyValueStore,
  clearConversation,
  conversationKey,
  loadConversation,
  saveConversation,
  toApiMessages,
} from "./history";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const msg = (role: "user" | "assistant", text: string, raw?: string): ChatMessage => ({ id: text, role, text, raw, at: 0 });

describe("conversation history", () => {
  it("keeps one conversation per mode and language; the interview is always German", () => {
    expect(conversationKey("free", "az")).not.toBe(conversationKey("free", "de"));
    expect(conversationKey("teacher", "de")).not.toBe(conversationKey("free", "de"));
    expect(conversationKey("interview", "ru")).toBe(conversationKey("interview", "de"));
  });

  it("saves and loads", () => {
    const store = memoryStore();
    saveConversation("k", { version: 1, messages: [msg("user", "Hallo"), msg("assistant", "Hi")], finished: true }, store);
    const loaded = loadConversation("k", store);
    expect(loaded.messages.map((m) => m.text)).toEqual(["Hallo", "Hi"]);
    expect(loaded.finished).toBe(true);
  });

  it("keeps only the newest 200 messages", () => {
    const store = memoryStore();
    const many = Array.from({ length: 250 }, (_, i) => msg("user", `m${i}`));
    saveConversation("k", { version: 1, messages: many }, store);
    const loaded = loadConversation("k", store);
    expect(loaded.messages).toHaveLength(200);
    expect(loaded.messages[0].text).toBe("m50");
  });

  it("survives broken or missing data", () => {
    const store = memoryStore();
    expect(loadConversation("missing", store).messages).toEqual([]);
    store.setItem("bad", "{not json");
    expect(loadConversation("bad", store).messages).toEqual([]);
    store.setItem("odd", JSON.stringify({ version: 1, messages: [{ role: "robot", text: 1 }, msg("user", "ok")] }));
    expect(loadConversation("odd", store).messages.map((m) => m.text)).toEqual(["ok"]);
    expect(loadConversation("k", null).messages).toEqual([]);
  });

  it("clears", () => {
    const store = memoryStore();
    saveConversation("k", { version: 1, messages: [msg("user", "x")] }, store);
    clearConversation("k", store);
    expect(store.data.size).toBe(0);
  });
});

describe("toApiMessages", () => {
  it("sends the AI's raw text and drops empty answers", () => {
    const messages = [
      msg("assistant", "Hallo!", "REPLY: Hallo!"),
      msg("user", "ich gehe gestern"),
      msg("assistant", ""),
      msg("assistant", "Gut", undefined),
    ];
    expect(toApiMessages(messages)).toEqual([
      { role: "assistant", content: "REPLY: Hallo!" },
      { role: "user", content: "ich gehe gestern" },
      { role: "assistant", content: "Gut" },
    ]);
  });
});
