"""The seam between the app and an AI service.

Only Ollama (local, free) is built. A paid provider (for example the Claude API) can be added
later as another class with the same three methods, chosen in `main.create_app`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal, Protocol, TypedDict


class ChatMessage(TypedDict):
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class GenerationOptions:
    # temperature and the token limit are for Ollama; Claude Opus 5.5 does not accept a temperature
    # and needs a much larger limit because its hidden thinking counts too
    temperature: float = 0.7
    max_tokens: int = 220
    context_tokens: int = 4096
    # one longer answer (the interview feedback)
    long_answer: bool = False


@dataclass(frozen=True)
class Token:
    """A piece of the answer text as soon as the model produced it."""

    text: str


@dataclass(frozen=True)
class Finished:
    model: str
    tokens: int = 0
    seconds: float = 0.0
    # estimated price of the answer in US dollars (paid providers only)
    cost: float | None = None


StreamEvent = Token | Finished


@dataclass(frozen=True)
class ProviderStatus:
    running: bool
    models: list[str] = field(default_factory=list)
    version: str | None = None


class ProviderError(Exception):
    """A problem with the AI service that the page can explain to the user."""

    def __init__(self, code: str, message: str, http_status: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


class ChatProvider(Protocol):
    name: str

    async def status(self) -> ProviderStatus: ...

    async def warmup(self, model: str) -> None:
        """Load the model into memory so the first answer starts fast."""
        ...

    def stream(
        self, model: str, messages: list[ChatMessage], options: GenerationOptions
    ) -> AsyncIterator[StreamEvent]:
        """Yields Token events and one Finished event. Raises ProviderError before the first token
        when the service is not reachable or the model is missing."""
        ...
