import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AvatarScene } from "./avatar/scene";
import { AvatarView } from "./components/AvatarView";
import { ChatPanel } from "./components/ChatPanel";
import { Controls } from "./components/Controls";
import { GearIcon } from "./components/icons";
import { Settings } from "./components/Settings";
import { LANGUAGES, isLanguageCode, language } from "./config/languages";
import { MODES, modeInfo } from "./config/modes";
import { TalkController, type TalkState } from "./talk/controller";
import { PROVIDER_LABEL, offerOllama } from "./talk/provider";
import { installDevHooks } from "./devHooks";

interface Notice {
  kind: "error" | "warn" | "info";
  text: React.ReactNode;
  onClose?: () => void;
  /** a button that fixes the problem, e.g. "Use Ollama instead" */
  action?: { label: string; run: () => void };
}

function notices(state: TalkState, controller: TalkController): Notice[] {
  const out: Notice[] = [];
  const ai = state.ai;
  const useOllama = { label: "Use Ollama instead", run: () => controller.setProvider("ollama") };
  const keyMissing = state.provider === "claude" && ai.checked && ai.server && !ai.claudeConfigured;
  if (ai.checked && !ai.server) {
    out.push({ kind: "error", text: <>The AI Talk server is not running. Start <code>start.cmd</code> and reload this page.</> });
  } else if (keyMissing) {
    out.push({
      kind: "error",
      text: (
        <>
          <strong>No Claude API key yet.</strong> Open <code>backend\.env</code> in the AI Talk folder, paste your key after{" "}
          <code>ANTHROPIC_API_KEY=</code> and save. No restart needed: this page notices it in a few seconds.
        </>
      ),
      action: useOllama,
    });
  } else if (state.provider === "claude") {
    // Claude problems are reported per answer (see the error below)
  } else if (ai.checked && !ai.running) {
    out.push({
      kind: "error",
      text: (
        <>
          <strong>Ollama is not running.</strong> Start it from the Windows Start menu (“Ollama”) or run <code>ollama serve</code> in a
          terminal. This page checks again every few seconds.
        </>
      ),
    });
  } else if (ai.checked && !ai.installed) {
    out.push({
      kind: "error",
      text: (
        <>
          The AI model <strong>{ai.model}</strong> is not installed. Open a terminal and run <code>ollama pull {ai.model}</code> (about 3.3 GB).
        </>
      ),
    });
  }
  const lang = language(controller.spokenLanguage());
  const mic: Partial<Record<TalkState["mic"], React.ReactNode>> = {
    blocked: (
      <>
        The microphone is blocked. Click the lock icon left of the address bar → Microphone → Allow, then reload. Also check Windows
        Settings → Privacy → Microphone.
      </>
    ),
    "no-mic": <>No microphone found, or another app is using it. You can still type.</>,
    network: <>The browser's speech recognition service cannot be reached. Check the internet connection, or type instead.</>,
    language: (
      <>
        This browser cannot recognise {lang.name} speech. Type your message instead, or choose another language.
      </>
    ),
    unsupported: <>Speech input needs Microsoft Edge or Google Chrome. You can still type.</>,
  };
  if (state.started && mic[state.mic]) out.push({ kind: "warn", text: mic[state.mic] });
  if (state.voiceWarning && !state.muted) out.push({ kind: "info", text: state.voiceWarning });
  if (state.error && !(keyMissing && state.errorCode === "no_key")) {
    out.push({
      kind: "error",
      text: state.error,
      onClose: () => controller.clearError(),
      action: offerOllama(state.errorCode, state.provider) && state.errorCode !== "no_key" ? useOllama : undefined,
    });
  }
  return out;
}

export default function App() {
  const controller = useMemo(() => new TalkController(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scene, setScene] = useState<AvatarScene | null>(null);

  useEffect(() => {
    void controller.init();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    if (import.meta.env.DEV) return installDevHooks(controller, scene);
  }, [controller, scene]);

  // Space: talk (hold in push-to-talk, toggle in hands-free); Esc: stop Leon
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") controller.interrupt();
      if (e.code !== "Space" || typing(e) || (e.target as HTMLElement)?.tagName === "BUTTON") return;
      e.preventDefault();
      if (e.repeat) return;
      if (controller.getSnapshot().inputMode === "push") controller.pushStart();
      else controller.toggleListening();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e) || (e.target as HTMLElement)?.tagName === "BUTTON") return;
      if (controller.getSnapshot().inputMode === "push") controller.pushEnd();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [controller]);

  const fixed = modeInfo(state.mode).fixedLanguage;
  const shownLanguage = fixed ?? state.language;
  const list = notices(state, controller);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brand__mark" aria-hidden />
          <span className="brand__name">AI Talk</span>
          <span className="brand__sub">with Leon</span>
        </div>
        <nav className="tabs" aria-label="Mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`tabs__tab${state.mode === m.id ? " on" : ""}`}
              aria-pressed={state.mode === m.id}
              onClick={() => controller.setMode(m.id)}
              title={m.description}
            >
              {m.short}
            </button>
          ))}
        </nav>
        <div className="top__right">
          <button
            type="button"
            className={`ai-badge ai-badge--${state.provider}`}
            onClick={() => setSettingsOpen(true)}
            title="The AI that answers (change it in the settings)"
          >
            <span className="ai-badge__dot" aria-hidden />
            {PROVIDER_LABEL[state.provider]}
          </button>
          <label className="lang">
            <span className="sr-only">Language</span>
            <select
              value={shownLanguage}
              disabled={!!fixed}
              title={fixed ? "The job interview is always in German" : "The language you speak with Leon"}
              onChange={(e) => {
                if (isLanguageCode(e.target.value)) controller.setLanguage(e.target.value);
              }}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="round-btn round-btn--small"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            aria-label="Settings"
          >
            <GearIcon />
          </button>
        </div>
      </header>

      {list.length > 0 && (
        <div className="notices">
          {list.map((n, i) => (
            <div key={i} className={`notice notice--${n.kind}`} role={n.kind === "error" ? "alert" : "status"}>
              <span>{n.text}</span>
              {n.action && (
                <button type="button" className="btn btn--small" onClick={n.action.run}>
                  {n.action.label}
                </button>
              )}
              {n.onClose && (
                <button type="button" className="notice__close" onClick={n.onClose} aria-label="Dismiss">
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <main className="stage">
        <div className="stage__left">
          <AvatarView
            controller={controller}
            phase={state.phase}
            interim={state.interim}
            heard={state.heard}
            started={state.started}
            onScene={setScene}
          >
            {!state.started && (
              <div className="start">
                <button type="button" className="btn btn--primary btn--big" onClick={() => void controller.begin()}>
                  Start talking
                </button>
                <p className="start__hint">
                  {modeInfo(state.mode).description} Allow the microphone when the browser asks.
                </p>
              </div>
            )}
          </AvatarView>
          <Controls controller={controller} state={state} />
        </div>
        <ChatPanel controller={controller} state={state} />
        {settingsOpen && <Settings controller={controller} state={state} onClose={() => setSettingsOpen(false)} />}
      </main>
    </div>
  );
}
