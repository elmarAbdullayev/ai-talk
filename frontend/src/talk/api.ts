import type { LanguageCode } from "../config/languages";
import type { Mode } from "../config/modes";

export type ProviderName = "claude" | "ollama";

export interface AiStatus {
  /** the AI used when the page does not choose one: Claude when a key is set */
  default_provider: ProviderName;
  /** whether backend/.env has an API key (the key itself never reaches the page) */
  claude: { configured: boolean; model: string };
  /** Ollama's state below */
  provider: string;
  running: boolean;
  version: string | null;
  model: string;
  model_installed: boolean;
  models: string[];
}

export type ChatAction = "reply" | "start" | "feedback";

export interface ChatRequest {
  mode: Mode;
  language: LanguageCode;
  explain_language?: LanguageCode | null;
  action: ChatAction;
  messages: { role: "user" | "assistant"; content: string }[];
  provider?: ProviderName | null;
  /** Ollama model (Claude always uses claude-opus-5-5) */
  model?: string | null;
}

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "done"; provider?: ProviderName; model: string; tokens: number; seconds: number; cost?: number }
  | { type: "error"; code: string; message: string };

/** A problem the page can explain: Ollama off, model missing, backend not running. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BACKEND_DOWN =
  "The AI Talk server is not running. Start it with start.cmd (or the backend from the README), then reload this page.";

async function failure(response: Response): Promise<ApiError> {
  try {
    const data = (await response.json()) as { code?: string; message?: string; detail?: unknown };
    if (data.message) return new ApiError(data.code ?? "failed", data.message);
    return new ApiError("failed", `Server error ${response.status}: ${JSON.stringify(data.detail ?? data)}`);
  } catch {
    // no JSON from a 5xx: the answer came from a proxy, not from the AI Talk server
    if (response.status >= 500) return new ApiError("backend", BACKEND_DOWN);
    return new ApiError("failed", `Server error ${response.status}`);
  }
}

export async function fetchStatus(signal?: AbortSignal): Promise<AiStatus> {
  let response: Response;
  try {
    response = await fetch("/api/status", { signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("backend", BACKEND_DOWN);
  }
  if (!response.ok) throw await failure(response);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new ApiError("backend", BACKEND_DOWN);
  return (await response.json()) as AiStatus;
}

/** Loads the local model into the graphics card so the first answer is fast. */
export async function warmup(model?: string | null): Promise<void> {
  const response = await fetch("/api/warmup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "ollama", model: model ?? null }),
  });
  if (!response.ok) throw await failure(response);
}

/** Reads a stream of JSON lines (one object per line). */
export async function* readJsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer.trim());
  } finally {
    reader.releaseLock();
  }
}

/** Sends the conversation and yields the answer piece by piece. Abort with `signal` (stop button). */
export async function* chatStream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("backend", BACKEND_DOWN);
  }
  if (!response.ok || !response.body) throw await failure(response);
  for await (const event of readJsonLines(response.body)) yield event as ChatEvent;
}
