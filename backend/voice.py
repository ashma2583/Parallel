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
_ACTIONS = {"fail", "restore", "reset", "heat_wave", "none"}


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


def is_heat_wave_order(text: str) -> bool:
    """Spoken or typed ask to run the four-hour heat build, not to fail a building."""
    t = text.lower()
    return any(phrase in t for phrase in ("heat wave", "heatwave", "heat-wave", "simulate the heat", "start a heat"))


async def parse_policy(graph: CampusGraph, text: str) -> dict[str, Any]:
    """Model when a key is set, otherwise the keyword parser. Model errors fall back too."""
    if is_heat_wave_order(text):
        return {
            "action": "heat_wave",
            "node_ids": [],
            "reason": text.strip(),
            "summary": "Start a four-hour heat wave",
            "parser": "keyword",
        }
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
        "action is one of: fail, restore, reset, heat_wave, none.\n"
        "fail takes nodes offline. restore brings specific nodes back. "
        "reset clears every failure. heat_wave starts the four-hour heat build and leaves node_ids empty. "
        "none when the utterance is not a grid order.\n"
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
            "action": {"type": "STRING", "enum": ["fail", "restore", "reset", "heat_wave", "none"]},
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


async def write_debrief(facts: dict[str, Any]) -> dict[str, Any]:
    """After-action summary. Uses only the snapshot the simulation just handed over."""
    key = _xai_key()
    if not key:
        raise RuntimeError("XAI_API_KEY is not set")
    model = os.getenv("GROK_MODEL", "grok-4")
    prompt = (
        "You are the after-action analyst for PARALLEL, the University of Michigan emergency desk.\n"
        "The director has already run a scenario. Write the debrief from the facts only.\n"
        "Do not invent buildings, bus lines, causes, or numbers that are not in the facts.\n"
        "preference is the response policy: tiered sheds the lowest priority tier first, residential keeps dorms, "
        "academic keeps classes, people keeps the buildings with the most people per kilowatt, even rations every building equally.\n"
        "A bus listed under reroute no longer stops at the dark buildings in skip, and still stops at the lit buildings in keep.\n"
        "people_now is who is in class right now, by building, at the slot named in it; each node's people count follows the class schedule. "
        "Name the students at stake in any dark building, using those counts.\n"
        "Reply with JSON only, no markdown, in this shape:\n"
        '{"headline": str, "grid": str, "options": [str], "buses": str, "solutions": [str], "watch": str}\n'
        "headline: one sentence on the situation.\n"
        "grid: what happened on the power grid, two to four sentences.\n"
        "options: three short choices still open, such as restore a feed or change who is protected.\n"
        "buses: how the U-M lines are affected, two or three sentences.\n"
        "solutions: three concrete next actions.\n"
        "watch: one sentence on people, cooling, the hospital, or research that still needs a decision.\n\n"
        f"Facts:\n{json.dumps(facts)}"
    )
    async with httpx.AsyncClient(timeout=45) as client:
        resp = await client.post(
            CHAT_URL,
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "response_format": {"type": "json_object"},
            },
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"grok {resp.status_code}: {resp.text[:300]}")
    raw = resp.json()["choices"][0]["message"]["content"]
    parsed = json.loads(_strip_fence(raw))
    return {
        "headline": str(parsed.get("headline") or ""),
        "grid": str(parsed.get("grid") or ""),
        "options": [str(item) for item in (parsed.get("options") or [])][:4],
        "buses": str(parsed.get("buses") or ""),
        "solutions": [str(item) for item in (parsed.get("solutions") or [])][:4],
        "watch": str(parsed.get("watch") or ""),
    }


def verdict_from_numbers(facts: dict[str, Any]) -> str:
    """One paragraph from the sim's own counts, used when the model is unavailable."""
    policies = [p for p in facts.get("policies") or [] if isinstance(p, dict)]
    winner = next((p for p in policies if p.get("id") == facts.get("winner")), policies[0] if policies else None)
    if not winner:
        return "Run the heat wave, then compare the five policies."
    kind = "cooling center" if facts.get("shelter") == "cooling" or facts.get("season") == "summer" else "warming center"
    shelter = int(winner.get("people_in_shelter") or 0)
    dark = int(winner.get("people_dark") or 0)
    kw = int(winner.get("shelter_kw") or 0)
    moved = int(winner.get("people_relocated") or 0)
    dark_line = (
        f"{dark:,} people are still in a dark building."
        if dark
        else "Nobody is left in a dark building; the transit agent has moved them."
    )
    return (
        f"{winner.get('label')} keeps {shelter:,} people in a lit {kind}, with {kw:,} kW serving those buildings. "
        f"{moved:,} people had to leave where they started. {dark_line} "
        "The hospital stays on either way. These kilowatts are a scaled model of the three real campus intakes."
    )


