"""
One research pass for a place the director wants to add.

A campus or district comes back as the 15–20 buildings that matter in an
outage, plus the core transit lines between them. A single building comes
back as that building and the lines that serve it. There is no load estimate.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from voice import _strip_fence, _xai_key

RESPONSES_URL = "https://api.x.ai/v1/responses"

ROLES = {"power", "hospital", "housing", "academic", "research", "transit", "civic"}
MAX_BUILDINGS = 20
MAX_LINES = 8


async def research_location(query: str) -> dict[str, Any]:
    key = _xai_key()
    if not key:
        raise RuntimeError("XAI_API_KEY is not set")
    model = os.getenv("GROK_RESEARCH_MODEL") or os.getenv("GROK_MODEL", "grok-4")
    prompt = (
        "You research one place for a campus emergency desk. Use web search.\n"
        "If the request is a campus, city, or district, return the 15 to 20 buildings "
        "that matter most when the power fails: the utility or power plant, the hospital, "
        "the largest housing, the main academic buildings, and the transit hub.\n"
        "If the request is a single building, return that building only, plus the core "
        "transit lines that stop there. Do not pad the list.\n"
        "Transit means the few lines that connect those buildings, not every route in the city.\n"
        "Coordinates must be ones you can support. Omit a building if you do not know where it is.\n"
        "Search at most twice, then answer. Do not invent electrical loads, ridership, or population counts.\n"
        "Reply with JSON only:\n"
        '{"name": str, "summary": str, '
        '"buildings": [{"name": str, "role": str, "why": str, "lat": number, "lng": number}], '
        '"transit": [{"name": str, "agency": str, "connects": str}]}\n'
        "role is one of: power, hospital, housing, academic, research, transit, civic.\n"
        "why is one sentence on why this building is in the set.\n\n"
        f"Place: {query.strip()}"
    )
    body = await _complete(model, key, prompt)
    if body is None and model != "grok-4.7":
        body = await _complete("grok-4.7", key, prompt)
    if body is None:
        raise RuntimeError("location research failed")
    parsed = _json_object(body["content"])
    return _clean(parsed, body.get("citations") or [])


async def _complete(model: str, key: str, prompt: str) -> dict[str, Any] | None:
    payload = {
        "model": model,
        "input": prompt,
        "tools": [{"type": "web_search"}],
        "max_output_tokens": 1800,
    }
    async with httpx.AsyncClient(timeout=40) as client:
        resp = await client.post(RESPONSES_URL, headers={"Authorization": f"Bearer {key}"}, json=payload)
    if resp.status_code >= 400:
        return None
    data = resp.json()
    texts: list[str] = []
    citations: list[str] = []
    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        for block in item.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("text"):
                texts.append(str(block["text"]))
            for note in block.get("annotations") or []:
                if isinstance(note, dict) and note.get("url"):
                    citations.append(str(note["url"]))
    for url in data.get("citations") or []:
        if isinstance(url, str):
            citations.append(url)
    content = "\n".join(texts).strip()
    if not content:
        return None
    return {"content": content, "citations": citations}


def _clean(parsed: dict[str, Any], citations: list[Any]) -> dict[str, Any]:
    buildings = []
    for raw in parsed.get("buildings") or []:
        if not isinstance(raw, dict):
            continue
        lat = _coord(raw.get("lat"), -90, 90)
        lng = _coord(raw.get("lng"), -180, 180)
        name = str(raw.get("name") or "").strip()
        if lat is None or lng is None or not name:
            continue
        role = str(raw.get("role") or "civic").strip().lower()
        buildings.append({
            "name": name,
            "role": role if role in ROLES else "civic",
            "why": str(raw.get("why") or "").strip(),
            "lat": lat,
            "lng": lng,
        })
        if len(buildings) == MAX_BUILDINGS:
            break

    transit = []
    for raw in parsed.get("transit") or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        transit.append({
            "name": name,
            "agency": str(raw.get("agency") or "").strip(),
            "connects": str(raw.get("connects") or "").strip(),
        })
        if len(transit) == MAX_LINES:
            break

    sources = []
    for item in citations:
        url = item if isinstance(item, str) else str((item or {}).get("url") or "")
        url = url.strip()
        if url.startswith("http") and url not in sources:
            sources.append(url)
        if len(sources) == 6:
            break

    return {
        "name": str(parsed.get("name") or "").strip(),
        "summary": str(parsed.get("summary") or "").strip(),
        "buildings": buildings,
        "transit": transit,
        "sources": sources,
    }


def _json_object(text: str) -> dict[str, Any]:
    raw = _strip_fence(text)
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        raw = raw[start : end + 1]
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("location research did not return an object")
    return parsed


def _coord(value: Any, low: float, high: float) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < low or number > high:
        return None
    return number
