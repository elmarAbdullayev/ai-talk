import { LANGUAGES, isLanguageCode, language, type LanguageCode } from "../config/languages";
import { INTERVIEW_QUESTIONS, isMode, modeInfo, type Mode } from "../config/modes";
import { LipSync } from "../speech/lipsync";
import { Recognizer, recognitionSupported, type MicState } from "../speech/recognizer";
import {
  BrowserSpeaker,
  SilentSpeaker,
  loadVoices,
  speechSynthesisSupported,
  type SpeakerCallbacks,
  type SpeechOutput,
} from "../speech/speaker";
import { pickVoice, rankVoices, voiceWarning } from "../speech/voices";
import { ApiError, chatStream, fetchStatus, warmup, type ChatAction } from "./api";
import { effectiveProvider, type ProviderName } from "./provider";
import {
  type ChatMessage,
  clearConversation,
  conversationKey,
  loadConversation,
  newId,
  saveConversation,
  toApiMessages,
} from "./history";
import { SentenceSplitter, cleanForDisplay, cleanForSpeech } from "./sentences";
import { TeacherParser } from "./teacher";

export type Phase = "idle" | "listening" | "thinking" | "speaking";
export type InputMode = "handsfree" | "push";

export interface VoiceOption {
  name: string;
  label: string;
  male: boolean;
  natural: boolean;
}

export interface AiState {
  checked: boolean;
  /** the AI Talk server answered */
  server: boolean;
  running: boolean;
  installed: boolean;
  model: string;
  models: string[];
  /** the model is loaded into the graphics card */
  warm: boolean;
  /** backend/.env has an Anthropic API key */
  claudeConfigured: boolean;
  claudeModel: string;
}

export interface TalkState {
  started: boolean;
  mode: Mode;
  language: LanguageCode;
  /** teacher mode: language of the explanations ("same" = the practice language) */
  explain: LanguageCode | "same";
  messages: ChatMessage[];
  /** the interview ended with feedback */
  finished: boolean;
  phase: Phase;
  inputMode: InputMode;
  pushing: boolean;
  /** words heard in the current phrase */
  interim: string;
  /** finished phrases waiting to be sent */
  heard: string;
  mic: MicState;
  micDetail: string;
  muted: boolean;
  voices: VoiceOption[];
  voiceName: string | null;
  voiceWarning: string | null;
  rate: number;
  model: string | null;
  ai: AiState;
  error: string | null;
  /** the last answer failed: the user can try again */
  canRetry: boolean;
  recognition: boolean;
  /** seconds from sending until Leon started to speak (last answer) */
  lastLatency: number | null;
  /** the AI that answers: Claude (cloud, paid) or Ollama (local, free) */
  provider: ProviderName;
  /** what the user picked in the settings (null = Claude when a key is set) */
  providerChoice: ProviderName | null;
  /** the code of the last error (the page offers the switch to Ollama for Claude problems) */
  errorCode: string | null;
  /** estimated price of the last Claude answer, and of all answers since the page opened (US dollars) */
  lastCost: number | null;
  sessionCost: number;
  /** model that wrote the last answer (a safety fallback may use another one) */
  answeredBy: string | null;
}

interface Settings {
  mode: Mode;
  language: LanguageCode;
  explain: LanguageCode | "same";
  inputMode: InputMode;
  muted: boolean;
  rate: number;
  voices: Partial<Record<LanguageCode, string>>;
  model: string | null;
  provider: ProviderName | null;
}

const SETTINGS_KEY = "ai-talk:settings";
/** wait this long after the last words before sending (hands-free) */
const SEND_AFTER_SILENCE_MS = 900;

function loadSettings(): Settings {
  const defaults: Settings = {
    mode: "free",
    language: "de",
    explain: "same",
    inputMode: "handsfree",
    muted: false,
    rate: 1,
    voices: {},
    model: null,
    provider: null,
  };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    return {
      mode: isMode(s.mode) ? s.mode : defaults.mode,
      language: isLanguageCode(s.language) ? s.language : defaults.language,
      explain: s.explain === "same" || isLanguageCode(s.explain) ? s.explain : defaults.explain,
      inputMode: s.inputMode === "push" ? "push" : "handsfree",
      muted: Boolean(s.muted),
      rate: typeof s.rate === "number" && s.rate >= 0.6 && s.rate <= 1.5 ? s.rate : 1,
      voices: s.voices && typeof s.voices === "object" ? s.voices : {},
      model: typeof s.model === "string" ? s.model : null,
      provider: s.provider === "claude" || s.provider === "ollama" ? s.provider : null,
    };
  } catch {
    return defaults;
  }
}

