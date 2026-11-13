"""AI Talk backend: talks to the AI (Claude in the cloud, or Ollama on this computer) and, after a
build, serves the website."""

from __future__ import annotations

import json
import os
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .prompts import LANGUAGES, Action, Mode, build_messages, generation_options
from .providers.base import ChatMessage, ChatProvider, Finished, ProviderError, Token
from .providers.claude import CLAUDE_MODEL, ClaudeProvider, ClientFactory, default_client
from .providers.ollama import OllamaProvider

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SITE_DIR = BACKEND_DIR.parent / "frontend" / "dist"
# The API key lives only here (never in the website, never in git).
DEFAULT_ENV_FILE = BACKEND_DIR / ".env"
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
# Chosen after a benchmark on a GTX 1660 Ti (6 GB): fast (about 70 tokens/s, first sentence after
# about 0.3 s), fits fully on the graphics card, and good in all five languages.
DEFAULT_MODEL = "gemma3:4b"

LanguageCode = Literal["az", "tr", "de", "en", "ru"]
ProviderName = Literal["claude", "ollama"]


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    mode: Mode = "free"
    language: LanguageCode = "de"
    explain_language: LanguageCode | None = None
    action: Action = "reply"
    messages: list[Message] = Field(default_factory=list, max_length=200)
    # None = Claude when a key is set, otherwise Ollama
    provider: ProviderName | None = None
    # Ollama model (Claude always uses claude-opus-5-5)
    model: str | None = Field(default=None, max_length=100)


class WarmupRequest(BaseModel):
    provider: ProviderName | None = None
    model: str | None = Field(default=None, max_length=100)


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=value lines; # comments and empty lines are ignored, quotes around values removed."""
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value.strip()
    return values


def _line(data: dict[str, object]) -> bytes:
    return (json.dumps(data, ensure_ascii=False) + "\n").encode("utf-8")


def _error(e: ProviderError) -> JSONResponse:
    return JSONResponse(status_code=e.http_status, content={"code": e.code, "message": e.message})


def create_app(
    provider: ChatProvider | None = None,
    model: str | None = None,
    site_dir: Path | None = None,
    env_file: Path | None = None,
    claude_client: ClientFactory = default_client,
) -> FastAPI:
    ollama = provider or OllamaProvider(os.environ.get("OLLAMA_URL", DEFAULT_OLLAMA_URL))
    default_model = model or os.environ.get("AI_TALK_MODEL", DEFAULT_MODEL)
    site_dir = site_dir or DEFAULT_SITE_DIR
    env_file = env_file or DEFAULT_ENV_FILE
    app = FastAPI(title="AI Talk API", version="0.2.0")
    claude_cache: dict[str, ClaudeProvider] = {}

    def claude() -> ClaudeProvider:
        """Reads the key on every request, so a key pasted into .env works without a restart."""
        key = read_env_file(env_file).get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY", "")
        key = key.strip()
        if key not in claude_cache:
            claude_cache.clear()
            claude_cache[key] = ClaudeProvider(key, claude_client)
        return claude_cache[key]

    def choose(name: ProviderName | None) -> ChatProvider:
        if name == "ollama":
            return ollama
        if name == "claude":
            return claude()
        return claude() if claude().configured else ollama

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "app": "ai-talk"}

    @app.get("/api/status")
    async def status() -> dict[str, object]:
        s = await ollama.status()
        has_key = claude().configured
        return {
            # the AI used when the page does not choose one
            "default_provider": "claude" if has_key else "ollama",
            # never the key itself, only whether there is one
            "claude": {"configured": has_key, "model": CLAUDE_MODEL},
            "provider": ollama.name,
            "running": s.running,
            "version": s.version,
            "model": default_model,
            "model_installed": default_model in s.models,
            "models": s.models,
            "languages": LANGUAGES,
        }

    @app.post("/api/warmup")
    async def warmup(body: WarmupRequest) -> JSONResponse:
        chosen_provider = choose(body.provider)
        chosen = CLAUDE_MODEL if chosen_provider.name == "claude" else (body.model or default_model)
        started = time.perf_counter()
        try:
            await chosen_provider.warmup(chosen)
        except ProviderError as e:
            return _error(e)
        return JSONResponse(
            {"provider": chosen_provider.name, "model": chosen, "seconds": round(time.perf_counter() - started, 2)}
        )

    @app.post("/api/chat", response_model=None)
    async def chat(body: ChatRequest) -> StreamingResponse | JSONResponse:
        """Streams the answer as JSON lines: {"type": "token", "text": ...} ... {"type": "done", ...}."""
        if body.action == "reply" and (not body.messages or body.messages[-1].role != "user"):
            raise HTTPException(status_code=422, detail="the last message must be from the user")
        history: list[ChatMessage] = [{"role": m.role, "content": m.content} for m in body.messages]
        messages = build_messages(body.mode, body.language, history, body.action, body.explain_language)
        options = generation_options(body.mode, history, body.action)
        chosen_provider = choose(body.provider)
        chosen_model = CLAUDE_MODEL if chosen_provider.name == "claude" else (body.model or default_model)
        events = chosen_provider.stream(chosen_model, messages, options)

        # Wait for the first piece before answering: when the AI cannot answer (no key, Ollama off,
        # model missing, no credit ...), the page gets a normal error response with an explanation
        # instead of a broken stream.
        try:
            first = await anext(events)
        except ProviderError as e:
            return _error(e)
        except StopAsyncIteration:
            first = None

        async def body_lines() -> AsyncIterator[bytes]:
            pending = [first] if first is not None else []
            try:
                for event in pending:
                    yield _event_line(event, chosen_provider.name)
                async for event in events:
                    yield _event_line(event, chosen_provider.name)
            except ProviderError as e:
                yield _line({"type": "error", "code": e.code, "message": e.message})

        return StreamingResponse(
            body_lines(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Built website (npm run build). Unknown paths get index.html.
    if (site_dir / "index.html").is_file():
        root = site_dir.resolve()

        @app.get("/{path:path}", include_in_schema=False)
        def site(path: str) -> FileResponse:
            if path.startswith("api/"):
                raise HTTPException(status_code=404)
            candidate = (root / path).resolve()
            if path and candidate.is_file() and candidate.is_relative_to(root):
                return FileResponse(candidate)
            return FileResponse(root / "index.html")

    return app


def _event_line(event: Token | Finished, provider: str) -> bytes:
    if isinstance(event, Token):
        return _line({"type": "token", "text": event.text})
    done: dict[str, object] = {
        "type": "done",
        "provider": provider,
        "model": event.model,
        "tokens": event.tokens,
        "seconds": event.seconds,
    }
    if event.cost is not None:
        done["cost"] = event.cost
    return _line(done)


app = create_app()
