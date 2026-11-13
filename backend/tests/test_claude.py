"""Claude with the real anthropic SDK, but its HTTP traffic goes to a fake server (no real API call)."""

import json
from pathlib import Path

import anthropic
import httpx
import httpx2
import pytest
from fastapi.testclient import TestClient

from app.main import create_app, read_env_file
from app.prompts import build_messages
from app.providers.claude import CLAUDE_MODEL, to_claude_request
from app.providers.ollama import OllamaProvider


def sse(*events: dict) -> bytes:
    return b"".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode() for e in events)


def answer_stream(*pieces: str, stop_reason: str = "end_turn", model: str = CLAUDE_MODEL) -> bytes:
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 1000, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
            },
        },
        # Opus 5.5 always thinks; the thinking text is empty by default
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
    ]
    events += [{"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": p}} for p in pieces]
    events += [
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": 200}},
        {"type": "message_stop"},
    ]
    return sse(*events)


def api_error(status: int, kind: str, message: str) -> httpx2.Response:
    return httpx2.Response(status, json={"type": "error", "error": {"type": kind, "message": message}})


class FakeAnthropic:
    """Answers like the Messages API and remembers what was sent."""

    def __init__(self, response=None, raise_error: Exception | None = None):
        self.response = response if response is not None else httpx2.Response(
            200, headers={"content-type": "text/event-stream"}, content=answer_stream("Hallo Elmar! ", "Wie geht's?")
        )
        self.raise_error = raise_error
        self.requests: list[tuple[dict, dict]] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        if self.raise_error:
            raise self.raise_error
        self.requests.append((json.loads(request.content), dict(request.headers)))
        return self.response

    def factory(self, api_key: str) -> anthropic.AsyncAnthropic:
        assert api_key == "sk-ant-test"
        return anthropic.AsyncAnthropic(
            api_key=api_key,
            max_retries=0,
            http_client=anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(self)),
        )


class UnusedOllama:
    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "gemma3:4b"}]})
        return httpx.Response(200, json={})


@pytest.fixture(autouse=True)
def no_real_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def make_client(tmp_path: Path, fake: FakeAnthropic, key: str | None = "sk-ant-test") -> TestClient:
    env = tmp_path / ".env"
    env.write_text(f"# test\nANTHROPIC_API_KEY={key or ''}\n", encoding="utf-8")
    ollama = OllamaProvider("http://ollama.test", transport=httpx.MockTransport(UnusedOllama()))
    return TestClient(create_app(provider=ollama, env_file=env, claude_client=fake.factory))


def chat(client: TestClient, **body) -> tuple[int, list[dict] | dict]:
    payload = {"mode": "free", "language": "de", "messages": [{"role": "user", "content": "Hallo"}], **body}
    with client.stream("POST", "/api/chat", json=payload) as response:
        if response.status_code != 200:
            response.read()
            return response.status_code, response.json()
        return 200, [json.loads(line) for line in response.iter_lines() if line.strip()]


# ---- request shape ----


def test_streams_claude_tokens_with_cost(tmp_path):
    fake = FakeAnthropic()
    status, events = chat(make_client(tmp_path, fake))
    assert status == 200
    assert [e["text"] for e in events if e["type"] == "token"] == ["Hallo Elmar! ", "Wie geht's?"]
    done = events[-1]
    assert done["type"] == "done" and done["provider"] == "claude" and done["model"] == CLAUDE_MODEL
    # 1000 input tokens at $4/M + 200 output tokens at $20/M
    assert done["cost"] == pytest.approx(0.008)


