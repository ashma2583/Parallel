"""
Phase 5. Audio goes to Grok Voice Transcribe. The transcript becomes a JSON
policy via Gemini or Grok (same XAI_API_KEY as voice and Imagine). A keyword
parser covers the case where neither key is set.

POLICY_PARSER:
    auto    Gemini if GEMINI_API_KEY is set, otherwise Grok, otherwise keywords
    grok    always Grok
    gemini  always Gemini
    keyword never call a model
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

from agents.logic import keyword_policy
from graph import CampusGraph

log = logging.getLogger("parallel.voice")

STT_URL = "https://api.x.ai/v1/stt"
STT_MODEL = "grok-voice-transcribe-2.0"
CHAT_URL = "https://api.x.ai/v1/chat/completions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_ACTIONS = {"fail", "restore", "reset", "none"}


def gemini_configured() -> bool:
    return bool(_gemini_key())


def xai_configured() -> bool:
    return bool(_xai_key())


def policy_parser() -> str:
    """Which parser the next order will actually use."""
    choice = os.getenv("POLICY_PARSER", "auto").strip().lower()
    if choice == "keyword":
        return "keyword"
    if choice == "grok":
        return "grok" if xai_configured() else "keyword"
    if choice == "gemini":
        return "gemini" if gemini_configured() else "keyword"
    if gemini_configured():
        return "gemini"
    if xai_configured():
        return "grok"
    return "keyword"


async def transcribe(audio: bytes, filename: str, content_type: str) -> str:
    key = os.getenv("XAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("XAI_API_KEY is not set")
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            STT_URL,
            headers={"Authorization": f"Bearer {key}"},
            files={"file": (filename or "speech.webm", audio, content_type or "audio/webm")},
            data={"model": STT_MODEL},
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"speech-to-text {resp.status_code}: {resp.text[:300]}")
    text = (resp.json().get("text") or "").strip()
    if not text:
        raise RuntimeError("transcription was empty")
    return text


async def parse_policy(graph: CampusGraph, text: str) -> dict[str, Any]:
    """Model when a key is set, otherwise the keyword parser. Model errors fall back too."""
    which = policy_parser()
    if which == "keyword":
        policy = keyword_policy(text)
        policy["parser"] = "keyword"
        return policy
    try:
        if which == "grok":
            policy = await _grok(graph, text, _xai_key())
        else:
            policy = await _gemini(graph, text, _gemini_key())
        policy["parser"] = which
        return policy
    except Exception as exc:  # noqa: BLE001 - demo should still do something
        log.warning("%s parse failed, using keyword fallback: %s", which, exc)
        policy = keyword_policy(text)
        policy["parser"] = "keyword"
        policy["parser_error"] = f"{type(exc).__name__}: {exc}"
        return policy


def _prompt(graph: CampusGraph, text: str) -> str:
    catalog = "\n".join(
        f"- {n.id}: {n.name} ({n.type.value}, priority {n.priority.name.lower()})"
        for n in graph.nodes.values()
    )
    return (
        "You convert an emergency director's spoken order into a campus grid action.\n"
        "Reply with JSON only, no markdown.\n"
        "Use only node ids from this list:\n"
        f"{catalog}\n\n"
        "action is one of: fail, restore, reset, none.\n"
        "fail takes nodes offline. restore brings specific nodes back. "
        "reset clears every failure. none when the utterance is not a grid order.\n"
        "A campus-wide grid collapse means node_ids [cpp, uh, north_switch]. "
        "City Hall, Blake Transit Center, and Fire Station 1 stay up unless named.\n"
        'Shape: {"summary": str, "action": str, "node_ids": [str], "reason": str}\n\n'
        f'Utterance: "{text}"'
    )


async def _grok(graph: CampusGraph, text: str, key: str) -> dict[str, Any]:
    model = os.getenv("GROK_MODEL", "grok-4")
    async with httpx.AsyncClient(timeout=40) as client:
        resp = await client.post(
            CHAT_URL,
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": _prompt(graph, text)}],
                "response_format": {"type": "json_object"},
            },
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"grok {resp.status_code}: {resp.text[:300]}")
    raw = resp.json()["choices"][0]["message"]["content"]
    return _coerce(json.loads(_strip_fence(raw)))


async def _gemini(graph: CampusGraph, text: str, key: str) -> dict[str, Any]:
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    prompt = _prompt(graph, text)
    schema = {
        "type": "OBJECT",
        "properties": {
            "summary": {"type": "STRING"},
            "action": {"type": "STRING", "enum": ["fail", "restore", "reset", "none"]},
            "node_ids": {"type": "ARRAY", "items": {"type": "STRING"}},
            "reason": {"type": "STRING"},
        },
        "required": ["summary", "action", "node_ids", "reason"],
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            GEMINI_URL.format(model=model),
            params={"key": key},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema},
            },
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"gemini {resp.status_code}: {resp.text[:300]}")
    body = resp.json()
    parts = body["candidates"][0]["content"]["parts"]
    raw = "".join(part.get("text", "") for part in parts)
    return _coerce(json.loads(raw))


def _coerce(parsed: dict[str, Any]) -> dict[str, Any]:
    if parsed.get("action") not in _ACTIONS:
        parsed["action"] = "none"
    parsed["node_ids"] = list(parsed.get("node_ids") or [])
    parsed["summary"] = str(parsed.get("summary") or "")
    parsed["reason"] = str(parsed.get("reason") or "")
    return parsed


def _strip_fence(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        text = text.removesuffix("```").strip()
    return text


def _xai_key() -> str:
    return os.getenv("XAI_API_KEY", "").strip()


def _gemini_key() -> str:
    return (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip()
