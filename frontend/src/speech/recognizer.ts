import { MicLevel } from "./micLevel";

/* The Web Speech API is not in TypeScript's DOM types yet, so the parts we use are typed here. */
interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternative;
}
interface SpeechResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechResult };
}
interface SpeechErrorEvent extends Event {
  readonly error: string;
}
interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionClass = new () => Recognition;

export type MicState =
  | "off"
  | "starting"
  /** microphone open, not listening right now (Leon is thinking or speaking) */
  | "ready"
  | "listening"
  /** the browser or Windows does not allow the microphone */
  | "blocked"
  /** no microphone found, or another app holds it */
  | "no-mic"
  /** the browser's speech service cannot be reached */
  | "network"
  /** the browser cannot recognise this language */
  | "language"
  | "unsupported"
  | "error";

export interface RecognizerCallbacks {
  /** the words heard so far in the current phrase (not final yet) */
  onInterim(text: string): void;
  /** a finished phrase */
  onFinal(text: string): void;
  onState(state: MicState, detail?: string): void;
  /** true while the speech service hears someone talking */
  onSpeech?(talking: boolean): void;
  /** listening ended after stop() (push-to-talk released): all final results have arrived */
  onStopped?(): void;
}

function recognitionClass(): RecognitionClass | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function recognitionSupported(): boolean {
  return typeof window !== "undefined" && recognitionClass() !== null;
}

/**
 * Speech to text with the browser's Web Speech API. Edge (and Chrome) send the audio to their
 * online speech service; the AI itself runs locally.
 *
 * Keeps the microphone open for the level meter, and restarts the recognition after the
 * browser stops it on silence, as long as listening is wanted.
 */
export class Recognizer {
  private recognition: Recognition | null = null;
  private mic: MicLevel | null = null;
  private wanted = false;
  private locale = "de-DE";
  private networkErrors = 0;
  private state: MicState = "off";
  private failed = false;

  constructor(private readonly callbacks: RecognizerCallbacks) {}

  get current(): MicState {
    return this.state;
  }

  level(): number {
    return this.mic?.level() ?? 0;
  }

  get micName(): string {
    return this.mic?.name ?? "";
  }

  get listening(): boolean {
    return this.wanted;
  }

  /** Asks for the microphone (permission prompt). Returns false with a clear state on problems. */
  async openMic(): Promise<boolean> {
    if (!recognitionClass()) {
      this.setState("unsupported");
      return false;
    }
    if (this.mic) return true;
    this.setState("starting");
    try {
      this.mic = await MicLevel.start();
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      console.warn("[speech] microphone error:", e);
      if (name === "NotAllowedError" || name === "SecurityError") this.fail("blocked", name);
      else if (name === "NotFoundError" || name === "NotReadableError" || name === "OverconstrainedError")
        this.fail("no-mic", name);
      else this.fail("error", e instanceof Error ? e.message : String(e));
      return false;
    }
    this.failed = false;
    this.setState("ready");
    return true;
  }

  /** Starts listening in the given language (e.g. "de-DE"). */
  listen(locale: string): void {
    const Klass = recognitionClass();
    if (!Klass) {
      this.setState("unsupported");
      return;
    }
    if (this.wanted && this.recognition && this.locale === locale) return;
    if (this.recognition) {
      const old = this.recognition;
      this.recognition = null;
      old.onend = null;
      old.abort();
    }
    this.locale = locale;
    this.wanted = true;
    this.failed = false;
    const rec = new Klass();
    rec.lang = locale;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      if (this.recognition === rec && this.wanted) this.setState("listening");
    };
    rec.onspeechstart = () => this.callbacks.onSpeech?.(true);
    rec.onspeechend = () => this.callbacks.onSpeech?.(false);
    rec.onresult = (event) => {
      if (this.recognition !== rec) return;
      this.networkErrors = 0;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = (result[0]?.transcript ?? "").trim();
        if (!text) continue;
        if (result.isFinal) this.callbacks.onFinal(text);
        else interim += (interim ? " " : "") + text;
      }
      this.callbacks.onInterim(interim);
    };
    rec.onerror = (event) => {
      if (this.recognition !== rec) return;
      const code = event.error;
      console.warn("[speech] recognition error:", code);
      if (code === "no-speech" || code === "aborted") return;
      if (code === "not-allowed" || code === "service-not-allowed") this.fail("blocked", code);
      else if (code === "audio-capture") this.fail("no-mic", code);
      else if (code === "language-not-supported") this.fail("language", code);
      else if (code === "network") {
        this.networkErrors++;
        if (this.networkErrors >= 4) this.fail("network", code);
        else this.setState("network", code);
      } else this.setState("error", code);
    };
    rec.onend = () => {
      if (this.recognition !== rec) return;
      this.callbacks.onSpeech?.(false);
      this.callbacks.onInterim("");
      if (!this.wanted) {
        this.recognition = null;
        if (!this.failed) this.setState(this.mic ? "ready" : "off");
        this.callbacks.onStopped?.();
        return;
      }
      // the browser stops after some silence: start again at once, otherwise words get lost
      const wait = this.networkErrors ? 1500 * this.networkErrors : 40;
      window.setTimeout(() => {
        if (!this.wanted || this.recognition !== rec) return;
        try {
          rec.start();
        } catch (e) {
          this.fail("error", e instanceof Error ? e.message : String(e));
        }
      }, wait);
    };
    this.recognition = rec;
    this.setState("starting");
    try {
      rec.start();
    } catch (e) {
      this.fail("error", e instanceof Error ? e.message : String(e));
    }
  }

  /** Stops listening but delivers what was already said (onFinal, then onStopped). */
  stop(): void {
    this.wanted = false;
    if (this.recognition) this.recognition.stop();
    else this.callbacks.onStopped?.();
  }

  /** Stops at once and throws away what was not final yet. */
  abort(): void {
    this.wanted = false;
    const rec = this.recognition;
    this.recognition = null;
    if (rec) {
      rec.onend = null;
      rec.abort();
    }
    this.callbacks.onInterim("");
    if (!this.failed) this.setState(this.mic ? "ready" : "off");
  }

  /** Also closes the microphone. */
  close(): void {
    this.abort();
    this.mic?.stop();
    this.mic = null;
    if (!this.failed) this.setState("off");
  }

  private fail(state: MicState, detail?: string): void {
    this.wanted = false;
    this.failed = true;
    this.setState(state, detail);
  }

  private setState(state: MicState, detail?: string): void {
    this.state = state;
    this.callbacks.onState(state, detail);
  }
}