def test_request_follows_the_opus_5_5_rules(tmp_path):
    fake = FakeAnthropic()
    chat(make_client(tmp_path, fake))
    sent, headers = fake.requests[0]
    assert sent["model"] == "claude-opus-5-5"
    assert sent["stream"] is True
    # thinking cannot be switched off on Opus 5.5: no thinking settings, effort low for fast speech
    assert "thinking" not in sent
    assert sent["output_config"] == {"effort": "low"}
    # no sampling parameters (they return a 400)
    for name in ("temperature", "top_p", "top_k"):
        assert name not in sent
    # room for the hidden thinking
    assert sent["max_tokens"] >= 4000
    # prompt caching and the refusal fallback
    assert sent["cache_control"] == {"type": "ephemeral"}
    assert sent["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in headers.get("anthropic-beta", "")
    # system prompt at the top, the reminder as a mid-conversation system message after the user
    assert "Leon" in sent["system"]
    assert [m["role"] for m in sent["messages"]] == ["user", "system"]


def test_feedback_may_think_a_bit_more(tmp_path):
    fake = FakeAnthropic()
    history = [{"role": "assistant", "content": "Frage?"}, {"role": "user", "content": "Antwort."}]
    chat(make_client(tmp_path, fake), mode="interview", action="feedback", messages=history)
    sent, _ = fake.requests[0]
    assert sent["output_config"] == {"effort": "medium"}
    assert sent["max_tokens"] > 8000


def test_explicit_ollama_choice_does_not_touch_claude(tmp_path):
    fake = FakeAnthropic()
    env = tmp_path / ".env"
    env.write_text("ANTHROPIC_API_KEY=sk-ant-test\n", encoding="utf-8")

    def ollama_handler(request: httpx.Request) -> httpx.Response:
        line = {"message": {"content": "Lokal."}, "done": True, "eval_count": 2}
        return httpx.Response(200, content=json.dumps(line).encode() + b"\n")

    ollama = OllamaProvider("http://ollama.test", transport=httpx.MockTransport(ollama_handler))
    client = TestClient(create_app(provider=ollama, env_file=env, claude_client=fake.factory))
    status, events = chat(client, provider="ollama")
    assert status == 200
    assert events[0] == {"type": "token", "text": "Lokal."}
    assert events[-1]["provider"] == "ollama"
    assert fake.requests == []


# ---- key handling ----


def test_status_says_whether_a_key_is_set_but_never_shows_it(tmp_path):
    with_key = make_client(tmp_path, FakeAnthropic()).get("/api/status").json()
    assert with_key["default_provider"] == "claude"
    assert with_key["claude"] == {"configured": True, "model": CLAUDE_MODEL}
    assert "sk-ant-test" not in json.dumps(with_key)
    without = make_client(tmp_path, FakeAnthropic(), key=None).get("/api/status").json()
    assert without["default_provider"] == "ollama"
    assert without["claude"]["configured"] is False


def test_missing_key_explains_where_to_put_it(tmp_path):
    status, body = chat(make_client(tmp_path, FakeAnthropic(), key=None), provider="claude")
    assert status == 400
    assert body["code"] == "no_key"
    assert "backend\\.env" in body["message"]


def test_a_key_pasted_later_works_without_restart(tmp_path):
    fake = FakeAnthropic()
    client = make_client(tmp_path, fake, key=None)
    assert client.get("/api/status").json()["claude"]["configured"] is False
    (tmp_path / ".env").write_text('ANTHROPIC_API_KEY="sk-ant-test"\n', encoding="utf-8")
    assert client.get("/api/status").json()["claude"]["configured"] is True
    assert chat(client)[0] == 200


def test_read_env_file(tmp_path):
    env = tmp_path / ".env"
    env.write_text("﻿# comment\n\nANTHROPIC_API_KEY = 'abc' \nOTHER=1=2\nbroken line\n", encoding="utf-8")
    assert read_env_file(env) == {"ANTHROPIC_API_KEY": "abc", "OTHER": "1=2"}
    assert read_env_file(tmp_path / "missing.env") == {}


# ---- errors: each one gets a clear message ----


@pytest.mark.parametrize(
    ("response", "code", "status"),
    [
        (api_error(401, "authentication_error", "invalid x-api-key"), "auth", 401),
        (api_error(429, "rate_limit_error", "Number of requests has exceeded your rate limit"), "rate_limit", 429),
        (api_error(402, "billing_error", "Your credit balance is too low"), "billing", 402),
        (
            api_error(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."),
            "billing",
            402,
        ),
        (api_error(529, "overloaded_error", "Overloaded"), "overloaded", 503),
        (api_error(404, "not_found_error", "model: claude-opus-5-5"), "model_missing", 404),
        (api_error(400, "invalid_request_error", "messages: something odd"), "bad_request", 400),
    ],
)
def test_api_errors_become_clear_messages(tmp_path, response, code, status):
    got_status, body = chat(make_client(tmp_path, FakeAnthropic(response=response)))
    assert got_status == status
    assert body["code"] == code
    assert body["message"]


def test_network_error(tmp_path):
    fake = FakeAnthropic(raise_error=httpx2.ConnectError("no internet"))
    status, body = chat(make_client(tmp_path, fake))
    assert status == 503
    assert body["code"] == "network"


def test_refusal_before_any_text(tmp_path):
    response = httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=answer_stream(stop_reason="refusal"))
    status, body = chat(make_client(tmp_path, FakeAnthropic(response=response)))
    assert status == 400
    assert body["code"] == "refusal"


def test_refusal_after_some_text_tells_the_page_to_drop_it(tmp_path):
    response = httpx2.Response(
        200, headers={"content-type": "text/event-stream"}, content=answer_stream("Also, ", stop_reason="refusal")
    )
    status, events = chat(make_client(tmp_path, FakeAnthropic(response=response)))
    assert status == 200
    assert events[0] == {"type": "token", "text": "Also, "}
    assert events[-1]["type"] == "error" and events[-1]["code"] == "refusal"


# ---- message mapping ----


def test_mapping_puts_the_system_prompt_on_top_and_keeps_reminders_after_user_messages():
    history = [{"role": "user", "content": "Hallo"}]
    system, messages = to_claude_request(build_messages("teacher", "de", history))
    assert "German teacher" in system
    assert [m["role"] for m in messages] == ["user", "system"]


def test_mapping_turns_notes_that_follow_no_user_message_into_user_messages():
    # start: the conversation opens with Leon's greeting
    _, start = to_claude_request(build_messages("interview", "de", [], action="start"))
    assert [m["role"] for m in start] == ["user"]
    # feedback button right after Leon's question
    history = [{"role": "assistant", "content": "Guten Tag!"}, {"role": "user", "content": "Hallo"}, {"role": "assistant", "content": "Frage?"}]
    _, feedback = to_claude_request(build_messages("interview", "de", history, action="feedback"))
    assert [m["role"] for m in feedback] == ["user", "assistant", "user", "system", "assistant", "user"]
    # the API rule: a system message follows a user message and is last or followed by the assistant
    for i, m in enumerate(feedback):
        if m["role"] == "system":
            assert feedback[i - 1]["role"] == "user"
            assert i == len(feedback) - 1 or feedback[i + 1]["role"] == "assistant"


def test_two_user_messages_in_a_row_get_one_reminder():
    history = [{"role": "user", "content": "Hallo"}, {"role": "user", "content": "Bist du da?"}]
    _, messages = to_claude_request(build_messages("free", "de", history))
    assert [m["role"] for m in messages] == ["user", "user", "system"]


def test_each_claude_request_extends_the_previous_one_for_the_cache():
    for mode in ("free", "teacher", "interview"):
        history: list[dict] = []
        previous = to_claude_request(build_messages(mode, "de", history, action="start"))
        for turn in range(6):
            history += [{"role": "assistant", "content": f"Antwort {turn}"}, {"role": "user", "content": f"Satz {turn}"}]
            current = to_claude_request(build_messages(mode, "de", history))
            assert current[0] == previous[0]
            assert current[1][: len(previous[1])] == previous[1], (mode, turn)
            previous = current