const isEdge = () => typeof navigator !== "undefined" && /Edg\//.test(navigator.userAgent);

/**
 * The conversation: listens (speech to text), asks the AI (streamed), speaks the answer sentence
 * by sentence and drives the avatar's state and lips. React reads it through subscribe/snapshot.
 */
export class TalkController {
  readonly lipSync = new LipSync();
  private state: TalkState;
  private listeners = new Set<() => void>();
  private settings: Settings;
  private recognizer: Recognizer;
  private browserSpeaker: BrowserSpeaker | null = null;
  private silentSpeaker: SilentSpeaker;
  private allVoices: SpeechSynthesisVoice[] = [];
  private abort: AbortController | null = null;
  private streamDone = true;
  private sendTimer = 0;
  private pushTimer = 0;
  private statusTimer = 0;
  private notifyQueued = false;
  private turn = 0;
  private sentAt = 0;
  /** avatar hooks: called when the user is talking (for nods) */
  onUserSpeech: ((talking: boolean) => void) | null = null;
  onSentence: ((text: string) => void) | null = null;

  constructor() {
    this.settings = loadSettings();
    const saved = loadConversation(conversationKey(this.settings.mode, this.effectiveLanguage(this.settings.mode)));
    this.state = {
      started: false,
      mode: this.settings.mode,
      language: this.settings.language,
      explain: this.settings.explain,
      messages: saved.messages,
      finished: Boolean(saved.finished),
      phase: "idle",
      inputMode: this.settings.inputMode,
      pushing: false,
      interim: "",
      heard: "",
      mic: "off",
      micDetail: "",
      muted: this.settings.muted,
      voices: [],
      voiceName: null,
      voiceWarning: null,
      rate: this.settings.rate,
      model: this.settings.model,
      ai: {
        checked: false,
        server: false,
        running: false,
        installed: false,
        model: "",
        models: [],
        warm: false,
        claudeConfigured: false,
        claudeModel: "claude-opus-5-5",
      },
      error: null,
      canRetry: false,
      recognition: recognitionSupported(),
      lastLatency: null,
      provider: effectiveProvider(this.settings.provider, false),
      providerChoice: this.settings.provider,
      errorCode: null,
      lastCost: null,
      sessionCost: 0,
      answeredBy: null,
    };

    const speakerCallbacks: SpeakerCallbacks = {
      onSentenceStart: (text) => {
        if (this.sentAt) {
          this.update({ lastLatency: Math.round((performance.now() - this.sentAt) / 100) / 10 });
          this.sentAt = 0;
        }
        this.lipSync.start(text, this.spokenLanguage(), this.state.rate, performance.now());
        this.onSentence?.(text);
        this.update({ phase: "speaking" });
      },
      onBoundary: (charIndex) => this.lipSync.boundary(charIndex, performance.now()),
      onSentenceEnd: () => this.lipSync.stop(),
      onIdle: () => {
        if (this.streamDone) this.afterTurn();
        else this.update({ phase: "thinking" });
      },
      onError: (message) => this.update({ error: message, errorCode: "voice" }),
    };
    if (speechSynthesisSupported()) this.browserSpeaker = new BrowserSpeaker(speakerCallbacks);
    this.silentSpeaker = new SilentSpeaker(speakerCallbacks);

    this.recognizer = new Recognizer({
      onInterim: (text) => this.heardInterim(text),
      onFinal: (text) => this.heardFinal(text),
      onState: (mic, detail) => this.update({ mic, micDetail: detail ?? "" }),
      onSpeech: (talking) => this.onUserSpeech?.(talking),
      onStopped: () => this.pushStopped(),
    });
  }

  // ---- React glue ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TalkState => this.state;

  /** Microphone loudness 0..1 */
  micLevel(): number {
    return this.recognizer.level();
  }

