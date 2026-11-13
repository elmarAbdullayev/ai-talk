"""The chat endpoint with Ollama replaced by a fake (httpx.MockTransport): no real AI needed."""

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.providers.ollama import OllamaProvider


def ollama_lines(*pieces: str, eval_count: int = 7) -> bytes:
    lines = [{"model": "gemma3:4b", "message": {"role": "assistant", "content": p}, "done": False} for p in pieces]
    lines.append({"model": "gemma3:4b", "message": {"role": "assistant", "content": ""}, "done": True, "eval_count": eval_count})
    return b"".join(json.dumps(line).encode() + b"\n" for line in lines)


class FakeOllama:
    """Records what the app sent and answers like Ollama would."""

    def __init__(self, chat_body: bytes = b"", chat_status: int = 200, offline: bool = False, models=("gemma3:4b",)):
        self.chat_body = chat_body
        self.chat_status = chat_status
        self.offline = offline
        self.models = models
        self.requests: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.offline:
            raise httpx.ConnectError("connection refused", request=request)
        body = json.loads(request.content) if request.content else {}
        self.requests.append((request.url.path, body))
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": m} for m in self.models]})
        if request.url.path == "/api/version":
            return httpx.Response(200, json={"version": "0.30.0"})
        if request.url.path == "/api/generate":
            if body.get("model") not in self.models:
                return httpx.Response(404, json={"error": "model not found"})
            return httpx.Response(200, json={"done": True})
        if request.url.path == "/api/chat":
            if self.chat_status != 200:
                return httpx.Response(self.chat_status, json={"error": f"model \"{body['model']}\" not found"})
            return httpx.Response(200, content=self.chat_body, headers={"Content-Type": "application/x-ndjson"})
        return httpx.Response(404)


def no_claude(api_key: str):
    raise AssertionError("these tests must never create a Claude client")


@pytest.fixture(autouse=True)
def no_real_key(monkeypatch):
    # a key in the environment would make Claude the default AI
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def client_for(fake: FakeOllama) -> TestClient:
    provider = OllamaProvider("http://ollama.test", transport=httpx.MockTransport(fake))
    app = create_app(provider=provider, model="gemma3:4b", env_file=Path("does-not-exist.env"), claude_client=no_claude)
    return TestClient(app)


def read_stream(client: TestClient, payload: dict) -> list[dict]:
    with client.stream("POST", "/api/chat", json=payload) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        return [json.loads(line) for line in response.iter_lines() if line.strip()]


def test_chat_streams_tokens_then_done():
    fake = FakeOllama(ollama_lines("Hallo", " Elmar!", " Wie geht's?"))
    events = read_stream(client_for(fake), {"mode": "free", "language": "de", "messages": [{"role": "user", "content": "Hallo"}]})
    assert [e["text"] for e in events if e["type"] == "token"] == ["Hallo", " Elmar!", " Wie geht's?"]
    assert events[-1] == {
        "type": "done",
        "provider": "ollama",
        "model": "gemma3:4b",
        "tokens": 7,
        "seconds": events[-1]["seconds"],
    }


def test_chat_sends_the_built_prompt_and_options_to_ollama():
    fake = FakeOllama(ollama_lines("Ok."))
    read_stream(
        client_for(fake),
        {"mode": "teacher", "language": "de", "explain_language": "az", "messages": [{"role": "user", "content": "Ich habe gegeht"}]},
    )
    path, sent = fake.requests[-1]
    assert path == "/api/chat"
    assert sent["model"] == "gemma3:4b"
    assert sent["stream"] is True
    assert sent["keep_alive"] == "30m"
    assert sent["messages"][0]["role"] == "system"
    assert "YOU SAID:" in sent["messages"][0]["content"]
    assert sent["messages"][1] == {"role": "user", "content": "Ich habe gegeht"}
    assert sent["options"]["num_predict"] == 260


def test_chat_can_use_another_installed_model():
    fake = FakeOllama(ollama_lines("Hi"), models=("gemma3:4b", "llama3.2:3b"))
    read_stream(client_for(fake), {"model": "llama3.2:3b", "messages": [{"role": "user", "content": "Hi"}]})
    assert fake.requests[-1][1]["model"] == "llama3.2:3b"


def test_start_action_needs_no_user_message():
    fake = FakeOllama(ollama_lines("Guten Tag!"))
    events = read_stream(client_for(fake), {"mode": "interview", "language": "de", "action": "start", "messages": []})
    assert events[0] == {"type": "token", "text": "Guten Tag!"}


def test_reply_needs_a_user_message_last():
    response = client_for(FakeOllama()).post("/api/chat", json={"messages": [{"role": "assistant", "content": "Hi"}]})
    assert response.status_code == 422


def test_chat_explains_when_ollama_is_not_running():
    response = client_for(FakeOllama(offline=True)).post("/api/chat", json={"messages": [{"role": "user", "content": "Hi"}]})
    assert response.status_code == 503
    assert response.json()["code"] == "offline"
    assert "ollama serve" in response.json()["message"]


def test_chat_explains_a_missing_model():
    response = client_for(FakeOllama(chat_status=404)).post("/api/chat", json={"messages": [{"role": "user", "content": "Hi"}]})
    assert response.status_code == 404
    assert response.json()["code"] == "model_missing"
    assert "ollama pull gemma3:4b" in response.json()["message"]


def test_an_error_in_the_middle_of_the_stream_becomes_an_error_line():
    body = ollama_lines("Hallo")[:-1].rsplit(b"\n", 1)[0] + b"\n" + json.dumps({"error": "out of memory"}).encode() + b"\n"
    events = read_stream(client_for(FakeOllama(body)), {"messages": [{"role": "user", "content": "Hi"}]})
    assert events[0] == {"type": "token", "text": "Hallo"}
    assert events[-1]["type"] == "error"
    assert "out of memory" in events[-1]["message"]


def test_rejects_unknown_language_and_mode():
    client = client_for(FakeOllama())
    assert client.post("/api/chat", json={"language": "fr", "messages": [{"role": "user", "content": "x"}]}).status_code == 422
    assert client.post("/api/chat", json={"mode": "poem", "messages": [{"role": "user", "content": "x"}]}).status_code == 422


def test_status_reports_models_and_hides_embedding_models():
    fake = FakeOllama(models=("gemma3:4b", "nomic-embed-text:latest", "deepseek-r1:7b"))
    data = client_for(fake).get("/api/status").json()
    assert data["default_provider"] == "ollama"
    assert data["claude"] == {"configured": False, "model": "claude-opus-5-5"}
    assert data["running"] is True
    assert data["model"] == "gemma3:4b"
    assert data["model_installed"] is True
    assert data["models"] == ["deepseek-r1:7b", "gemma3:4b"]
    assert data["version"] == "0.30.0"


def test_status_when_ollama_is_off():
    data = client_for(FakeOllama(offline=True)).get("/api/status").json()
    assert data["running"] is False
    assert data["model_installed"] is False


@pytest.mark.parametrize(
    ("fake", "status", "code"),
    [(FakeOllama(), 200, None), (FakeOllama(offline=True), 503, "offline"), (FakeOllama(models=()), 404, "model_missing")],
)
def test_warmup(fake, status, code):
    response = client_for(fake).post("/api/warmup", json={})
    assert response.status_code == status
    if code:
        assert response.json()["code"] == code
    else:
        assert response.json()["model"] == "gemma3:4b"
