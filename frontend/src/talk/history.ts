import type { LanguageCode } from "../config/languages";
import type { Mode } from "../config/modes";
import type { Correction } from "./teacher";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** what is shown (for the teacher: the reply without the correction lines) */
  text: string;
  /** the AI's answer exactly as written; sent back as history so Ollama can reuse its cache */
  raw?: string;
  correction?: Correction | null;
  at: number;
  /** the user stopped the answer */
  interrupted?: boolean;
  /** the interview feedback at the end */
  feedback?: boolean;
  /** the answer is still being written */
  pending?: boolean;
}

export interface SavedConversation {
  version: 1;
  messages: ChatMessage[];
  /** the interview has ended with feedback */
  finished?: boolean;
}

const MAX_SAVED = 200;
const PREFIX = "ai-talk:conversation";

export function conversationKey(mode: Mode, language: LanguageCode): string {
  return `${PREFIX}:${mode}:${mode === "interview" ? "de" : language}`;
}

/** A small key-value store; localStorage in the browser, a Map in tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null; // private mode or blocked storage: the talk still works, it is just not kept
  }
}

export function loadConversation(key: string, store: KeyValueStore | null = browserStore()): SavedConversation {
  const empty: SavedConversation = { version: 1, messages: [] };
  if (!store) return empty;
  try {
    const data = JSON.parse(store.getItem(key) ?? "null") as SavedConversation | null;
    if (!data || data.version !== 1 || !Array.isArray(data.messages)) return empty;
    const messages = data.messages.filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && typeof m.id === "string",
    );
    // an answer that was still being written when the page closed is finished now
    return { version: 1, messages: messages.map((m) => (m.pending ? { ...m, pending: undefined } : m)), finished: Boolean(data.finished) };
  } catch {
    return empty;
  }
}

export function saveConversation(key: string, conversation: SavedConversation, store: KeyValueStore | null = browserStore()): void {
  if (!store) return;
  const messages = conversation.messages.slice(-MAX_SAVED);
  try {
    store.setItem(key, JSON.stringify({ ...conversation, messages }));
  } catch {
    // storage full: keep only the newest half
    try {
      store.setItem(key, JSON.stringify({ ...conversation, messages: messages.slice(-MAX_SAVED / 2) }));
    } catch {
      /* not kept */
    }
  }
}

export function clearConversation(key: string, store: KeyValueStore | null = browserStore()): void {
  try {
    store?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** The conversation as the backend expects it: the AI's raw text, empty answers left out. */
export function toApiMessages(messages: ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  return messages
    .map((m) => ({ role: m.role, content: m.role === "assistant" ? (m.raw ?? m.text) : m.text }))
    .filter((m) => m.content.trim().length > 0);
}

let counter = 0;
export function newId(): string {
  counter = (counter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
