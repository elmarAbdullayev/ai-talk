import type { LanguageCode } from "../config/languages";
import { BASE_CHARS_PER_SECOND } from "./lipsync";
import { buildTimeline } from "./visemes";

export interface SpeakerCallbacks {
  onSentenceStart(text: string): void;
  /** a word starts: character index in the sentence */
  onBoundary(charIndex: number): void;
  onSentenceEnd(): void;
  /** everything that was queued has been spoken */
  onIdle(): void;
  onError(message: string): void;
}

export interface SpeechOutput {
  /** queues a sentence */
  say(text: string): void;
  /** stops at once and forgets the queue (no more callbacks for it) */
  cancel(): void;
  readonly busy: boolean;
}

/** Estimated seconds to speak a sentence (for watchdogs and the silent speaker). */
export function estimateSeconds(text: string, lang: LanguageCode, rate: number): number {
  const words = buildTimeline(text, lang, BASE_CHARS_PER_SECOND * Math.max(0.3, rate));
  return (words[words.length - 1]?.t1 ?? 0) + 0.25;
}

export function speechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** All voices; Edge adds its online voices a moment after the page loads, so this waits a little. */
export function loadVoices(timeoutMs = 3000): Promise<SpeechSynthesisVoice[]> {
  if (!speechSynthesisSupported()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      speechSynthesis.removeEventListener("voiceschanged", done);
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.addEventListener("voiceschanged", done);
    window.setTimeout(done, timeoutMs);
  });
}

/**
 * Speaks with the browser's speechSynthesis (in Edge: Microsoft's natural online voices).
 * All sentences are handed to the browser at once so there is no gap between them.
 */
export class BrowserSpeaker implements SpeechOutput {
  voice: SpeechSynthesisVoice | null = null;
  locale = "de-DE";
  lang: LanguageCode = "de";
  rate = 1;

  // keep references: Chrome forgets utterances that nobody holds, and then never sends "end"
  private queue: SpeechSynthesisUtterance[] = [];
  private generation = 0;
  private watchdog = 0;

  constructor(private readonly callbacks: SpeakerCallbacks) {}

  get busy(): boolean {
    return this.queue.length > 0;
  }

  say(text: string): void {
    const generation = this.generation;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? this.locale;
    u.rate = this.rate;
    u.pitch = 1;
    let started = false;
    let finished = false;
    const finish = () => {
      if (finished || generation !== this.generation) return;
      finished = true;
      this.queue = this.queue.filter((x) => x !== u);
      window.clearTimeout(this.watchdog);
      this.callbacks.onSentenceEnd();
      if (this.queue.length) this.armStartWatchdog();
      else this.callbacks.onIdle();
    };
    u.onstart = () => {
      if (generation !== this.generation) return;
      started = true;
      window.clearTimeout(this.watchdog);
      this.callbacks.onSentenceStart(text);
      // if the "end" event never comes, go on after a generous time
      const limit = estimateSeconds(text, this.lang, this.rate) * 2.5 + 4;
      this.watchdog = window.setTimeout(finish, limit * 1000);
    };
    u.onboundary = (e) => {
      if (generation !== this.generation || !started) return;
      if (e.name === "word" || e.name === undefined) this.callbacks.onBoundary(e.charIndex);
    };
    u.onend = finish;
    u.onerror = (e) => {
      if (generation !== this.generation) return;
      if (e.error !== "interrupted" && e.error !== "canceled") {
        this.callbacks.onError(`The voice could not speak (${e.error}).`);
      }
      finish();
    };
    this.queue.push(u);
    speechSynthesis.speak(u);
    if (this.queue.length === 1) this.armStartWatchdog();
  }

  cancel(): void {
    this.generation++;
    this.queue = [];
    window.clearTimeout(this.watchdog);
    speechSynthesis.cancel();
  }

  /** An online voice that does not start (no internet) would block the talk: give up after a while. */
  private armStartWatchdog(): void {
    window.clearTimeout(this.watchdog);
    const generation = this.generation;
    this.watchdog = window.setTimeout(() => {
      if (generation !== this.generation || !this.queue.length) return;
      this.callbacks.onError("The voice did not start. Check the internet connection (Edge's natural voices are online).");
      this.cancel();
      this.callbacks.onSentenceEnd();
      this.callbacks.onIdle();
    }, 8000);
  }
}

/**
 * For browsers without a voice for the language: the avatar moves its lips in silence for the
 * estimated time, so the talk keeps its rhythm (the text is on screen).
 */
export class SilentSpeaker implements SpeechOutput {
  lang: LanguageCode = "de";
  rate = 1;
  private queue: string[] = [];
  private timer = 0;

  constructor(private readonly callbacks: SpeakerCallbacks) {}

  get busy(): boolean {
    return this.queue.length > 0;
  }

  say(text: string): void {
    this.queue.push(text);
    if (this.queue.length === 1) this.next();
  }

  cancel(): void {
    this.queue = [];
    window.clearTimeout(this.timer);
  }

  private next(): void {
    const text = this.queue[0];
    if (text === undefined) return;
    this.callbacks.onSentenceStart(text);
    this.timer = window.setTimeout(() => {
      this.queue.shift();
      this.callbacks.onSentenceEnd();
      if (this.queue.length) this.next();
      else this.callbacks.onIdle();
    }, estimateSeconds(text, this.lang, this.rate) * 1000);
  }
}
