"""Fallback chains: order, timeouts, final fallback. No network; providers are fakes.

Run from backend/:  .venv/bin/python -m unittest test_llm -v
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import unittest
from unittest import mock

import uagents

import llm
import voice
from graph import CampusGraph


async def _no_publish(self, *args, **kwargs) -> None:
    """Importing the coordinator must not publish its manifest to Agentverse."""


uagents.Agent.publish_manifest = _no_publish


def run(coro):
    return asyncio.run(coro)


def fake(name: str, reply=None, *, error: Exception | None = None, delay: float = 0.0, calls: list | None = None, key_env: str = "") -> llm.Provider:
    """A provider that records its calls, then sleeps, then answers or raises."""

    async def call(system, user, *, json_mode, max_tokens, schema, timeout):
        if calls is not None:
            calls.append(name)
        if delay:
            await asyncio.sleep(delay)
        if error is not None:
            raise error
        return reply if isinstance(reply, str) else json.dumps(reply)

    return llm.Provider(name, (lambda: bool(os.getenv(key_env))) if key_env else (lambda: True), call)


class ChainCase(unittest.TestCase):
    def setUp(self) -> None:
        llm.reset_state()
        env = mock.patch.dict(os.environ, {"LLM_DISABLE": ""})
        env.start()
        self.addCleanup(env.stop)

    def chain(self, **providers: llm.Provider):
        patch = mock.patch.dict(llm.REGISTRY, providers, clear=True)
        patch.start()
        self.addCleanup(patch.stop)


class OrderTests(ChainCase):
    def test_first_provider_answers_and_the_rest_are_not_called(self) -> None:
        calls: list[str] = []
        self.chain(a=fake("a", {"n": 1}, calls=calls), b=fake("b", {"n": 2}, calls=calls))
        self.assertEqual(run(llm.complete_json("s", "u", providers=["a", "b"])), ({"n": 1}, "a"))
        self.assertEqual(calls, ["a"])

    def test_failure_falls_through_in_the_given_order(self) -> None:
        calls: list[str] = []
        self.chain(
            a=fake("a", error=RuntimeError("down"), calls=calls),
            b=fake("b", error=llm.ProviderError("HTTP 429"), calls=calls),
            c=fake("c", {"n": 3}, calls=calls),
        )
        self.assertEqual(run(llm.complete_json("s", "u", providers=["a", "b", "c"])), ({"n": 3}, "c"))
        self.assertEqual(calls, ["a", "b", "c"])

    def test_order_follows_the_caller_not_the_registry(self) -> None:
        calls: list[str] = []
        self.chain(a=fake("a", {"n": 1}, calls=calls), b=fake("b", {"n": 2}, calls=calls))
        self.assertEqual(run(llm.complete_json("s", "u", providers=["b", "a"])), ({"n": 2}, "b"))

    def test_unconfigured_and_disabled_providers_are_skipped(self) -> None:
        calls: list[str] = []
        keyless = llm.Provider("a", lambda: False, fake("a", {"n": 1}, calls=calls).call)
        self.chain(a=keyless, b=fake("b", {"n": 2}, calls=calls), c=fake("c", {"n": 3}, calls=calls))
        with mock.patch.dict(os.environ, {"LLM_DISABLE": "b"}):
            self.assertEqual(run(llm.complete_json("s", "u", providers=["a", "b", "c"])), ({"n": 3}, "c"))
        self.assertEqual(calls, ["c"])

    def test_text_returns_the_reply_and_provider(self) -> None:
        self.chain(a=fake("a", error=RuntimeError("x")), b=fake("b", "  two sentences.  "))
        self.assertEqual(run(llm.complete_text("s", "u", providers=["a", "b"])), ("two sentences.", "b"))

    def test_unusable_replies_move_on(self) -> None:
        self.chain(a=fake("a", "not json at all"), b=fake("b", {"plans": []}), c=fake("c", "```json\n{\"plans\": [1]}\n```"))
        got = run(llm.complete_json("s", "u", providers=["a", "b", "c"], accept=lambda d: bool(d.get("plans"))))
        self.assertEqual(got, ({"plans": [1]}, "c"))

    def test_json_wrapped_in_a_sentence_is_found(self) -> None:
        self.chain(a=fake("a", 'Sure! {"action": "fail"} Hope that helps.'))
        self.assertEqual(run(llm.complete_json("s", "u", providers=["a"])), ({"action": "fail"}, "a"))

    def test_accept_that_raises_counts_as_a_rejection(self) -> None:
        self.chain(a=fake("a", {"n": 1}), b=fake("b", {"n": 2}))
        got = run(llm.complete_json("s", "u", providers=["a", "b"], accept=lambda d: 1 / (d["n"] - 1) > 0))
        self.assertEqual(got, ({"n": 2}, "b"))


class TimeoutTests(ChainCase):
    def test_slow_provider_is_cut_off_and_the_next_one_answers(self) -> None:
        self.chain(a=fake("a", {"n": 1}, delay=5), b=fake("b", {"n": 2}))
        started = time.monotonic()
        got = run(llm.complete_json("s", "u", providers=["a", "b"], timeout=0.2, total_timeout=2))
        self.assertEqual(got, ({"n": 2}, "b"))
        self.assertLess(time.monotonic() - started, 1.5)

    def test_a_timeout_parks_the_provider_at_once(self) -> None:
        calls: list[str] = []
        self.chain(a=fake("a", {"n": 1}, delay=5, calls=calls), b=fake("b", {"n": 2}, calls=calls))
        run(llm.complete_json("s", "u", providers=["a", "b"], timeout=0.2, total_timeout=2))
        calls.clear()
        self.assertEqual(run(llm.complete_json("s", "u", providers=["a", "b"], timeout=0.2, total_timeout=2)), ({"n": 2}, "b"))
        self.assertEqual(calls, ["b"])  # the second request did not wait for a again

    def test_a_provider_cut_short_by_the_total_cap_is_not_parked(self) -> None:
        self.chain(a=fake("a", error=RuntimeError("down")), b=fake("b", {"n": 2}, delay=5))
        run(llm.complete_json("s", "u", providers=["a", "b"], timeout=1.0, total_timeout=0.4))
        self.assertNotIn("b", llm.status()["parked"])

    def test_total_cap_stops_the_chain(self) -> None:
        calls: list[str] = []
        self.chain(**{n: fake(n, {"n": 1}, delay=5, calls=calls) for n in "abcd"})
        started = time.monotonic()
        got = run(llm.complete_json("s", "u", providers=list("abcd"), timeout=0.3, total_timeout=0.7))
        self.assertIsNone(got)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertLess(len(calls), 4)  # the cap, not the list, ended it


class FinalFallbackTests(ChainCase):
    def test_every_provider_failing_returns_none_and_never_raises(self) -> None:
        self.chain(a=fake("a", error=RuntimeError("boom")), b=fake("b", error=ValueError("bad")), c=fake("c", "nope"))
        self.assertIsNone(run(llm.complete_json("s", "u", providers=["a", "b", "c"])))
        self.assertIsNone(run(llm.complete_text("s", "u", providers=["a", "b"])))

    def test_no_configured_provider_returns_none(self) -> None:
        self.chain(a=llm.Provider("a", lambda: False, fake("a", {}).call))
        self.assertIsNone(run(llm.complete_json("s", "u", providers=["a", "missing"])))

    def test_a_dead_provider_is_parked_so_the_next_call_skips_it(self) -> None:
        calls: list[str] = []
        self.chain(a=fake("a", error=RuntimeError("down"), calls=calls), b=fake("b", {"n": 2}, calls=calls))
        for _ in range(llm.FAIL_THRESHOLD):
            run(llm.complete_json("s", "u", providers=["a", "b"]))
        calls.clear()
        self.assertEqual(run(llm.complete_json("s", "u", providers=["a", "b"])), ({"n": 2}, "b"))
        self.assertEqual(calls, ["b"])  # a was parked behind b and never needed

    def test_a_parked_provider_is_still_the_last_resort(self) -> None:
        self.chain(a=fake("a", {"n": 1}), b=fake("b", error=RuntimeError("down")))
        llm._parked_until["a"] = time.monotonic() + 60
        self.assertEqual(run(llm.complete_json("s", "u", providers=["a", "b"])), ({"n": 1}, "a"))

    def test_rejected_answers_do_not_park_a_healthy_provider(self) -> None:
        self.chain(a=fake("a", {"n": 1}))
        for _ in range(llm.FAIL_THRESHOLD + 1):
            run(llm.complete_json("s", "u", providers=["a"], accept=lambda d: False))
        self.assertNotIn("a", llm.status()["parked"])

    def test_keys_never_reach_the_log(self) -> None:
        secret = "sk-test-secret-value-123456"
        self.chain(a=fake("a", error=RuntimeError(f"bad key {secret}")))
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": secret}):
            with self.assertLogs("parallel.llm", level="WARNING") as logs:
                run(llm.complete_json("s", "u", providers=["a"]))
        self.assertNotIn(secret, "\n".join(logs.output))


class RequestShapeTests(unittest.TestCase):
    """What actually goes over the wire, with the HTTP layer stubbed."""

    def call(self, name: str, reply: dict, extra_env: dict | None = None, **kw):
        sent: dict = {}

        async def fake_post(url, headers, body, timeout, who):
            sent.update(url=url, headers=headers, body=body)
            return reply

        env = {"ANTHROPIC_API_KEY": "test-claude-key", "XAI_API_KEY": "test-xai-key", "LLM_CLAUDE_MODEL": "", "LLM_CLAUDE_EFFORT": "low", **(extra_env or {})}
        with mock.patch.dict(os.environ, env), mock.patch.object(llm, "_post", fake_post):
            kwargs = dict(json_mode=True, max_tokens=100, schema=None, timeout=5)
            kwargs.update(kw)
            text = run(getattr(llm, f"_{name}")("be brief", "hello", **kwargs))
        return text, sent

    def test_claude_request(self) -> None:
        schema = {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "object", "properties": {}}}}
        reply = {"stop_reason": "end_turn", "content": [{"type": "thinking", "thinking": ""}, {"type": "text", "text": '{"a": "x"}'}]}
        text, sent = self.call("claude", reply, schema=schema)
        body = sent["body"]
        self.assertEqual(text, '{"a": "x"}')
        self.assertTrue(sent["url"].endswith("/v1/messages"))
        self.assertEqual((sent["headers"]["x-api-key"], sent["headers"]["anthropic-version"]), ("test-claude-key", "2023-06-01"))
        self.assertEqual((body["model"], body["max_tokens"], body["system"]), ("claude-sonnet-5-5", 100, "be brief"))
        self.assertEqual(body["messages"], [{"role": "user", "content": "hello"}])
        self.assertNotIn("temperature", body)
        self.assertEqual(body["thinking"], {"type": "between_tools"})
        self.assertEqual(body["output_config"]["effort"], "low")
        fmt = body["output_config"]["format"]
        self.assertEqual(fmt["type"], "json_schema")
        self.assertIs(fmt["schema"]["additionalProperties"], False)
        self.assertIs(fmt["schema"]["properties"]["b"]["additionalProperties"], False)

    def test_claude_refusal_and_empty_replies_are_errors(self) -> None:
        for reply in ({"stop_reason": "refusal", "content": []}, {"stop_reason": "max_tokens", "content": [{"type": "thinking"}]}):
            with self.assertRaises(llm.ProviderError):
                self.call("claude", reply)

    def test_json_line_goes_to_claude_only_when_there_is_no_schema(self) -> None:
        _, sent = self.call("claude", {"content": [{"type": "text", "text": "{}"}]})
        self.assertTrue(sent["body"]["system"].endswith(llm.JSON_ONLY))
        _, sent = self.call("claude", {"content": [{"type": "text", "text": "{}"}]}, schema={"type": "object", "properties": {}})
        self.assertEqual(sent["body"]["system"], "be brief")
        _, sent = self.call("grok", {"choices": [{"message": {"content": "{}"}}]})
        self.assertNotIn(llm.JSON_ONLY, json.dumps(sent["body"]))

    def test_high_effort_beyond_high_keeps_thinking_on(self) -> None:
        _, sent = self.call("claude", {"content": [{"type": "text", "text": "{}"}]}, extra_env={"LLM_CLAUDE_EFFORT": "xhigh"})
        self.assertNotIn("thinking", sent["body"])  # between_tools is rejected above high
        self.assertEqual(sent["body"]["output_config"]["effort"], "xhigh")

    def test_other_claude_models_get_thinking_headroom(self) -> None:
        _, sent = self.call("claude", {"content": [{"type": "text", "text": "{}"}]}, extra_env={"LLM_CLAUDE_MODEL": "claude-opus-5-5"})
        self.assertNotIn("thinking", sent["body"])
        self.assertGreater(sent["body"]["max_tokens"], 100)

    def test_grok_request_uses_json_mode_and_no_token_cap(self) -> None:
        _, sent = self.call("grok", {"choices": [{"message": {"content": "{}"}}]})
        self.assertEqual(sent["body"]["response_format"], {"type": "json_object"})
        self.assertNotIn("max_tokens", sent["body"])
        self.assertEqual(sent["headers"], {"Authorization": "Bearer test-xai-key"})

    def test_gemini_schema_is_converted(self) -> None:
        converted = llm._gemini_schema(voice._POLICY_SCHEMA)
        self.assertEqual(converted["type"], "OBJECT")
        self.assertEqual(converted["properties"]["node_ids"]["items"], {"type": "STRING"})
        self.assertNotIn("additionalProperties", json.dumps(converted))


GRAPH_KEYS = {"XAI_API_KEY": "x", "ANTHROPIC_API_KEY": "c", "GEMINI_API_KEY": "", "POLICY_PARSER": "auto", "LLM_DISABLE": ""}


class VoiceChainTests(ChainCase):
    """The real voice.py tasks with fake providers behind them."""

    def setUp(self) -> None:
        super().setUp()
        env = mock.patch.dict(os.environ, GRAPH_KEYS)
        env.start()
        self.addCleanup(env.stop)
        self.graph = CampusGraph()

    def providers(self, grok, claude, gemini=None) -> None:
        self.chain(
            grok=grok,
            claude=claude,
            gemini=gemini or llm.Provider("gemini", lambda: False, fake("gemini", {}).call),
        )

    def test_policy_goes_grok_then_claude_then_keywords(self) -> None:
        order: list[str] = []
        self.providers(
            fake("grok", error=RuntimeError("429"), calls=order),
            fake("claude", {"summary": "s", "action": "fail", "node_ids": ["cpp"], "reason": "r"}, calls=order),
        )
        policy = run(voice.parse_policy(self.graph, "the power plant is down"))
        self.assertEqual((policy["parser"], policy["action"], order), ("claude", "fail", ["grok", "claude"]))

        self.providers(fake("grok", error=RuntimeError("x")), fake("claude", error=RuntimeError("y")))
        llm.reset_state()
        policy = run(voice.parse_policy(self.graph, "fail the power plant"))
        self.assertEqual(policy["parser"], "keyword")
        self.assertIn("parser_error", policy)
        self.assertTrue(policy["action"])

    def test_policy_prefers_gemini_when_it_is_keyed(self) -> None:
        order: list[str] = []
        gemini = llm.Provider("gemini", lambda: True, fake("gemini", {"summary": "", "action": "reset", "node_ids": [], "reason": ""}, calls=order).call)
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "g"}):
            self.providers(fake("grok", {"action": "none"}, calls=order), fake("claude", {"action": "none"}, calls=order), gemini)
            self.assertEqual(voice.policy_parser(), "gemini")
            policy = run(voice.parse_policy(self.graph, "reset everything"))
        self.assertEqual((policy["parser"], order), ("gemini", ["gemini"]))

    def test_keyword_setting_never_calls_a_model(self) -> None:
        order: list[str] = []
        self.providers(fake("grok", {"action": "fail"}, calls=order), fake("claude", {"action": "fail"}, calls=order))
        with mock.patch.dict(os.environ, {"POLICY_PARSER": "keyword"}):
            policy = run(voice.parse_policy(self.graph, "fail the power plant"))
        self.assertEqual((policy["parser"], order), ("keyword", []))

    def test_parser_reports_claude_when_it_is_the_only_key(self) -> None:
        self.providers(fake("grok", {}, key_env="XAI_API_KEY"), fake("claude", {}, key_env="ANTHROPIC_API_KEY"))
        self.assertEqual(voice.policy_parser(), "grok")
        with mock.patch.dict(os.environ, {"XAI_API_KEY": "", "GEMINI_API_KEY": ""}):
            self.assertEqual(voice.policy_parser(), "claude")
        with mock.patch.dict(os.environ, {"XAI_API_KEY": "", "ANTHROPIC_API_KEY": "", "GEMINI_API_KEY": ""}):
            self.assertEqual(voice.policy_parser(), "keyword")

    def test_verdict_chain_ends_in_the_numbers(self) -> None:
        facts = {"season": "summer", "winner": "people", "policies": [
            {"id": "people", "label": "People first", "people_in_shelter": 120, "people_dark": 0, "shelter_kw": 300, "people_relocated": 40}]}
        self.providers(fake("grok", error=RuntimeError("x")), fake("claude", {"paragraph": "People first keeps 120 in a cooling center."}))
        got = run(voice.write_verdict(facts))
        self.assertEqual((got["source"], got["model"]), ("model", "claude"))
        llm.reset_state()
        self.providers(fake("grok", error=RuntimeError("x")), fake("claude", error=RuntimeError("y")))
        got = run(voice.write_verdict(facts))
        self.assertEqual(got, {"paragraph": voice.verdict_from_numbers(facts), "source": "sim"})

    def test_plans_and_debrief_use_claude_when_grok_fails_and_raise_only_when_both_do(self) -> None:
        plan = {"title": "T", "summary": "s", "apply": "people", "scores": {"optimal": 9, "energy": 8, "feasibility": 7, "cost": 6, "risk": 5, "people": 4}}
        debrief = {"headline": "h", "grid": "g", "options": ["a"], "buses": "b", "solutions": ["x"], "watch": "w"}
        self.providers(fake("grok", error=RuntimeError("x")), fake("claude", {"plans": [plan]}))
        got = run(voice.write_plans({"season": "fall"}))
        self.assertEqual((got["model"], got["plans"][0]["rank"], got["season"]), ("claude", 1, "fall"))
        self.providers(fake("grok", "garbage"), fake("claude", debrief))
        llm.reset_state()
        self.assertEqual(run(voice.write_debrief({}))["model"], "claude")
        self.providers(fake("grok", error=RuntimeError("x")), fake("claude", error=RuntimeError("y")))
        llm.reset_state()
        with self.assertRaises(RuntimeError):
            run(voice.write_plans({}))
        with self.assertRaises(RuntimeError):
            run(voice.write_debrief({}))

    def test_transcribe_stays_on_grok_only(self) -> None:
        with mock.patch.dict(os.environ, {"XAI_API_KEY": ""}):
            with self.assertRaises(RuntimeError):
                run(voice.transcribe(b"audio", "a.webm", "audio/webm"))  # no Claude fallback for speech


class CoordinatorChainTests(ChainCase):
    def setUp(self) -> None:
        super().setUp()
        try:
            from agents import asi_bureau
        except Exception as exc:  # noqa: BLE001 - uagents missing on this machine
            self.skipTest(f"coordinator not importable: {exc}")
        self.bureau = asi_bureau
        self.hazards = [{"id": "ice_storm", "name": "Ice storm"}, {"id": "tornado", "name": "Tornado"}]
        self.nodes = [{"id": "cpp", "name": "Central Power Plant"}, {"id": "uh", "name": "University Hospital"}]

    def providers(self, asi, grok, claude) -> None:
        self.chain(asi=asi, grok=grok, claude=claude)

    def test_parse_goes_asi_then_grok_then_claude_then_keywords(self) -> None:
        order: list[str] = []
        scenario = {"intent": "scenario", "hazard_id": "ice_storm", "node_ids": []}
        self.providers(
            fake("asi", error=RuntimeError("down"), calls=order),
            fake("grok", {"intent": "scenario", "hazard_id": "made_up", "node_ids": []}, calls=order),
            fake("claude", scenario, calls=order),
        )
        parsed, src = run(self.bureau.parse_scenario("ice storm on north campus", self.hazards, self.nodes))
        self.assertEqual((parsed["hazard_id"], src, order), ("ice_storm", "claude", ["asi", "grok", "claude"]))

        self.providers(fake("asi", error=RuntimeError("x")), fake("grok", error=RuntimeError("x")), fake("claude", error=RuntimeError("x")))
        llm.reset_state()
        parsed, src = run(self.bureau.parse_scenario("a tornado touched down", self.hazards, self.nodes))
        self.assertEqual((parsed["hazard_id"], src), ("tornado", "keywords"))

    def test_asi_answer_is_labelled_with_the_asi_model(self) -> None:
        self.providers(fake("asi", {"intent": "status"}), fake("grok", {}), fake("claude", {}))
        parsed, src = run(self.bureau.parse_scenario("how are we doing", self.hazards, self.nodes))
        self.assertEqual((parsed["intent"], src), ("status", self.bureau.ASI_MODEL))

    def test_headline_with_an_invented_number_is_rejected_down_the_chain(self) -> None:
        facts = "Best policy serves 91.5% of essential load with 12 people dark."
        fallback = "template text"
        self.providers(
            fake("asi", "It serves 99% of load."),
            fake("grok", "It serves 91.5% of load, 40 people dark."),
            fake("claude", "It serves 91.5% of load with 12 people dark."),
        )
        text, src = run(self.bureau.phrase(facts, fallback))
        self.assertEqual((text, src), ("It serves 91.5% of load with 12 people dark.", "claude"))
        self.providers(fake("asi", error=RuntimeError("x")), fake("grok", "99 people"), fake("claude", error=RuntimeError("x")))
        llm.reset_state()
        self.assertEqual(run(self.bureau.phrase(facts, fallback)), (fallback, "template"))


if __name__ == "__main__":
    unittest.main()
