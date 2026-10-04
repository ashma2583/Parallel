"""Energy saver caps: never below occupied need, never on hospitals or feeds."""

from __future__ import annotations

import unittest

import savings
from graph import CampusGraph


class CapTests(unittest.TestCase):
    def test_ceil5(self) -> None:
        self.assertEqual(savings.ceil5(0.41), 0.45)
        self.assertEqual(savings.ceil5(0.45), 0.45)
        self.assertEqual(savings.ceil5(1.3), 1.0)

    def test_need_floor_and_base(self) -> None:
        self.assertAlmostEqual(savings.need_share("academic", 0), 0.35)
        self.assertAlmostEqual(savings.need_share("academic", 1), 1.0)
        self.assertAlmostEqual(savings.need_share("research", 0.5), 0.9)

    def test_limit_covers_need_every_slot(self) -> None:
        graph = CampusGraph()
        for weekday in (1, 5):
            for policy in savings.POLICIES:
                body = savings.plan_for(graph, weekday, policy)
                for row in body["buildings"]:
                    for s in range(savings.SLOTS):
                        self.assertGreaterEqual(row["limit"][s] * row["demand"] + 1e-9, row["need"][s] * row["demand"] - 0.06, (row["id"], s))
                        self.assertGreaterEqual(row["limit"][s], row["need"][s] - 1e-3, (policy, row["id"], s))

    def test_limit_assert_trips(self) -> None:
        # A cap is the max need over the window, so a lower one cannot come out.
        limits = savings.limits_for("academic", 100, [30.0] * 47 + [90.0], "aggressive")
        self.assertEqual(limits[46], 0.9)
        self.assertEqual(limits[47], 0.9)
        self.assertEqual(limits[0], 0.3)

    def test_never_capped(self) -> None:
        body = savings.plan_for(CampusGraph(), 1, "aggressive")
        for row in body["buildings"]:
            if row["type"] in ("hospital", "feed", "city"):
                self.assertEqual(min(row["limit"]), 1.0, row["id"])
                self.assertTrue(row["never"])

    def test_policy_types(self) -> None:
        graph = CampusGraph()
        comfort = {r["id"]: r for r in savings.plan_for(graph, 1, "comfort")["buildings"]}
        aggressive = {r["id"]: r for r in savings.plan_for(graph, 1, "aggressive")["buildings"]}
        self.assertEqual(min(comfort["markley"]["limit"]), 1.0)
        self.assertLess(min(aggressive["markley"]["limit"]), 1.0)
        self.assertLess(min(comfort["angell"]["limit"]), 1.0)

    def test_more_aggressive_saves_more(self) -> None:
        graph = CampusGraph()
        kwh = [savings.plan_for(graph, 1, p)["totals"]["kwh_saved"] for p in ("comfort", "balanced", "aggressive")]
        self.assertLess(kwh[0], kwh[1])
        self.assertLess(kwh[1], kwh[2])
        totals = savings.plan_for(graph, 1, "balanced")["totals"]
        self.assertLess(totals["kwh_saved_vs_timeclock"], totals["kwh_saved"])
        self.assertGreater(totals["peak_kw_cut"], 0)

    def test_dorms_inverse(self) -> None:
        busy = savings.template("dorm", 1, [0.0] * 24 + [1.0] * 24)
        self.assertAlmostEqual(busy[0], 0.95)
        self.assertAlmostEqual(busy[30], 0.35)

    def test_researched_campus_uses_types(self) -> None:
        body = savings.plan_for(None, 1, "balanced", "uc-davis")
        self.assertFalse(body["measured"])
        self.assertTrue(all(r["source"] in ("estimated from building type", "never capped") for r in body["buildings"]))
        self.assertGreater(body["totals"]["kwh_saved"], 0)

    def test_live_saver_on_clock(self) -> None:
        graph = CampusGraph()
        savings.start(graph, "balanced", 1, 20 * 60)
        notes = savings.advance(graph)
        graph.tick()
        self.assertTrue(notes and notes[0].startswith("Energy saver 20:04"))
        view = savings.live(graph)
        self.assertGreater(view["kw_saved_now"], 0)
        for nid in view["caps"]:
            node = graph.nodes[nid]
            self.assertEqual(node.status.value, "Green")
            self.assertAlmostEqual(node.current_power, node.demand * node.limit, places=1)
        for _ in range(10):
            savings.advance(graph)
            graph.tick()
        self.assertGreater(savings.live(graph)["kwh_saved"], 0)
        graph.saver = None
        savings.advance(graph)
        self.assertTrue(all(n.limit == 1.0 for n in graph.nodes.values()))

    def test_compare_ranks(self) -> None:
        graph = CampusGraph()
        body = savings.compare(graph, 1, 18 * 60, "tiered")
        self.assertEqual(len(body["branches"]), 4)
        self.assertEqual(body["winner"], "aggressive")
        off = next(b for b in body["branches"] if b["id"] == "off")
        self.assertEqual(off["metrics"]["kwh_saved"], 0)


if __name__ == "__main__":
    unittest.main()