  private update(patch: Partial<TalkState>, immediate = true): void {
    this.state = { ...this.state, ...patch };
    if (immediate) this.emit();
    else if (!this.notifyQueued) {
      this.notifyQueued = true;
      requestAnimationFrame(() => {
        this.notifyQueued = false;
        this.emit();
      });
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // ---- start-up ----

  async init(): Promise<void> {
    void this.refreshVoices();
    if (speechSynthesisSupported()) {
      speechSynthesis.addEventListener("voiceschanged", () => void this.refreshVoices());
    }
    await this.checkAi();
  }

  dispose(): void {
    window.clearTimeout(this.statusTimer);
    this.stopEverything();
    this.recognizer.close();
  }

  /**
   * Checks the AI: is a Claude key set, is Ollama running. Polls more often while something is
   * missing, so the message goes away by itself (a pasted key or a started Ollama).
   */
  async checkAi(): Promise<void> {
    window.clearTimeout(this.statusTimer);
    let next = 60_000;
    try {
      const s = await fetchStatus();
      const model = this.state.model && s.models.includes(this.state.model) ? this.state.model : s.model;
      const installed = s.models.includes(model);
      const wasReady = this.state.ai.running && this.state.ai.installed;
      // an older server sends no Claude info: then there is no key
      const claude = s.claude ?? { configured: false, model: "claude-opus-5-5" };
      const provider = effectiveProvider(this.settings.provider, claude.configured);
      this.update({
        provider,
        ai: {
          ...this.state.ai,
          checked: true,
          server: true,
          running: s.running,
          installed,
          model,
          models: s.models,
          claudeConfigured: claude.configured,
          claudeModel: claude.model,
        },
      });
      if (provider === "claude") {
        if (!claude.configured) next = 5000;
      } else if (!s.running || !installed) next = 5000;
      // the local model is only loaded into the graphics card when it is the AI in use
      else if (!wasReady || !this.state.ai.warm) void this.warm();
    } catch (e) {
      const server = !(e instanceof ApiError && e.code === "backend");
      this.update({ ai: { ...this.state.ai, checked: true, server, running: false } });
      next = 5000;
    }
    this.statusTimer = window.setTimeout(() => void this.checkAi(), next);
  }

  private async warm(): Promise<void> {
    try {
      await warmup(this.state.model);
      this.update({ ai: { ...this.state.ai, warm: true } });
    } catch (e) {
      console.warn("[ai] warm-up failed", e);
    }
  }

  private async refreshVoices(): Promise<void> {
    this.allVoices = await loadVoices();
    this.applyVoice();
  }

  private applyVoice(): void {
    const lang = language(this.spokenLanguage());
    const ranked = rankVoices(this.allVoices, lang);
    const picked = pickVoice(this.allVoices, lang, this.settings.voices[lang.code]);
    if (this.browserSpeaker) {
      this.browserSpeaker.voice = picked?.voice ?? null;
      this.browserSpeaker.locale = lang.locale;
      this.browserSpeaker.lang = lang.code;
      this.browserSpeaker.rate = this.state.rate;
    }
    this.silentSpeaker.lang = lang.code;
    this.silentSpeaker.rate = this.state.rate;
    this.update({
      voices: ranked.map((r) => ({
        name: r.voice.name,
        label: r.voice.name.replace(/^Microsoft\s+/, "").replace(/\s+-\s+.*$/, ""),
        male: r.male,
        natural: r.natural,
      })),
      voiceName: picked?.voice.name ?? null,
      voiceWarning: this.allVoices.length || !speechSynthesisSupported() ? voiceWarning(picked, lang, isEdge()) : null,
    });
  }

  private get speaker(): SpeechOutput {
    return this.browserSpeaker && this.state.voiceName ? this.browserSpeaker : this.silentSpeaker;
  }

  /** The interview is always German. */
  private effectiveLanguage(mode: Mode = this.state.mode): LanguageCode {
    return modeInfo(mode).fixedLanguage ?? (this.state?.language ?? this.settings.language);
  }

  spokenLanguage(): LanguageCode {
    return this.effectiveLanguage();
  }

  private saveSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* not kept */
    }
  }

  private save(): void {
    saveConversation(conversationKey(this.state.mode, this.spokenLanguage()), {
      version: 1,
      messages: this.state.messages,
      finished: this.state.finished,
    });
  }

  // ---- user actions ----

  /** The "Start talking" button: unlocks sound and asks for the microphone. */
  async begin(): Promise<void> {
    if (this.state.started) return;
    this.update({ started: true, error: null });
    // a silent utterance inside the click unlocks speech in browsers that need a user gesture
    if (speechSynthesisSupported()) {
      const unlock = new SpeechSynthesisUtterance(" ");
      unlock.volume = 0;
      speechSynthesis.speak(unlock);
    }
    if (this.state.recognition) await this.recognizer.openMic();
    this.continueConversation();
  }

