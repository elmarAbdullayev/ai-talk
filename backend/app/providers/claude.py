"""Claude (Anthropic API) in the cloud: the main AI when an API key is set. Costs money per answer."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Callable
from typing import Any

import anthropic

from .base import ChatMessage, Finished, GenerationOptions, ProviderError, ProviderStatus, StreamEvent, Token

CLAUDE_MODEL = "claude-opus-5-5"

# Opus 5.5 always thinks; `low` keeps the thinking short so Leon starts talking quickly.
# The interview feedback is a single longer answer, it may think a bit more.
EFFORT_TALK = "low"
EFFORT_FEEDBACK = "medium"

# max_tokens counts the hidden thinking too, so it must be much larger than the spoken answer.
# The answer itself is kept short by the prompt.
MAX_TOKENS = 8000
MAX_TOKENS_FEEDBACK = 12000

# On a safety decline, the API retries the same request on the model Anthropic recommends.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

# Prices of Claude Opus 5.5 in US dollars per million tokens (for the cost shown in the app).
PRICE_INPUT = 4.00
PRICE_OUTPUT = 20.00
PRICE_CACHE_READ = 0.20
PRICE_CACHE_WRITE = 5.00

MISSING_KEY = (
    "No Claude API key yet. Open backend\\.env in the AI Talk folder, paste your key after "
    "ANTHROPIC_API_KEY= and save the file (no restart needed). Or switch to Ollama in the settings."
)

ClientFactory = Callable[[str], Any]


def default_client(api_key: str) -> anthropic.AsyncAnthropic:
    # one retry only: in a live conversation a quick clear message beats a long silent wait
    return anthropic.AsyncAnthropic(api_key=api_key, max_retries=1, timeout=anthropic.Timeout(120.0, connect=10.0))


def to_claude_request(messages: list[ChatMessage]) -> tuple[str, list[dict[str, str]]]:
    """Turns the prompt from prompts.build_messages into Claude's top-level system + messages.

    The reminders stay as mid-conversation `system` messages where the API allows them (right after
    a user message). A note that does not follow a user message (the start note, or the feedback
    note after Leon's own question) becomes a user message instead. The mapping is deterministic, so
    every prompt still starts with the previous one and the prompt cache keeps working.
    """
    if not messages or messages[0]["role"] != "system":
        raise ValueError("the first message must be the system prompt")
    system = messages[0]["content"]
    out: list[dict[str, str]] = []
    for m in messages[1:]:
        role = m["role"]
        if role == "system" and (not out or out[-1]["role"] != "user"):
            role = "user"
        out.append({"role": role, "content": m["content"]})
    return system, out


def estimate_cost(usage: Any) -> float:
    """US dollars for one answer (thinking tokens are part of the output tokens)."""

    def tokens(name: str) -> int:
        return int(getattr(usage, name, 0) or 0)

    return (
        tokens("input_tokens") * PRICE_INPUT
        + tokens("output_tokens") * PRICE_OUTPUT
        + tokens("cache_read_input_tokens") * PRICE_CACHE_READ
        + tokens("cache_creation_input_tokens") * PRICE_CACHE_WRITE
    ) / 1_000_000


def explain(error: Exception) -> ProviderError:
    """A clear message for each problem; the page offers the switch to Ollama."""
    if isinstance(error, anthropic.APITimeoutError):
        return ProviderError("timeout", "Claude took too long to answer. Try again, or switch to Ollama.", 504)
    if isinstance(error, anthropic.APIConnectionError):
        return ProviderError(
            "network", "Claude cannot be reached. Check the internet connection, or switch to Ollama.", 503
        )
    if not isinstance(error, anthropic.APIStatusError):
        return ProviderError("failed", f"Claude failed: {error}", 502)
    status = error.status_code
    kind = getattr(error, "type", None) or ""
    text = str(getattr(error, "message", "") or error)
    if isinstance(error, anthropic.AuthenticationError):
        return ProviderError(
            "auth", "The Claude API key was rejected (401). Check the key in backend\\.env, or switch to Ollama.", 401
        )
    if status == 402 or kind == "billing_error" or "credit balance" in text.lower():
        return ProviderError(
            "billing",
            "Your Anthropic credit is used up. Add credit in the Anthropic Console (Billing), or switch to Ollama.",
            402,
        )
    if isinstance(error, anthropic.PermissionDeniedError):
        return ProviderError("forbidden", f"This API key may not use {CLAUDE_MODEL} (403). Or switch to Ollama.", 403)
    if isinstance(error, anthropic.NotFoundError):
        return ProviderError("model_missing", f"The model {CLAUDE_MODEL} is not available for this API key.", 404)
    if isinstance(error, anthropic.RateLimitError):
        if "spend limit" in text.lower() or type(error).__name__ == "EnforcedSpendLimitReachedError":
            return ProviderError(
                "spend_limit",
                "Your monthly Anthropic spend limit is reached. Raise it in the Anthropic Console, or switch to Ollama.",
                429,
            )
        return ProviderError(
            "rate_limit", "Too many requests to Claude right now (429). Wait a moment, or switch to Ollama.", 429
        )
    if status >= 500:
        return ProviderError("overloaded", "Claude is busy right now. Try again in a moment, or switch to Ollama.", 503)
    return ProviderError("bad_request", f"Claude rejected the request ({status}): {text}", 400)


class ClaudeProvider:
    name = "claude"

    def __init__(self, api_key: str | None, client_factory: ClientFactory = default_client) -> None:
        self.api_key = (api_key or "").strip() or None
        self._client = client_factory(self.api_key) if self.api_key else None

    @property
    def configured(self) -> bool:
        return self._client is not None

    async def status(self) -> ProviderStatus:
        # no API call here: checking the key would need a request; problems show up on the first answer
        return ProviderStatus(running=self.configured, models=[CLAUDE_MODEL] if self.configured else [])

    async def warmup(self, model: str) -> None:
        if not self.configured:
            raise ProviderError("no_key", MISSING_KEY, 400)

    async def stream(
        self, model: str, messages: list[ChatMessage], options: GenerationOptions
    ) -> AsyncIterator[StreamEvent]:
        if self._client is None:
            raise ProviderError("no_key", MISSING_KEY, 400)
        system, conversation = to_claude_request(messages)
        long_answer = options.long_answer
        started = time.perf_counter()
        try:
            async with self._client.beta.messages.stream(
                model=CLAUDE_MODEL,
                max_tokens=MAX_TOKENS_FEEDBACK if long_answer else MAX_TOKENS,
                system=system,
                messages=conversation,
                output_config={"effort": EFFORT_FEEDBACK if long_answer else EFFORT_TALK},
                cache_control={"type": "ephemeral"},
                betas=[FALLBACK_BETA],
                fallbacks="default",
            ) as stream:
                async for text in stream.text_stream:
                    if text:
                        yield Token(text)
                final = await stream.get_final_message()
        except anthropic.APIError as e:
            raise explain(e) from e
        if final.stop_reason == "refusal":
            # a partial answer before a decline is not a real answer: the page throws it away
            raise ProviderError("refusal", "Claude declined to answer this. Try saying it differently.", 400)
        yield Finished(
            model=final.model,
            tokens=int(getattr(final.usage, "output_tokens", 0) or 0),
            seconds=round(time.perf_counter() - started, 2),
            cost=round(estimate_cost(final.usage), 5),
        )
