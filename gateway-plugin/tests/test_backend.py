"""Offline contract tests. Every credential and provider response is synthetic."""
import importlib.util
import json
import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

SPEC = importlib.util.spec_from_file_location(
    "grok_voice_plugin_test", Path(__file__).parents[1] / "dashboard" / "plugin_api.py"
)
voice = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = voice
SPEC.loader.exec_module(voice)


@pytest.mark.parametrize("state,available", [
    ({}, False),
    ({"providers": {"xai-oauth": {"tokens": {"refresh_token": "synthetic-refresh"}}}}, True),
    ({"credential_pool": {"xai-oauth": [{"auth_type": "oauth", "access_token": "synthetic-access"}]}}, True),
    ({"providers": {"xai-oauth": {"tokens": {"access_token": "synthetic-access"}, "last_auth_error": {"relogin_required": True}}}}, False),
    ({"credential_pool": {"xai-oauth": [{"auth_type": "oauth", "access_token": "synthetic-access", "last_status": "dead"}]}}, False),
])
def test_readiness_is_nonmutating(monkeypatch, state, available):
    from hermes_cli import auth
    monkeypatch.setattr(auth, "get_provider_auth_state", lambda _: state.get("providers", {}).get("xai-oauth"))
    monkeypatch.setattr(auth, "read_credential_pool", lambda _: state.get("credential_pool", {}).get("xai-oauth", []))
    monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda: pytest.fail("no refresh on status"))
    monkeypatch.setattr(voice.httpx, "Client", lambda **kw: pytest.fail("no network on status"))
    result = voice.resolve_grok_live_status()
    assert result["available"] is available
    assert "synthetic" not in json.dumps(result)


def mock_mint(monkeypatch, body=None, status=200):
    from hermes_cli import auth
    monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda: {
        "provider": "xai-oauth", "api_key": "synthetic-private-oauth", "base_url": "https://untrusted.invalid"
    })
    requests = []
    real_client = httpx.Client
    def respond(request):
        requests.append(request)
        return httpx.Response(status, json=body if body is not None else {
            "value": "synthetic-ephemeral", "expires_at": int(time.time()) + 300
        }, headers={"location": "https://untrusted.invalid"})
    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs["trust_env"] is False
        return real_client(transport=httpx.MockTransport(respond), **kwargs)
    monkeypatch.setattr(voice.httpx, "Client", client)
    return requests


def test_fixed_origin_short_lived_secret_only(monkeypatch):
    requests = mock_mint(monkeypatch)
    result = voice.create_grok_live_session()
    assert len(requests) == 1
    assert str(requests[0].url) == "https://api.x.ai/v1/realtime/client_secrets"
    assert requests[0].headers["authorization"] == "Bearer synthetic-private-oauth"
    assert json.loads(requests[0].content) == {"expires_after": {"seconds": 300}}
    assert "synthetic-private-oauth" not in json.dumps(result)
    assert result["client_secret"]["value"] == "synthetic-ephemeral"
    assert result["url"] == "wss://api.x.ai/v1/realtime?model=grok-voice-latest"
    assert result["protocol_prefix"] == "xai-client-secret."
    assert result["session"]["audio"]["input"]["format"]["rate"] == 24000
    assert {tool["name"] for tool in result["session"]["tools"]} == {"hermes_task", "end_call"}


@pytest.mark.parametrize("provider", ["xai", "openrouter", None])
def test_no_api_key_fallback(monkeypatch, provider):
    from hermes_cli import auth
    monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda: {
        "provider": provider, "api_key": "synthetic-private-api-key"
    })
    monkeypatch.setattr(voice.httpx, "Client", lambda **kw: pytest.fail("must not send API key"))
    with pytest.raises(voice.GrokVoiceError):
        voice.create_grok_live_session()