  /** After start or a switch: Leon opens an empty conversation, otherwise it is the user's turn. */
  private continueConversation(): void {
    if (!this.state.started) return;
    if (this.state.messages.length === 0) void this.ask("start");
    else this.afterTurn();
  }

  setMode(mode: Mode): void {
    if (mode === this.state.mode) return;
    this.stopEverything();
    this.saveSettings({ mode });
    const saved = loadConversation(conversationKey(mode, this.effectiveLanguage(mode)));
    this.update({ mode, messages: saved.messages, finished: Boolean(saved.finished), error: null, canRetry: false });
    this.applyVoice();
    this.continueConversation();
  }

  setLanguage(code: LanguageCode): void {
    if (code === this.state.language) return;
    this.saveSettings({ language: code });
    if (modeInfo(this.state.mode).fixedLanguage) {
      this.update({ language: code });
      return;
    }
    this.stopEverything();
    const saved = loadConversation(conversationKey(this.state.mode, code));
    this.update({ language: code, messages: saved.messages, finished: Boolean(saved.finished), error: null, canRetry: false });
    this.applyVoice();
    this.continueConversation();
  }

  setExplain(explain: LanguageCode | "same"): void {
    this.saveSettings({ explain });
    this.update({ explain });
  }

  setInputMode(inputMode: InputMode): void {
    this.saveSettings({ inputMode });
    this.update({ inputMode });
    if (this.state.phase === "listening" && inputMode === "push") {
      this.recognizer.abort();
      this.update({ phase: "idle", interim: "" });
    } else if (this.state.phase === "idle") this.afterTurn();
  }

  toggleMute(): void {
    const muted = !this.state.muted;
    this.saveSettings({ muted });
    if (muted && this.speaker.busy) {
      this.speaker.cancel();
      this.lipSync.stop();
      if (this.streamDone) this.afterTurn();
      else this.update({ phase: "thinking" });
    }
    this.update({ muted });
  }

  setVoice(name: string): void {
    this.saveSettings({ voices: { ...this.settings.voices, [this.spokenLanguage()]: name } });
    this.applyVoice();
  }

  setRate(rate: number): void {
    this.saveSettings({ rate });
    this.update({ rate });
    this.applyVoice();
  }

  /** Claude (cloud) or Ollama (local); null = Claude when a key is set. */
  setProvider(choice: ProviderName | null): void {
    this.saveSettings({ provider: choice });
    const provider = effectiveProvider(choice, this.state.ai.claudeConfigured);
    const fixes = this.state.errorCode !== null && this.state.provider !== provider;
    this.update({
      providerChoice: choice,
      provider,
      ...(fixes ? { error: null, errorCode: null } : {}),
    });
    void this.checkAi();
  }

  setModel(model: string | null): void {
    this.saveSettings({ model });
    this.update({ model, ai: { ...this.state.ai, warm: false } });
    void this.checkAi();
  }

  /** Typed text or recognized speech. */
  send(text: string): void {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    if (this.state.phase === "thinking" || this.state.phase === "speaking") this.interrupt(false);
    if (!this.state.started) this.update({ started: true });
    void this.ask("reply", clean);
  }

  /** Stop button / Space while Leon talks: stops the answer and gives the turn to the user. */
  interrupt(resume = true): void {
    if (this.state.phase !== "thinking" && this.state.phase !== "speaking") return;
    this.stopEverything(true);
    if (resume) this.afterTurn();
  }

  newConversation(): void {
    this.stopEverything();
    clearConversation(conversationKey(this.state.mode, this.spokenLanguage()));
    this.update({ messages: [], finished: false, error: null, canRetry: false });
    this.continueConversation();
  }

  requestFeedback(): void {
    if (this.state.mode !== "interview" || this.state.finished) return;
    if (!this.state.messages.some((m) => m.role === "user")) return;
    this.stopEverything(true);
    void this.ask("feedback");
  }

  retry(): void {
    if (!this.state.canRetry) return;
    const last = this.state.messages[this.state.messages.length - 1];
    void this.ask(last?.role === "user" ? "reply" : this.state.messages.length ? "feedback" : "start");
  }

  clearError(): void {
    this.update({ error: null, errorCode: null });
  }

  // ---- push-to-talk ----