async def write_verdict(facts: dict[str, Any]) -> dict[str, Any]:
    """One paragraph on the winning policy. Numbers stay the ones the sim computed."""
    fallback = verdict_from_numbers(facts)
    key = _xai_key()
    if not key:
        return {"paragraph": fallback, "source": "sim"}
    model = os.getenv("GROK_MODEL", "grok-4")
    prompt = (
        "You are the coordinator for PARALLEL, a University of Michigan emergency desk.\n"
        "A heat wave has already derated the campus. Five policies were run on copies of the same campus.\n"
        "Write one paragraph, four sentences at most, about the winning policy.\n"
        "Use only the numbers and policy names in the facts. Do not invent buildings, causes, or costs.\n"
        "If shelter is cooling, call them cooling centers. If it is warming, call them warming centers.\n"
        "Say how many people the winner keeps in a lit shelter, how many kilowatts serve those shelters, "
        "and how many people are still in a dark building.\n"
        "If people_dark is 0, say the transit agent has already moved everyone out of dark buildings.\n"
        "people_now, if present, is who is in class right now; you may name the busiest building and its student count.\n"
        "Reply with JSON only: {\"paragraph\": str}\n\n"
        f"Facts:\n{json.dumps(facts)}"
    )
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            resp = await client.post(
                CHAT_URL,
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "response_format": {"type": "json_object"},
                },
            )
        if resp.status_code >= 400:
            return {"paragraph": fallback, "source": "sim"}
        raw = resp.json()["choices"][0]["message"]["content"]
        parsed = json.loads(_strip_fence(raw))
        paragraph = str(parsed.get("paragraph") or "").strip()
        if not paragraph:
            return {"paragraph": fallback, "source": "sim"}
        return {"paragraph": paragraph, "source": "model"}
    except (httpx.HTTPError, KeyError, json.JSONDecodeError, TypeError, ValueError):
        return {"paragraph": fallback, "source": "sim"}


async def write_plans(facts: dict[str, Any]) -> dict[str, Any]:
    """Five ranked response plans. Scores are relative. The facts stay the sim's."""
    key = _xai_key()
    if not key:
        raise RuntimeError("XAI_API_KEY is not set")
    model = os.getenv("GROK_MODEL", "grok-4")
    prompt = (
        "You are the coordinator for PARALLEL, the University of Michigan emergency desk.\n"
        "A building or feed has already failed. Energy, transit, and infrastructure have reported in the facts.\n"
        "Write exactly 5 different response plans for emergency staff and campus admins.\n"
        "Each plan must say what the energy agent should do with scarce kilowatts, which buses to skip or keep, "
        "what infrastructure bottleneck or cascade matters, and the one intervention to try.\n"
        "Use only buildings, kilowatts, people, and bus lines that appear in the facts. Do not invent dollar costs.\n"
        "people_now is who is in class right now, by building, at the slot named in it. "
        "Prefer plans that keep the buildings with the most students lit, and say how many students a plan protects.\n"
        "University Hospital and Mott are never shed. If a feed has no supply left, changing who is protected cannot keep that feed's buildings on.\n"
        "The season in the facts chooses the shelter: summer means cooling centers, every other season means warming centers.\n"
        "Scores are integers from 1 to 10, and higher is better on every score. "
        "cost 10 means cheapest to carry out. risk 10 means safest. energy 10 means the scarce kilowatts are used best. "
        "people 10 means the fewest people are left in a dark or exposed building.\n"
        "apply is tiered, residential, academic, people, even, or none. "
        "tiered protects the hospital only. residential keeps dorms. academic keeps classes. "
        "people keeps the most people per kilowatt. even rations every building the same share. "
        "Use none when the plan is not one of those policies.\n"
        "Reply with JSON only:\n"
        '{"plans":[{"title":str,"summary":str,"energy":str,"transit":str,"infrastructure":str,'
        '"intervention":str,"analysis":str,"apply":str,'
        '"scores":{"optimal":int,"energy":int,"feasibility":int,"cost":int,"risk":int,"people":int}}]}\n\n'
        f"Facts:\n{json.dumps(facts)}"
    )
    async with httpx.AsyncClient(timeout=50) as client:
        resp = await client.post(
            CHAT_URL,
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "response_format": {"type": "json_object"},
            },
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"grok {resp.status_code}: {resp.text[:300]}")
    raw = resp.json()["choices"][0]["message"]["content"]
    parsed = json.loads(_strip_fence(raw))
    return {"season": str(facts.get("season") or "fall"), "plans": _rank_plans(parsed.get("plans") or [])}


def _rank_plans(raw: list[Any]) -> list[dict[str, Any]]:
    keys = ("optimal", "energy", "feasibility", "cost", "risk", "people")
    plans = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        source = item.get("scores") if isinstance(item.get("scores"), dict) else {}
        scores = {}
        for key in keys:
            try:
                scores[key] = max(1, min(10, int(source.get(key))))
            except (TypeError, ValueError):
                scores[key] = 5
        apply = str(item.get("apply") or "none")
        apply = {"balanced": "tiered", "dorms": "residential"}.get(apply, apply)
        if apply not in {"tiered", "residential", "academic", "people", "even"}:
            apply = None
        plans.append({
            "title": str(item.get("title") or "Plan"),
            "summary": str(item.get("summary") or ""),
            "energy": str(item.get("energy") or ""),
            "transit": str(item.get("transit") or ""),
            "infrastructure": str(item.get("infrastructure") or ""),
            "intervention": str(item.get("intervention") or ""),
            "analysis": str(item.get("analysis") or ""),
            "apply": apply,
            "scores": scores,
            "total": round(sum(scores.values()) / len(keys), 1),
        })
    plans.sort(key=lambda plan: plan["total"], reverse=True)
    for index, plan in enumerate(plans[:5], start=1):
        plan["rank"] = index
    return plans[:5]


def _xai_key() -> str:
    return os.getenv("XAI_API_KEY", "").strip()


def _gemini_key() -> str:
    return (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip()
