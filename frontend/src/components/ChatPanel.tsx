import { useEffect, useRef, useState } from "react";
import { language } from "../config/languages";
import { modeInfo } from "../config/modes";
import type { TalkController, TalkState } from "../talk/controller";
import type { ChatMessage } from "../talk/history";

interface Props {
  controller: TalkController;
  state: TalkState;
}

function Message({ message }: { message: ChatMessage }) {
  const fix = message.correction;
  return (
    <li className={`msg msg--${message.role}${message.feedback ? " msg--feedback" : ""}`}>
      {message.role === "assistant" && <span className="msg__who">{message.feedback ? "Leon · Feedback" : "Leon"}</span>}
      {fix && (
        <div className="fix" aria-label="Correction">
          {fix.said && (
            <p className="fix__row">
              <span className="fix__label">You said</span>
              <span className="fix__said">{fix.said}</span>
            </p>
          )}
          <p className="fix__row">
            <span className="fix__label">Better</span>
            <span className="fix__better">{fix.better}</span>
          </p>
          {fix.why && (
            <p className="fix__row">
              <span className="fix__label">Why</span>
              <span>{fix.why}</span>
            </p>
          )}
        </div>
      )}
      {(message.text || message.pending) && (
        <div className="msg__bubble">
          {message.text}
          {message.pending && <span className="typing" aria-label="writing" />}
          {message.interrupted && <span className="msg__note"> (stopped)</span>}
        </div>
      )}
    </li>
  );
}

/** The conversation as text, and a box to type instead of speaking. */
export function ChatPanel({ controller, state }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const [text, setText] = useState("");
  const lang = language(controller.spokenLanguage());
  const info = modeInfo(state.mode);
  const progress = controller.interviewProgress();
  const hasUserMessage = state.messages.some((m) => m.role === "user");

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [state.messages, state.phase]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    controller.send(text);
    setText("");
  };

  return (
    <section className="chat" aria-label="Conversation">
      <header className="chat__head">
        <div>
          <h2 className="chat__title">{info.title}</h2>
          <p className="chat__desc">
            {state.mode === "interview"
              ? state.finished
                ? "Interview finished. Start a new one to practise again."
                : `IT Service Desk · in German · question ${Math.max(1, progress.asked)} of ${progress.total}`
              : `${info.description} · ${lang.native}`}
          </p>
        </div>
        <div className="chat__actions">
          {state.mode === "interview" && !state.finished && (
            <button type="button" className="btn btn--small" onClick={() => controller.requestFeedback()} disabled={!hasUserMessage}>
              End &amp; feedback
            </button>
          )}
          <button type="button" className="btn btn--small btn--ghost" onClick={() => controller.newConversation()}>
            {state.mode === "interview" ? "New interview" : "New talk"}
          </button>
        </div>
      </header>

      <ol className="chat__list" ref={listRef}>
        {state.messages.length === 0 && (
          <li className="chat__empty">{state.started ? "Leon starts the conversation …" : "Press “Start talking”. Leon will greet you."}</li>
        )}
        {state.messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
      </ol>

      {state.canRetry && (
        <div className="chat__retry">
          <button type="button" className="btn btn--small" onClick={() => controller.retry()}>
            Try again
          </button>
        </div>
      )}

      <form className="chat__form" onSubmit={submit}>
        <input
          className="chat__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={lang.placeholder}
          aria-label="Type a message"
          lang={lang.locale}
          maxLength={2000}
        />
        <button type="submit" className="btn btn--primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