  pushStart(): void {
    if (!this.state.recognition || this.state.pushing) return;
    if (this.state.phase === "thinking" || this.state.phase === "speaking") this.stopEverything(true);
    window.clearTimeout(this.sendTimer);
    window.clearTimeout(this.pushTimer);
    if (!this.state.started) this.update({ started: true });
    this.update({ pushing: true, heard: "", interim: "", phase: "listening", error: null });
    void this.recognizer.openMic().then((ok) => {
      if (ok && this.state.pushing) this.recognizer.listen(language(this.spokenLanguage()).locale);
    });
  }

  pushEnd(): void {
    if (!this.state.pushing) return;
    this.update({ pushing: false });
    this.recognizer.stop();
    // if the browser never reports the end, send what we have
    this.pushTimer = window.setTimeout(() => this.pushStopped(), 2500);
  }

  private pushStopped(): void {
    window.clearTimeout(this.pushTimer);
    if (this.state.pushing || this.state.phase !== "listening") return;
    const text = `${this.state.heard} ${this.state.interim}`.trim();
    this.update({ heard: "", interim: "" });
    if (text) this.send(text);
    else this.afterTurn();
  }

  /** Hands-free: the big button pauses or resumes listening, or stops Leon. */
  toggleListening(): void {
    if (this.state.phase === "thinking" || this.state.phase === "speaking") {
      this.interrupt();
      return;
    }
    if (!this.state.started) {
      void this.begin();
      return;
    }
    if (this.state.phase === "listening") {
      window.clearTimeout(this.sendTimer);
      this.recognizer.abort();
      this.update({ phase: "idle", interim: "", heard: "" });
      return;
    }
    this.afterTurn();
  }

  // ---- hands-free listening ----

  private heardInterim(text: string): void {
    if (this.state.phase !== "listening") return;
    this.update({ interim: text }, false);
    if (this.state.inputMode !== "handsfree" || this.state.pushing) return;
    window.clearTimeout(this.sendTimer);
    if (!text && this.state.heard) this.sendTimer = window.setTimeout(() => this.sendHeard(), SEND_AFTER_SILENCE_MS);
  }

