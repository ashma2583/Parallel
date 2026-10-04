"""
One place for every language-model call, so a provider that is down, slow,
rate-limited or unkeyed never takes a feature with it.

    result = await complete_json(system, user, providers=["grok", "claude"], timeout=8)
    if result is None:      # every provider failed: use the deterministic answer
        ...
    data, provider = result

Providers are tried in the order given. Each gets its own timeout, and the whole
chain has a total cap. The functions never raise: when nothing answers they
return None and the caller falls back to its keyword parser or template.

Providers
    grok    xAI chat completions        XAI_API_KEY        GROK_MODEL (grok-4)
    asi     ASI:One chat completions    ASI_ONE_API_KEY    ASI_MODEL (asi1-mini)
    claude  Anthropic Messages API      ANTHROPIC_API_KEY  LLM_CLAUDE_MODEL (claude-sonnet-5-5)
    gemini  Google generateContent      GEMINI_API_KEY     GEMINI_MODEL (gemini-2.5-flash)

Knobs (all optional)
    LLM_DISABLE=grok,asi   skip these providers, for example when one is down on stage
    LLM_CLAUDE_EFFORT=low      reasoning depth for Claude (empty string leaves it to the API)
    LLM_TIMEOUT_S, LLM_TOTAL_S   default per-provider and whole-chain limits
    LLM_GROK_URL, LLM_ASI_URL, LLM_CLAUDE_URL   override a provider's endpoint

Pass `schema` (a plain JSON Schema) to complete_json and Claude is held to it with
structured outputs, so its reply is always valid JSON; Gemini gets the same schema
converted to its dialect. Grok and ASI:One use JSON mode and the prompt.

A provider that times out is moved to the back of the line for 30 seconds at
once, and one that fails fast twice in a row (HTTP error, network) the same, so
a hung provider costs the demo one slow answer, not every answer. A reply that arrives but is unusable (not JSON, or
rejected by the caller's `accept`) does not count as the provider being down.
Keys are read from the environment on every call and never logged.

Voice transcription is not here: it stays on Grok only (voice.transcribe).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterable

import httpx

log = logging.getLogger("parallel.llm")

# LLM_GROK_URL / LLM_ASI_URL / LLM_CLAUDE_URL point a provider somewhere else
# (a dead port rehearses an outage). Read on every call.
GROK_URL = "https://api.x.ai/v1/chat/completions"
ASI_URL = "https://api.asi1.ai/v1/chat/completions"
CLAUDE_URL = "https://api.anthropic.com/v1/messages"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
ANTHROPIC_VERSION = "2023-06-01"

DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5"
DEFAULT_CHAIN = ("grok", "claude")
JSON_ONLY = "Reply with one JSON object only: no markdown, no code fence, no commentary."

FAIL_THRESHOLD = 2  # consecutive transport failures before a provider is parked
COOLDOWN_S = 30.0

_SECRET_ENV = ("XAI_API_KEY", "ASI_ONE_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY")


class ProviderError(Exception):
    """A provider could not give an answer (HTTP error, empty or refused reply)."""


class ProviderTimeout(ProviderError):
    """The provider did not answer in time (httpx's own timeout fired first)."""


@dataclass
class Provider:
    name: str
    configured: Callable[[], bool]
    call: Callable[..., Awaitable[str]]  # (system, user, *, json_mode, max_tokens, schema, timeout) -> text


# ----------------------------------------------------------------------- helpers
def _key(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _scrub(message: str) -> str:
    """Remove any configured key from text that is about to be logged."""
    for name in _SECRET_ENV:
        value = os.getenv(name, "").strip()
        if len(value) >= 8:
            message = message.replace(value, "***")
    return message


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        return default


async def _post(url: str, headers: dict[str, str], body: dict[str, Any], timeout: float, who: str) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, headers=headers, json=body)
    except httpx.TimeoutException as exc:
        raise ProviderTimeout(f"{who} {type(exc).__name__}") from None
    except httpx.HTTPError as exc:
        raise ProviderError(f"{who} {type(exc).__name__}") from None
    if resp.status_code >= 400:
        raise ProviderError(f"{who} HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        data = resp.json()
    except ValueError:
        raise ProviderError(f"{who} returned non-JSON") from None
    if not isinstance(data, dict):
        raise ProviderError(f"{who} returned an unexpected body")
    return data


def _chat_text(data: dict[str, Any], who: str) -> str:
    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ProviderError(f"{who} reply had no message") from None
    text = (text or "").strip() if isinstance(text, str) else ""
    if not text:
        raise ProviderError(f"{who} reply was empty")
    return text


# ----------------------------------------------------------------- schema dialects
def _strict(schema: Any) -> Any:
    """JSON Schema for Claude structured outputs: every object closed with additionalProperties false."""
    if isinstance(schema, dict):
        out = {k: _strict(v) for k, v in schema.items()}
        if out.get("type") == "object":
            out["additionalProperties"] = False
        return out
    if isinstance(schema, list):
        return [_strict(v) for v in schema]
    return schema


def _gemini_schema(schema: Any) -> Any:
    """The same JSON Schema in Gemini's dialect: upper-case type names, no additionalProperties."""
    if isinstance(schema, dict):
        return {
            k: (v.upper() if k == "type" and isinstance(v, str) else _gemini_schema(v))
            for k, v in schema.items()
            if k != "additionalProperties"
        }
    if isinstance(schema, list):
        return [_gemini_schema(v) for v in schema]
    return schema


# --------------------------------------------------------------------- providers
def _messages(system: str, user: str) -> list[dict[str, str]]:
    out = [{"role": "system", "content": system}] if system else []
    out.append({"role": "user", "content": user})
    return out


async def _grok(system: str, user: str, *, json_mode: bool, max_tokens: int | None, schema: Any, timeout: float) -> str:
    # max_tokens is not sent: Grok 4 reasons before it answers and the reasoning
    # counts against the cap, which can leave the visible reply empty.
    body: dict[str, Any] = {"model": os.getenv("GROK_MODEL", "grok-4"), "messages": _messages(system, user)}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    data = await _post(os.getenv("LLM_GROK_URL") or GROK_URL, {"Authorization": f"Bearer {_key('XAI_API_KEY')}"}, body, timeout, "grok")
    return _chat_text(data, "grok")


async def _asi(system: str, user: str, *, json_mode: bool, max_tokens: int | None, schema: Any, timeout: float) -> str:
    body: dict[str, Any] = {
        "model": os.getenv("ASI_MODEL", "asi1-mini"),
        "messages": _messages(system, user),
        "temperature": 0.1,
    }
    if max_tokens:
        body["max_tokens"] = max_tokens
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    data = await _post(os.getenv("LLM_ASI_URL") or ASI_URL, {"Authorization": f"Bearer {_key('ASI_ONE_API_KEY')}"}, body, timeout, "asi")
    return _chat_text(data, "asi")


async def _claude(system: str, user: str, *, json_mode: bool, max_tokens: int | None, schema: Any, timeout: float) -> str:
    # Messages API. No temperature (the current models reject non-default values)
    # and no prefill (also rejected), so JSON comes from the system prompt.
    model = os.getenv("LLM_CLAUDE_MODEL", "").strip() or DEFAULT_CLAUDE_MODEL
    body: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens or 2048,
        "messages": [{"role": "user", "content": user}],
    }
    effort = os.getenv("LLM_CLAUDE_EFFORT", "low").strip().lower()
    if model.startswith("claude-sonnet-5-5") and effort in {"", "low", "medium", "high"}:
        # Answer straight away. With thinking on, reasoning tokens count against
        # max_tokens and a tight cap can leave no text block at all. The API takes
        # between_tools only at effort high or below.
        body["thinking"] = {"type": "between_tools"}
    else:
        body["max_tokens"] += 2048  # headroom for thinking tokens
    if json_mode and not schema:
        # Only Claude needs this line: Grok and ASI:One have JSON mode, Gemini a MIME
        # type, and with a schema structured outputs already guarantee the shape.
        system = f"{system}\n{JSON_ONLY}".strip()
    if system:
        body["system"] = system
    config: dict[str, Any] = {}
    if effort and "haiku" not in model:  # Haiku 4.5 does not take an effort setting
        config["effort"] = effort
    if json_mode and schema:
        config["format"] = {"type": "json_schema", "schema": _strict(schema)}
    if config:
        body["output_config"] = config
    headers = {
        "x-api-key": _key("ANTHROPIC_API_KEY"),
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
    data = await _post(os.getenv("LLM_CLAUDE_URL") or CLAUDE_URL, headers, body, timeout, "claude")
    if data.get("stop_reason") == "refusal":
        raise ProviderError("claude declined the request")
    blocks = data.get("content")
    text = "".join(
        str(block.get("text") or "") for block in (blocks if isinstance(blocks, list) else [])
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()
    if not text:
        raise ProviderError("claude reply was empty")
    return text


async def _gemini(system: str, user: str, *, json_mode: bool, max_tokens: int | None, schema: Any, timeout: float) -> str:
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    body: dict[str, Any] = {"contents": [{"parts": [{"text": user}]}]}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if json_mode:
        config: dict[str, Any] = {"responseMimeType": "application/json"}
        if schema:
            config["responseSchema"] = _gemini_schema(schema)
        body["generationConfig"] = config
    # The key goes in a header, not the query string, so it cannot end up in a URL in a log.
    data = await _post(GEMINI_URL.format(model=model), {"x-goog-api-key": _key("GEMINI_API_KEY", "GOOGLE_API_KEY")}, body, timeout, "gemini")
    try:
        parts = data["candidates"][0]["content"]["parts"]
        text = "".join(str(part.get("text") or "") for part in parts).strip()
    except (KeyError, IndexError, TypeError, AttributeError):
        raise ProviderError("gemini reply had no text") from None
    if not text:
        raise ProviderError("gemini reply was empty")
    return text


REGISTRY: dict[str, Provider] = {
    "grok": Provider("grok", lambda: bool(_key("XAI_API_KEY")), _grok),
    "asi": Provider("asi", lambda: bool(_key("ASI_ONE_API_KEY")), _asi),
    "claude": Provider("claude", lambda: bool(_key("ANTHROPIC_API_KEY")), _claude),
    "gemini": Provider("gemini", lambda: bool(_key("GEMINI_API_KEY", "GOOGLE_API_KEY")), _gemini),
}


def disabled() -> set[str]:
    return {name.strip().lower() for name in os.getenv("LLM_DISABLE", "").split(",") if name.strip()}


def configured(name: str) -> bool:
    """True when the provider has a key and has not been switched off with LLM_DISABLE."""
    provider = REGISTRY.get(name)
    if provider is None or name in disabled():
        return False
    try:
        return bool(provider.configured())
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------- health tracking
_fails: dict[str, int] = {}
_parked_until: dict[str, float] = {}
_answered: dict[str, int] = {}
_failed: dict[str, int] = {}


def reset_state() -> None:
    _fails.clear()
    _parked_until.clear()
    _answered.clear()
    _failed.clear()


def status() -> dict[str, Any]:
    now = time.monotonic()
    return {
        "configured": [name for name in REGISTRY if configured(name)],
        "parked": [name for name, until in _parked_until.items() if until > now],
        "answered": dict(_answered),
        "failed": dict(_failed),
    }


def _record_ok(name: str) -> None:
    _fails[name] = 0
    _parked_until.pop(name, None)
    _answered[name] = _answered.get(name, 0) + 1


def _record_down(name: str, *, timed_out: bool = False) -> None:
    _failed[name] = _failed.get(name, 0) + 1
    _fails[name] = _fails.get(name, 0) + 1
    # A timeout is the slow failure: park at once so the next request does not wait
    # for it again. Fast failures (401, 5xx, refused) cost nothing, so they get two.
    if timed_out or _fails[name] >= FAIL_THRESHOLD:
        _parked_until[name] = time.monotonic() + COOLDOWN_S


def _order(providers: Iterable[str]) -> list[str]:
    """Configured providers in the caller's order, parked ones moved to the back."""
    seen: list[str] = []
    for name in providers:
        if name not in seen and configured(name):
            seen.append(name)
    now = time.monotonic()
    ready = [n for n in seen if _parked_until.get(n, 0) <= now]
    parked = [n for n in seen if n not in ready]
    return ready + parked


# --------------------------------------------------------------------- public API
def extract_json(text: str) -> dict[str, Any]:
    """The JSON object in a model reply, tolerating a code fence or a sentence around it."""
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].removesuffix("```").strip()
    try:
        value = json.loads(raw)
    except ValueError:
        start, end = raw.find("{"), raw.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("no JSON object in reply") from None
        value = json.loads(raw[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("reply was not a JSON object")
    return value


async def _complete(
    system: str,
    user: str,
    *,
    providers: Iterable[str] | None,
    timeout: float | None,
    total_timeout: float | None,
    max_tokens: int | None,
    schema: Any,
    accept: Callable[[Any], bool] | None,
    json_mode: bool,
    label: str,
) -> tuple[Any, str] | None:
    per_call = float(timeout) if timeout else _float_env("LLM_TIMEOUT_S", 8.0)
    total = float(total_timeout) if total_timeout else max(per_call, _float_env("LLM_TOTAL_S", 20.0))
    deadline = time.monotonic() + total
    names = _order(providers if providers is not None else DEFAULT_CHAIN)
    if not names:
        log.info("llm %s: no provider is configured, caller falls back", label or "call")
        return None
    for name in names:
        remaining = deadline - time.monotonic()
        if remaining < 0.2:
            log.warning("llm %s: total time cap reached before %s", label or "call", name)
            break
        budget = min(per_call, remaining)
        started = time.monotonic()
        try:
            raw = await asyncio.wait_for(
                REGISTRY[name].call(
                    system, user, json_mode=json_mode, max_tokens=max_tokens, schema=schema, timeout=budget,
                ),
                budget,
            )
        except (asyncio.TimeoutError, ProviderTimeout):
            # Parked at once only if it had its full slot; one cut short by the total cap is not proof it hangs.
            _record_down(name, timed_out=budget >= per_call)
            log.warning("llm %s: %s timed out after %.1fs", label or "call", name, time.monotonic() - started)
            continue
        except Exception as exc:  # noqa: BLE001 - one provider's failure must not escape
            _record_down(name)
            log.warning("llm %s: %s failed: %s", label or "call", name, _scrub(f"{type(exc).__name__}: {exc}")[:240])
            continue
        # The provider answered, so it is up; what is left is whether the answer is usable.
        _record_ok(name)
        try:
            value: Any = extract_json(raw) if json_mode else raw.strip()
            if accept is not None and not accept(value):
                raise ValueError("answer rejected")
        except Exception as exc:  # noqa: BLE001
            log.warning("llm %s: %s reply not usable (%s)", label or "call", name, _scrub(str(exc))[:120])
            continue
        log.info("llm %s: answered by %s in %.1fs", label or "call", name, time.monotonic() - started)
        return value, name
    log.warning("llm %s: no provider answered (%s)", label or "call", ", ".join(names))
    return None


async def complete_json(
    system: str,
    user: str,
    *,
    providers: Iterable[str] | None = None,
    timeout: float | None = None,
    total_timeout: float | None = None,
    max_tokens: int | None = None,
    schema: Any = None,
    accept: Callable[[dict[str, Any]], bool] | None = None,
    label: str = "",
) -> tuple[dict[str, Any], str] | None:
    """(parsed JSON object, provider that answered), or None. Never raises.

    accept(obj) -> False sends the question to the next provider. schema is a
    plain JSON Schema (type names lower case); Grok and ASI:One ignore it.
    """
    try:
        return await _complete(
            system, user, providers=providers, timeout=timeout, total_timeout=total_timeout,
            max_tokens=max_tokens, schema=schema, accept=accept, json_mode=True, label=label,
        )
    except Exception as exc:  # noqa: BLE001 - the contract is "never raise"
        log.error("llm %s: unexpected error: %s", label or "call", _scrub(f"{type(exc).__name__}: {exc}"))
        return None


async def complete_text(
    system: str,
    user: str,
    *,
    providers: Iterable[str] | None = None,
    timeout: float | None = None,
    total_timeout: float | None = None,
    max_tokens: int | None = None,
    accept: Callable[[str], bool] | None = None,
    label: str = "",
) -> tuple[str, str] | None:
    """(reply text, provider that answered), or None. Never raises."""
    try:
        return await _complete(
            system, user, providers=providers, timeout=timeout, total_timeout=total_timeout,
            max_tokens=max_tokens, schema=None, accept=accept, json_mode=False, label=label,
        )
    except Exception as exc:  # noqa: BLE001
        log.error("llm %s: unexpected error: %s", label or "call", _scrub(f"{type(exc).__name__}: {exc}"))
        return None
