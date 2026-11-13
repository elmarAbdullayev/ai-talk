import { LANGUAGES, language } from "../config/languages";
import type { TalkController, TalkState } from "../talk/controller";
import { formatCost } from "../talk/provider";
import { CloseIcon } from "./icons";

interface Props {
  controller: TalkController;
  state: TalkState;
  onClose: () => void;
}

/** Voice, speed, explanation language, AI model and a few facts about privacy. */
export function Settings({ controller, state, onClose }: Props) {
  const lang = language(controller.spokenLanguage());
  return (
    <aside className="settings" aria-label="Settings">
      <header className="settings__head">
        <h2>Settings</h2>
        <button type="button" className="round-btn round-btn--small" onClick={onClose} aria-label="Close settings">
          <CloseIcon />
        </button>
      </header>

      <div className="field">
        <span>AI</span>
        <div className="switch switch--wide" role="radiogroup" aria-label="AI">
          <button
            type="button"
            role="radio"
            aria-checked={state.provider === "claude"}
            className={state.provider === "claude" ? "on" : ""}
            onClick={() => controller.setProvider("claude")}
          >
            Claude (Cloud)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={state.provider === "ollama"}
            className={state.provider === "ollama" ? "on" : ""}
            onClick={() => controller.setProvider("ollama")}
          >
            Local (Ollama)
          </button>
        </div>
        <small>
          {state.provider === "claude"
            ? `Claude Opus 5.5, about 0.5–2 ¢ per answer from your Anthropic credit. ${
                state.ai.claudeConfigured ? "API key found." : "No API key in backend\\.env yet."
              }`
            : `Free, runs on this laptop (${state.ai.model || "gemma3:4b"}). Faster to start, simpler answers.`}
        </small>
      </div>

      <label className="field">
        <span>Leon's voice ({lang.name})</span>
        <select value={state.voiceName ?? ""} onChange={(e) => controller.setVoice(e.target.value)} disabled={!state.voices.length}>
          {!state.voices.length && <option value="">No {lang.name} voice in this browser</option>}
          {state.voices.map((v) => (
            <option key={v.name} value={v.name}>
              {v.label}
              {v.male ? " · male" : ""}
              {v.natural ? " · natural" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Speaking speed: {state.rate.toFixed(2)}×</span>
        <input type="range" min={0.7} max={1.3} step={0.05} value={state.rate} onChange={(e) => controller.setRate(Number(e.target.value))} />
      </label>

      <label className="field">
        <span>Teacher explains in</span>
        <select value={state.explain} onChange={(e) => controller.setExplain(e.target.value as typeof state.explain)}>
          <option value="same">The language I practise</option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
      </label>

      {state.provider === "ollama" && (
        <label className="field">
          <span>AI model (Ollama)</span>
          <select
            value={state.model ?? ""}
            onChange={(e) => controller.setModel(e.target.value || null)}
            disabled={!state.ai.models.length}
          >
            <option value="">Default ({state.ai.model || "gemma3:4b"})</option>
            {state.ai.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <small>
            gemma3:4b was the fastest good model on a 6 GB graphics card. Reasoning models (deepseek-r1) are too slow for
            talking.
          </small>
        </label>
      )}

      <div className="settings__facts">
        <p>
          <strong>AI:</strong>{" "}
          {state.provider === "claude"
            ? `Claude in the cloud (${state.answeredBy ?? state.ai.claudeModel})`
            : state.ai.running
              ? `running locally (Ollama, ${state.ai.model})`
              : "Ollama is not running"}
          {state.lastLatency !== null && ` · last answer started after ${state.lastLatency.toFixed(1)} s`}
        </p>
        {state.lastCost !== null && (
          <p>
            <strong>Cost:</strong> last answer about {formatCost(state.lastCost)}, since this page opened about{" "}
            {formatCost(state.sessionCost)}.
          </p>
        )}
        <p>
          <strong>Privacy:</strong>{" "}
          {state.provider === "claude"
            ? "with Claude, the conversation is sent to Anthropic to get the answer. "
            : "the AI runs on this computer. "}
          Speech recognition and the natural voices are services of the browser (in Edge: Microsoft online services). The
          conversation is saved only in this browser.
        </p>
        <p className="settings__keys">
          <kbd>Space</kbd> talk / pause · <kbd>Esc</kbd> stop Leon
        </p>
      </div>
    </aside>
  );
}