  private heardFinal(text: string): void {
    if (this.state.phase !== "listening") return;
    this.update({ heard: `${this.state.heard} ${text}`.trim() });
    if (this.state.inputMode !== "handsfree" || this.state.pushing) return;
    window.clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => this.sendHeard(), SEND_AFTER_SILENCE_MS);
  }

  private sendHeard(): void {
    if (this.state.phase !== "listening" || this.state.pushing) return;
    const text = this.state.heard.trim();
    if (!text) return;
    this.recognizer.abort();
    this.update({ heard: "", interim: "" });
    this.send(text);
  }

  /** The user's turn: listen (hands-free) or wait for the button. */
  private afterTurn(): void {
    window.clearTimeout(this.sendTimer);
    if (!this.state.started || this.state.finished) {
      this.recognizer.abort();
      this.update({ phase: "idle", interim: "" });
      return;
    }
    const canListen =
      this.state.inputMode === "handsfree" &&
      this.state.recognition &&
      !["blocked", "no-mic", "unsupported", "language"].includes(this.state.mic);
    if (canListen) {
      this.update({ phase: "listening", heard: "", interim: "" });
      this.recognizer.listen(language(this.spokenLanguage()).locale);
    } else {
      this.recognizer.abort();
      this.update({ phase: "idle", interim: "" });
    }
  }

  private stopEverything(markInterrupted = false): void {
    window.clearTimeout(this.sendTimer);
    window.clearTimeout(this.pushTimer);
    this.turn++;
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    this.streamDone = true;
    this.browserSpeaker?.cancel();
    this.silentSpeaker.cancel();
    this.lipSync.stop();
    this.recognizer.abort();
    const messages = this.state.messages.map((m) =>
      m.pending ? { ...m, pending: undefined, interrupted: markInterrupted || undefined } : m,
    );
    this.update({ phase: "idle", interim: "", heard: "", pushing: false, messages: messages.filter((m) => m.text || m.raw || m.role === "user") });
    this.save();
  }

  // ---- asking the AI ----

  private async ask(action: ChatAction, userText?: string): Promise<void> {
    const turn = ++this.turn;
    window.clearTimeout(this.sendTimer);
    this.recognizer.abort();
    const mode = this.state.mode;
    const lang = this.spokenLanguage();
    let messages = this.state.messages;
    if (userText) messages = [...messages, { id: newId(), role: "user", text: userText, at: Date.now() }];
    const history = toApiMessages(messages);
    const assistantsBefore = messages.filter((m) => m.role === "assistant").length;
    const isFeedback =
      mode === "interview" &&
      (action === "feedback" || (assistantsBefore >= INTERVIEW_QUESTIONS && messages[messages.length - 1]?.role === "user"));
    const answer: ChatMessage = { id: newId(), role: "assistant", text: "", raw: "", at: Date.now(), pending: true, feedback: isFeedback || undefined };
    this.update({
      messages: [...messages, answer],
      phase: "thinking",
      error: null,
      errorCode: null,
      canRetry: false,
      interim: "",
      heard: "",
    });
    this.save();

    const controller = new AbortController();
    this.abort = controller;
    this.streamDone = false;
    this.sentAt = performance.now();
    const splitter = new SentenceSplitter();
    const teacher = mode === "teacher" ? new TeacherParser() : null;
    const provider = this.state.provider;
    let raw = "";
    let declined = false;

    const speak = (sentences: string[]) => {
      for (const s of sentences) {
        const spoken = cleanForSpeech(s);
        if (!spoken || this.state.muted || turn !== this.turn) continue;
        this.speaker.say(spoken);
      }
    };
    const show = () => {
      const text = cleanForDisplay(teacher ? teacher.reply : raw);
      this.patchAnswer(answer.id, { text, raw, correction: teacher?.correction() ?? null }, false);
    };

    try {
      const explain = this.state.explain === "same" ? null : this.state.explain;
      for await (const event of chatStream(
        {
          mode,
          language: lang,
          explain_language: explain,
          action,
          messages: history,
          provider,
          model: provider === "ollama" ? this.state.model : null,
        },
        controller.signal,
      )) {
        if (turn !== this.turn) return;
        if (event.type === "token") {
          raw += event.text;
          speak(splitter.push(teacher ? teacher.push(event.text) : event.text));
          show();
        } else if (event.type === "done") {
          if (event.cost !== undefined) {
            this.update({ lastCost: event.cost, sessionCost: this.state.sessionCost + event.cost });
          }
          // the Claude model that wrote it (a safety fallback can hand the answer to another model)
          this.update({ answeredBy: event.provider === "claude" ? event.model : null });
        } else if (event.type === "error") {
          if (event.code === "refusal") {
            // Claude declined after starting: the partial answer is not a real answer
            declined = true;
            this.browserSpeaker?.cancel();
            this.silentSpeaker.cancel();
            this.lipSync.stop();
            raw = "";
            this.patchAnswer(answer.id, { text: "", raw: "", correction: null });
          }
          this.update({ error: event.message, errorCode: event.code });
        }
      }
      if (!declined) {
        if (teacher) speak(splitter.push(teacher.finish()));
        speak(splitter.flush());
        show();
      }
    } catch (e) {
      if (turn !== this.turn) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      const message = e instanceof Error ? e.message : String(e);
      const code = e instanceof ApiError ? e.code : "failed";
      this.update({ error: message, errorCode: code, canRetry: true });
      if (["offline", "model_missing", "backend", "no_key"].includes(code)) void this.checkAi();
    }
    if (turn !== this.turn) return;
    this.abort = null;
    this.streamDone = true;
    const final = this.state.messages.find((m) => m.id === answer.id);
    if (final && !final.text && !final.raw) {
      this.update({ messages: this.state.messages.filter((m) => m.id !== answer.id), canRetry: true });
    } else {
      this.patchAnswer(answer.id, { pending: undefined });
      if (isFeedback) this.update({ finished: true });
    }
    this.save();
    // still speaking: the speaker's onIdle continues the talk; otherwise it is the user's turn now
    if (!this.speaker.busy) this.afterTurn();
  }

  private patchAnswer(id: string, patch: Partial<ChatMessage>, immediate = true): void {
    this.update({ messages: this.state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }, immediate);
  }

  // ---- for the interface ----

  interviewProgress(): { asked: number; total: number } {
    const asked = this.state.messages.filter((m) => m.role === "assistant" && !m.feedback).length;
    return { asked: Math.min(asked, INTERVIEW_QUESTIONS), total: INTERVIEW_QUESTIONS };
  }

  /** For tests in a browser without microphone (dev only): pretend the user said this. */
  simulateSpeech(text: string): void {
    if (this.state.phase !== "listening") this.afterTurn();
    this.update({ phase: "listening" });
    this.heardFinal(text);
    this.sendHeard();
  }

  static languages = LANGUAGES;
}
