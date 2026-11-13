import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, chatStream, readJsonLines } from "./api";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("readJsonLines", () => {
  it("joins lines that arrive in several pieces", async () => {
    const lines = await collect(readJsonLines(streamOf(['{"type":"tok', 'en","text":"Hal"}\n{"type":"to', 'ken","text":"lo"}\n'])));
    expect(lines).toEqual([
      { type: "token", text: "Hal" },
      { type: "token", text: "lo" },
    ]);
  });

  it("handles characters split between pieces and a last line without newline", async () => {
    const bytes = new TextEncoder().encode('{"text":"Mən"}\n{"text":"ə"}');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 11)); // cuts "ə" (2 bytes) in half
        c.enqueue(bytes.slice(11));
        c.close();
      },
    });
    expect(await collect(readJsonLines(stream))).toEqual([{ text: "Mən" }, { text: "ə" }]);
  });

  it("skips empty lines", async () => {
    expect(await collect(readJsonLines(streamOf(['\n{"a":1}\n\n', '{"a":2}\n'])))).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("chatStream", () => {
  afterEach(() => vi.unstubAllGlobals());

  const request = { mode: "free", language: "de", action: "reply", messages: [{ role: "user", content: "Hi" }] } as const;

  it("yields the server's events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(streamOf(['{"type":"token","text":"Hallo"}\n{"type":"done","model":"m","tokens":1,"seconds":0.1}\n']))),
    );
    const events = await collect(chatStream({ ...request, messages: [...request.messages] }));
    expect(events.map((e) => e.type)).toEqual(["token", "done"]);
  });

  it("turns the server's error answer into an ApiError with its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: "offline", message: "Ollama is not running." }, { status: 503 })),
    );
    await expect(collect(chatStream({ ...request, messages: [...request.messages] }))).rejects.toMatchObject({
      code: "offline",
      message: "Ollama is not running.",
    });
  });

  it("explains when the backend itself is not reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const error = await collect(chatStream({ ...request, messages: [...request.messages] })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("backend");
  });
});
