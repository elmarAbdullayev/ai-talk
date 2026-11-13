import { useEffect, useRef } from "react";
import type { TalkController, TalkState } from "../talk/controller";
import { MicIcon, SpeakerIcon, SpeakerOffIcon, StopIcon } from "./icons";

interface Props {
  controller: TalkController;
  state: TalkState;
}

/** Microphone button (with level ring), stop, mute and the hands-free / push-to-talk switch. */
export function Controls({ controller, state }: Props) {
  const ringRef = useRef<HTMLSpanElement>(null);
  const busy = state.phase === "thinking" || state.phase === "speaking";
  const push = state.inputMode === "push";

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const level = state.phase === "listening" ? controller.micLevel() : 0;
      ringRef.current?.style.setProperty("--level", level.toFixed(3));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [controller, state.phase]);

  let micLabel: string;
  if (!state.recognition) micLabel = "Speech input needs Edge or Chrome";
  else if (push) micLabel = state.pushing ? "Release to send" : "Hold to talk (or hold Space)";
  else if (busy) micLabel = "Stop Leon and talk";
  else if (state.phase === "listening") micLabel = "Listening … click to pause";
  else micLabel = "Click to listen";

  const pushHandlers = push
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          controller.pushStart();
        },
        onPointerUp: () => controller.pushEnd(),
        onPointerCancel: () => controller.pushEnd(),
        onKeyDown: (e: React.KeyboardEvent) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            controller.pushStart();
          }
        },
        onKeyUp: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            controller.pushEnd();
          }
        },
      }
    : { onClick: () => controller.toggleListening() };

  return (
    <div className="controls">
      <button
        type="button"
        className="round-btn"
        onClick={() => controller.toggleMute()}
        aria-pressed={state.muted}
        title={state.muted ? "Sound off: Leon only writes" : "Sound on"}
      >
        {state.muted ? <SpeakerOffIcon /> : <SpeakerIcon />}
        <span className="sr-only">{state.muted ? "Turn sound on" : "Mute"}</span>
      </button>

      <div className="mic">
        <button
          type="button"
          className={`mic__btn mic__btn--${state.pushing ? "pushing" : state.phase}`}
          disabled={!state.recognition}
          aria-label={micLabel}
          title={micLabel}
          {...pushHandlers}
        >
          <span className="mic__ring" ref={ringRef} />
          <MicIcon />
        </button>
        <span className="mic__label">{micLabel}</span>
      </div>

      <button
        type="button"
        className="round-btn"
        onClick={() => controller.interrupt()}
        disabled={!busy}
        title="Stop Leon (Esc)"
      >
        <StopIcon />
        <span className="sr-only">Stop speaking</span>
      </button>

      <div className="switch" role="radiogroup" aria-label="How to talk">
        <button type="button" role="radio" aria-checked={!push} className={!push ? "on" : ""} onClick={() => controller.setInputMode("handsfree")}>
          Hands-free
        </button>
        <button type="button" role="radio" aria-checked={push} className={push ? "on" : ""} onClick={() => controller.setInputMode("push")}>
          Push to talk
        </button>
      </div>
    </div>
  );
}
