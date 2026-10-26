"""Trusted, opt-in Grok Voice broker, installed outside Hermes' source tree.

Hermes supplies dashboard authentication and profile/secret scoping when this
router is mounted. OAuth access/refresh credentials remain server-side. Only a
300-second xAI client secret crosses the renderer boundary on an explicit POST.
No tool registration, billing change, provider switch or API-key fallback.
"""
from __future__ import annotations

import math
import json
import os
import re
import tempfile
import time
from typing import Literal

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

CLIENT_SECRETS_URL = "https://api.x.ai/v1/realtime/client_secrets"
REALTIME_URL = "wss://api.x.ai/v1/realtime"
DEFAULT_MODEL = "grok-voice-latest"
DEFAULT_VOICE = "eve"
SECRET_TTL_SECONDS = 300

# Kept in the extension: importing the OpenAI voice implementation would make
# our independent broker depend on an unrelated provider module's internals.
INSTRUCTIONS = (
    "You are Hermes, a calm and friendly voice assistant. Speak naturally. "
    "Par défaut, parlez français naturellement, sans accent anglais, et vouvoyez "
    "votre interlocuteur. Suivez sa langue s’il en utilise une autre. "
    "Stop speaking when the user interrupts. Listen to the correction. "
    "For facts, current information, careful reasoning, or any request to do, "
    "check, find, make, fix, run or remember something, use hermes_task first. "
    "Hermes is the agent with tools and memory; you are its voice interface. "
    "Small talk, greetings, clarifications and repeating a prior result need "
    "no delegation. A tool receipt is not the result: never invent success. "
    "The answer arrives later in a message labelled [Hermes result]. Read it "
    "naturally. If a task was queued, failed or cannot be correlated, tell the "
    "user to consult the Hermes conversation rather than inventing an answer. "
    "Delegate corrections as complete requests again. Never claim a queued "
    "request was cancelled. Only use end_call after a clear goodbye or an "
    "explicit request to hang up."
)
TOOLS = [
    {
        "type": "function", "name": "hermes_task",
        "description": "Give Hermes a complete request; the result arrives later as [Hermes result].",
        "parameters": {
            "type": "object", "properties": {"request": {"type": "string"}},
            "required": ["request"], "additionalProperties": False,
        },
    },
    {
        "type": "function", "name": "end_call",
        "description": "End the call only after a clear goodbye or explicit request to hang up.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


class GrokVoiceError(Exception):
    """Fixed credential-free messages only. Never wrap a provider response body."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def resolve_grok_live_status() -> dict:
    from hermes_cli.auth import get_provider_auth_state, read_credential_pool

    def configured(entry):
        return (
            isinstance(entry, dict)
            and entry.get("last_status") != "dead"
            and any(isinstance(entry.get(key), str) and entry[key].strip()
                    for key in ("access_token", "refresh_token"))
        )

    try:
        entries = read_credential_pool("xai-oauth")
        state = get_provider_auth_state("xai-oauth") or {}
        marker = state.get("last_auth_error") or {}
        available = any(
            isinstance(entry, dict) and configured(entry) and entry.get("auth_type") == "oauth"
            for entry in entries
        ) or (not marker.get("relogin_required") and configured(state.get("tokens")))
    except Exception:
        available = False
    return {
        "available": bool(available), "model": DEFAULT_MODEL, "voice": DEFAULT_VOICE,
        "message": None if available else "Connectez Grok par OAuth sur ce profil Hermes.",
    }


def create_grok_live_session() -> dict:
    from hermes_cli.auth import resolve_xai_oauth_runtime_credentials
    from tools.xai_http import hermes_xai_user_agent

    try:
        credentials = resolve_xai_oauth_runtime_credentials()
    except Exception:
        raise GrokVoiceError("Connexion OAuth Grok requise sur ce profil Hermes.", 503) from None
    token = credentials.get("api_key")
    if credentials.get("provider") != "xai-oauth" or not isinstance(token, str) or not token:
        raise GrokVoiceError("Connexion OAuth Grok requise, sans repli sur une clé API.", 503)
    try:
        with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as client:
            response = client.post(
                CLIENT_SECRETS_URL,
                headers={"Authorization": f"Bearer {token}", "User-Agent": hermes_xai_user_agent()},
                json={"expires_after": {"seconds": SECRET_TTL_SECONDS}},
            )
            if response.status_code != 200:
                raise GrokVoiceError(f"xAI a refusé la session vocale (HTTP {response.status_code}).")
            body = response.json()
    except GrokVoiceError:
        raise
    except Exception:
        raise GrokVoiceError("Impossible de joindre xAI pour démarrer la conversation vocale.") from None
    value = body.get("value") if isinstance(body, dict) else None
    expires = body.get("expires_at") if isinstance(body, dict) else None
    now = time.time()
    if (
        not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9._~-]{1,4096}", value) is None
        or value == token
        or not isinstance(expires, (int, float)) or isinstance(expires, bool)
        or not math.isfinite(expires) or not now < expires <= now + SECRET_TTL_SECONDS + 30
    ):
        raise GrokVoiceError("Réponse de session xAI invalide.")
    return {
        "url": f"{REALTIME_URL}?model={DEFAULT_MODEL}",
        "protocol_prefix": "xai-client-secret.",
        "client_secret": {"value": value, "expires_at": int(expires)},
        "model": DEFAULT_MODEL,
        "session": {
            "voice": DEFAULT_VOICE, "instructions": INSTRUCTIONS,
            "reasoning": {"effort": "none"},
            "turn_detection": {"type": "server_vad"}, "tools": TOOLS,
            "audio": {
                "input": {"format": {"type": "audio/pcm", "rate": 24000}},
                "output": {"format": {"type": "audio/pcm", "rate": 24000}},
            },
        },
    }


router = APIRouter()


class DesktopHealth(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phase: Literal["registered", "ready", "unavailable", "scope-mismatch", "unsupported"]


def _health_dir():
    from hermes_cli.config import get_hermes_home
    return get_hermes_home() / "cache" / "scratch" / "grok-voice-oauth"


def _reply(payload: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status, headers={"Cache-Control": "no-store"})


def _profile_error(profile: str | None) -> JSONResponse | None:
    # The host's profile-scope dependency performs existence/permission checks.
    # We additionally refuse implicit or ambient credentials for this broker.
    if not profile or profile != profile.strip() or profile == "current":
        return _reply({"ok": False, "message": "Un profil Hermes explicite est requis."}, 422)
    return None


@router.get("/status")
def status(profile: str | None = None):
    error = _profile_error(profile)
    if error is not None:
        return error
    return _reply({"ok": True, **resolve_grok_live_status()})


@router.post("/session")
def session(profile: str | None = None):
    error = _profile_error(profile)
    if error is not None:
        return error
    try:
        return _reply({"ok": True, **create_grok_live_session()})
    except GrokVoiceError as exc:
        return _reply({"ok": False, "message": str(exc)}, exc.status)
    except Exception:
        return _reply({"ok": False, "message": "Service vocal indisponible sur ce profil Hermes."}, 503)


@router.post("/diagnostics")
def desktop_health(body: DesktopHealth, profile: str | None = None):
    error = _profile_error(profile)
    if error is not None:
        return error
    # Local verification without screen access. Deliberately no arbitrary
    # text, owner IDs, credentials, transcript, provider response or audio.
    directory = _health_dir()
    directory.mkdir(parents=True, exist_ok=True)
    data = {"version": "0.2.0-rc.1", "phase": body.phase, "received_at": time.time()}
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as stream:
        json.dump(data, stream)
        temporary = stream.name
    os.replace(temporary, directory / "desktop-health.json")
    return _reply({"ok": True})
