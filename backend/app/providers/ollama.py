"""Local AI with Ollama (https://ollama.com): free, runs on the laptop's graphics card."""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator

import httpx

from .base import (
    ChatMessage,
    Finished,
    GenerationOptions,
    ProviderError,
    ProviderStatus,
    StreamEvent,
    Token,
)

# Models that only make embeddings cannot chat; they are hidden from the model list.
EMBEDDING_HINTS = ("embed", "bge-", "minilm")

# Keep the model in the graphics card's memory between answers (loading takes seconds).
KEEP_ALIVE = "30m"

OFFLINE_MESSAGE = (
    "Ollama is not running. Start it from the Windows Start menu (Ollama) "
    "or run `ollama serve` in a terminal, then try again."
)


def chat_models(names: list[str]) -> list[str]:
    return [n for n in names if not any(h in n.lower() for h in EMBEDDING_HINTS)]


class OllamaProvider:
    name = "ollama"

    def __init__(self, base_url: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        # Use 127.0.0.1, not "localhost": on Windows "localhost" tries IPv6 first and
        # every request waits about 2 seconds before it falls back to IPv4.
        self.base_url = base_url.rstrip("/")
        self._transport = transport

    def _client(self, read_timeout: float = 120.0) -> httpx.AsyncClient:
        timeout = httpx.Timeout(connect=3.0, read=read_timeout, write=10.0, pool=5.0)
        return httpx.AsyncClient(base_url=self.base_url, timeout=timeout, transport=self._transport)

    async def status(self) -> ProviderStatus:
        try:
            async with self._client(read_timeout=5.0) as client:
                tags = await client.get("/api/tags")
                tags.raise_for_status()
                names = [m.get("name", "") for m in tags.json().get("models", [])]
                version = None
                try:
                    v = await client.get("/api/version")
                    version = v.json().get("version")
                except (httpx.HTTPError, ValueError):
                    pass
                return ProviderStatus(running=True, models=sorted(chat_models(names)), version=version)
        except (httpx.HTTPError, ValueError):
            return ProviderStatus(running=False)

    async def warmup(self, model: str) -> None:
        # a generate call without a prompt only loads the model; with the same context size as the
        # chat calls, otherwise Ollama loads it a second time (several seconds) for the first answer
        payload = {"model": model, "keep_alive": KEEP_ALIVE, "options": {"num_ctx": GenerationOptions().context_tokens}}
        try:
            async with self._client() as client:
                r = await client.post("/api/generate", json=payload)
        except httpx.ConnectError as e:
            raise ProviderError("offline", OFFLINE_MESSAGE, 503) from e
        except httpx.HTTPError as e:
            raise ProviderError("failed", f"Ollama did not answer: {e}", 502) from e
        if r.status_code == 404:
            raise ProviderError("model_missing", missing_message(model), 404)
        if r.status_code >= 400:
            raise ProviderError("failed", f"Ollama error {r.status_code}: {r.text[:200]}", 502)

    async def stream(
        self, model: str, messages: list[ChatMessage], options: GenerationOptions
    ) -> AsyncIterator[StreamEvent]:
        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
            "keep_alive": KEEP_ALIVE,
            "options": {
                "temperature": options.temperature,
                "num_predict": options.max_tokens,
                "num_ctx": options.context_tokens,
            },
        }
        started = time.perf_counter()
        tokens = 0
        try:
            async with self._client() as client:
                async with client.stream("POST", "/api/chat", json=payload) as response:
                    if response.status_code == 404:
                        raise ProviderError("model_missing", missing_message(model), 404)
                    if response.status_code >= 400:
                        body = (await response.aread()).decode("utf-8", "replace")[:300]
                        raise ProviderError("failed", f"Ollama error {response.status_code}: {body}", 502)
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            data = json.loads(line)
                        except ValueError:
                            continue
                        if data.get("error"):
                            raise ProviderError("failed", f"Ollama error: {data['error']}", 502)
                        piece = (data.get("message") or {}).get("content") or ""
                        if piece:
                            yield Token(piece)
                        if data.get("done"):
                            tokens = int(data.get("eval_count") or 0)
                            break
        except httpx.ConnectError as e:
            raise ProviderError("offline", OFFLINE_MESSAGE, 503) from e
        except httpx.TimeoutException as e:
            raise ProviderError("timeout", "Ollama took too long to answer.", 504) from e
        except httpx.HTTPError as e:
            raise ProviderError("failed", f"Connection to Ollama failed: {e}", 502) from e
        yield Finished(model=model, tokens=tokens, seconds=round(time.perf_counter() - started, 2))


def missing_message(model: str) -> str:
    return f"The model {model} is not installed. Run `ollama pull {model}` in a terminal, then try again."