@pytest.mark.parametrize("status", [302, 401, 403, 429, 500])
def test_no_redirects_or_provider_error_leaks(monkeypatch, status):
    requests = mock_mint(monkeypatch, body={"error": "synthetic-private-oauth"}, status=status)
    with pytest.raises(voice.GrokVoiceError) as caught:
        voice.create_grok_live_session()
    assert len(requests) == 1
    assert "synthetic" not in str(caught.value)


@pytest.mark.parametrize("body", [
    {"value": "synthetic-private-oauth", "expires_at": time.time() + 300},
    {"value": "synthetic-ephemeral", "expires_at": 1},
    {"value": "synthetic-ephemeral", "expires_at": time.time() + 9999},
    {"value": "bad secret with spaces", "expires_at": time.time() + 300},
    {"value": "synthetic-ephemeral", "expires_at": True},
    {"value": "synthetic-ephemeral", "expires_at": float("inf")},
    {"value": "synthetic-ephemeral"}, [],
])
def test_invalid_credentials_rejected(monkeypatch, body):
    if isinstance(body, dict) and body.get("expires_at") == float("inf"):
        # Real JSON cannot encode inf with httpx; exercise via a direct mock response.
        from hermes_cli import auth
        monkeypatch.setattr(auth, "resolve_xai_oauth_runtime_credentials", lambda: {
            "provider": "xai-oauth", "api_key": "synthetic-private-oauth"
        })
        class Client:
            def __init__(self, **kw): pass
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def post(self, *a, **kw): return type("Response", (), {"status_code": 200, "json": lambda _: body})()
        monkeypatch.setattr(voice.httpx, "Client", Client)
    else:
        mock_mint(monkeypatch, body=body)
    with pytest.raises(voice.GrokVoiceError):
        voice.create_grok_live_session()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(voice.router, prefix="/api/plugins/grok-voice-oauth")
    return TestClient(app)


@pytest.mark.parametrize("profile", [None, "", "current", " "])
def test_routes_require_explicit_profile(client, profile):
    query = {} if profile is None else {"profile": profile}
    assert client.get("/api/plugins/grok-voice-oauth/status", params=query).status_code == 422
    assert client.post("/api/plugins/grok-voice-oauth/session", params=query, json={}).status_code == 422


def test_api_success_and_no_store(client, monkeypatch):
    monkeypatch.setattr(voice, "resolve_grok_live_status", lambda: {"available": True})
    response = client.get("/api/plugins/grok-voice-oauth/status?profile=default")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "available": True}
    assert response.headers["cache-control"] == "no-store"
    monkeypatch.setattr(voice, "create_grok_live_session", lambda: {"client_secret": {"value": "synthetic-ephemeral"}})
    response = client.post("/api/plugins/grok-voice-oauth/session?profile=default", json={})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"


def test_unexpected_api_error_is_sanitized(client, monkeypatch):
    def fail(): raise RuntimeError("synthetic-private-oauth")
    monkeypatch.setattr(voice, "create_grok_live_session", fail)
    response = client.post("/api/plugins/grok-voice-oauth/session?profile=default", json={})
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert "synthetic" not in response.text


def test_diagnostics_only_persist_allowlisted_health(client, monkeypatch, tmp_path):
    monkeypatch.setattr(voice, "_health_dir", lambda: tmp_path)
    response = client.post("/api/plugins/grok-voice-oauth/diagnostics?profile=default", json={"phase": "ready"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    saved = json.loads((tmp_path / "desktop-health.json").read_text())
    assert set(saved) == {"phase", "version", "received_at"}
    assert saved["phase"] == "ready"
    assert saved["received_at"] > 0


@pytest.mark.parametrize("body", [{"phase": "arbitrary-transcript"}, {"phase": "ready", "token": "synthetic-private"}])
def test_diagnostics_reject_unknown_content(client, monkeypatch, tmp_path, body):
    monkeypatch.setattr(voice, "_health_dir", lambda: tmp_path)
    response = client.post("/api/plugins/grok-voice-oauth/diagnostics?profile=default", json=body)
    assert response.status_code == 422
    assert not (tmp_path / "desktop-health.json").exists()
