"""Day, time, and headcount rules for the class-load estimate."""

from __future__ import annotations

import os
import unittest
from datetime import datetime

import occupancy
from occupancy import DETROIT, Meeting, Place, meetings_from_csv, meetings_from_sections, project


class ParseTests(unittest.TestCase):
    def test_term_for_fall_2026(self) -> None:
        os.environ.pop("UM_TERM", None)
        self.assertEqual(
            occupancy.current_term(datetime(2026, 10, 3, tzinfo=DETROIT)),
            ("2610", "FA2026", "Fall 2026"),
        )

    def test_term_for_winter_2026(self) -> None:
        os.environ.pop("UM_TERM", None)
        self.assertEqual(occupancy.current_term(datetime(2026, 1, 15, tzinfo=DETROIT))[0], "2570")

    def test_days(self) -> None:
        self.assertEqual(occupancy.parse_days("TuTh"), frozenset({1, 3}))
        self.assertEqual(occupancy.parse_days("TTH"), frozenset({1, 3}))
        self.assertEqual(occupancy.parse_days("MWF"), frozenset({0, 2, 4}))
        self.assertEqual(occupancy.parse_days("MoWeFr"), frozenset({0, 2, 4}))
        self.assertEqual(occupancy.parse_days("TBA"), frozenset())

    def test_times(self) -> None:
        self.assertEqual(occupancy.parse_span("10:30AM - 11:20AM"), (10 * 60 + 30, 11 * 60 + 20))
        self.assertEqual(occupancy.parse_span("10:30 - 1:30PM"), (10 * 60 + 30, 13 * 60 + 30))
        self.assertEqual(occupancy.parse_span("1:00 - 2:30PM"), (13 * 60, 14 * 60 + 30))
        self.assertIsNone(occupancy.parse_span("TBA"))

    def test_building_codes(self) -> None:
        codes = ["BUS", "R-BUS", "AH", "MH", "MLB"]
        self.assertEqual(occupancy.match_building("AH 1401", codes), "AH")
        self.assertEqual(occupancy.match_building("AH1401", codes), "AH")
        self.assertEqual(occupancy.match_building("3302 MH", codes), "MH")
        self.assertEqual(occupancy.match_building("R-BUS B3560", codes), "R-BUS")
        self.assertIsNone(occupancy.match_building("ARR", codes))
        self.assertIsNone(occupancy.match_building("ONLINE", codes))

    def test_over_capacity_uses_enrollment(self) -> None:
        self.assertEqual(occupancy.seats_for(100, 140), 140)
        self.assertEqual(occupancy.present(100, 0.75), 75)


class EstimateTests(unittest.TestCase):
    def test_only_counts_people_while_class_meets(self) -> None:
        meetings = [
            Meeting("AH", frozenset({0}), 10 * 60, 11 * 60 + 20, 200, "2", "COMB"),
            Meeting("AH", frozenset({0}), 10 * 60, 11 * 60 + 20, 180, "3", "COMB"),
            Meeting("MLB", frozenset({0}), 10 * 60, 11 * 60, 40, "4", ""),
            Meeting("AH", frozenset({1}), 10 * 60, 11 * 60, 100, "5", ""),
        ]
        meetings = occupancy._dedupe(meetings)
        places = {
            "AH": Place("AH", "Angell Hall", "Central Campus", 42.27, -83.74, "angell"),
            "MLB": Place("MLB", "Modern Languages Building", "Central Campus", 42.27, -83.74, None),
        }
        monday = datetime(2026, 10, 5, 10, 30, tzinfo=DETROIT)  # a Monday
        body = project(meetings, places, 0, 0.5, monday)
        by_code = {row["code"]: row for row in body["buildings"]}
        slot = body["slots"][5]  # 10:30
        self.assertEqual(slot["label"], "10:30 AM")
        self.assertEqual(by_code["AH"]["students"][5], 100)
        self.assertEqual(by_code["MLB"]["students"][5], 20)
        self.assertEqual(slot["students"], 120)
        self.assertEqual(by_code["AH"]["students"][8], 0)  # 12:00, class has ended
        self.assertEqual(by_code["AH"]["node_id"], "angell")
        self.assertEqual(by_code["AH"]["lng"], occupancy.NODE_PLACES["angell"][0])

    def test_csv_and_api_shapes(self) -> None:
        csv_text = (
            "Class Nbr,Component,Days,Time,Location,Enrl Cap,Enrl Tot,Mode\n"
            "10,LEC,MWF,9:00AM - 10:00AM,AH 1401,100,80,In Person\n"
            "11,DIS,F,9:00AM - 10:00AM,REMOTE,20,20,Online\n"
            "12,LAB,TTH,2:00PM - 3:30PM,3302 MH,30,36,In Person\n"
        )
        parsed = meetings_from_csv(csv_text, ["AH", "MH"])
        self.assertEqual({item.building for item in parsed}, {"AH", "MH"})
        friday = next(item for item in parsed if item.building == "AH")
        self.assertEqual(friday.seats, 100)
        self.assertIn(0, friday.days)
        lab = next(item for item in parsed if item.building == "MH")
        self.assertEqual(lab.seats, 36)

        sections = [{
            "ClassNumber": 99,
            "EnrollmentCapacity": 50,
            "EnrollmentTotal": 40,
            "InstructionMode": "In Person",
            "CombinedSectionID": None,
            "Meeting": {"Days": "TuTh", "Times": "9:00AM - 10:30AM", "ClassMtgTopic": "EECS 1200"},
        }]
        api_meetings = meetings_from_sections(sections, ["EECS"])
        self.assertEqual(len(api_meetings), 1)
        self.assertEqual(api_meetings[0].building, "EECS")
        self.assertEqual(api_meetings[0].days, frozenset({1, 3}))


class EventTests(unittest.TestCase):
    def test_event_span_and_place(self) -> None:
        import events

        self.assertEqual(events.event_span("15:00:00", "16:30:00", True), (15 * 60, 16 * 60 + 30))
        self.assertEqual(events.event_span("08:00:00", "23:00:00", True), (10 * 60, 17 * 60))
        places = {
            "UNION": Place("UNION", "Michigan Union", "Central", 42.27, -83.74, "union"),
            "EH": Place("EH", "East Hall", "Central", 42.27, -83.74, None),
        }
        self.assertEqual(events.match_event_place("Michigan Union", places), "UNION")
        self.assertEqual(events.match_event_place("East Hall 1360", places), "EH")
        self.assertIsNone(events.match_event_place("Zoom", places))

    def test_events_add_to_the_same_building_count(self) -> None:
        import events

        places = {"UNION": Place("UNION", "Michigan Union", "Central", 42.27, -83.74, "union")}
        rows = events.placed_rows([{
            "building_name": "Michigan Union",
            "location_name": "Michigan Union",
            "date_start": "2026-10-05",
            "date_end": "2026-10-05",
            "time_start": "15:00:00",
            "time_end": "16:00:00",
            "has_end_time": 1,
            "event_type": "Lecture / Discussion",
            "event_title": "Talk",
        }], places)
        self.assertEqual(rows[0]["building"], "UNION")
        self.assertEqual(rows[0]["seats"], 80)
        meetings = events.meetings_from_snapshot({"events": rows})
        monday = datetime(2026, 10, 5, 15, 0, tzinfo=DETROIT)
        body = project([], places, 0, 0.75, monday, events=meetings)
        self.assertEqual(body["event_count"], 1)
        self.assertEqual(body["slots"][14]["students"], 80)
        self.assertEqual(body["slots"][14]["events"], 80)
        self.assertEqual(body["buildings"][0]["students"][16], 0)



class SimDrivenTests(unittest.TestCase):
    """People set each mapped building's headcount at the campus clock's time of day."""

    def setUp(self) -> None:
        import events
        from graph import CampusGraph

        self.events = events
        self._load_events = events.load_demo_events
        events.load_demo_events = lambda: ([], "")
        angell = Meeting("AH", frozenset({1}), 14 * 60, 15 * 60, 400, "1", "")
        hall = Meeting("SQ", frozenset({1}), 14 * 60, 15 * 60, 100, "2", "")
        places = {
            "AH": Place("AH", "Angell Hall", "Central", None, None, "angell"),
            "SQ": Place("SQ", "South Quad", "Central", None, None, "south_quad"),
            "UM HOSP": Place("UM HOSP", "University Hospital", "Medical", None, None, "uh"),
        }
        self._saved = (occupancy._schedule, dict(occupancy.selection))
        occupancy._schedule = {"meetings": [angell, hall], "places": places}
        occupancy.selection.update({"weekday": 1, "turnup": 1.0})
        occupancy._sim_cache.clear()
        occupancy._weekday_cache.clear()
        self.graph = CampusGraph()
        os.environ.pop("PEOPLE_DRIVES_SIM", None)

    def tearDown(self) -> None:
        self.events.load_demo_events = self._load_events
        occupancy._schedule = self._saved[0]
        occupancy.selection.clear()
        occupancy.selection.update(self._saved[1])
        occupancy._sim_cache.clear()
        occupancy._weekday_cache.clear()
        os.environ.pop("PEOPLE_DRIVES_SIM", None)

    def test_class_hours_fill_the_building_and_the_evening_empties_it(self) -> None:
        occupancy.apply_to_graph(self.graph, 14 * 60)
        self.assertEqual(self.graph.nodes["angell"].occupancy, 400)
        self.assertEqual(self.graph.nodes["angell"].baseline_occupancy, 400)
        occupancy.apply_to_graph(self.graph, 20 * 60)
        # Staff are all that is left, never zero.
        self.assertGreater(self.graph.nodes["angell"].occupancy, 0)
        self.assertLess(self.graph.nodes["angell"].occupancy, 100)

    def test_hospitals_and_unmapped_buildings_are_untouched(self) -> None:
        before = {k: (n.occupancy, n.baseline_occupancy) for k, n in self.graph.nodes.items()}
        occupancy.apply_to_graph(self.graph, 14 * 60)
        for node_id in ("uh", "mott", "kahn", "city_hall", "cpp", "beyster"):
            node = self.graph.nodes[node_id]
            self.assertEqual((node.occupancy, node.baseline_occupancy), before[node_id], node_id)

    def test_dorm_keeps_residents(self) -> None:
        occupancy.apply_to_graph(self.graph, 14 * 60)
        hall = self.graph.nodes["south_quad"]
        self.assertGreater(hall.occupancy, 1000 * 0.5)
        self.assertGreaterEqual(hall.occupancy, 100)

    def test_dark_building_keeps_what_transit_left_it_and_lit_ones_scale(self) -> None:
        occupancy.apply_to_graph(self.graph, 14 * 60)
        from graph import Status

        angell, ross = self.graph.nodes["angell"], self.graph.nodes["south_quad"]
        angell.status = Status.RED
        angell.occupancy = 0
        before = ross.occupancy
        occupancy.apply_to_graph(self.graph, 20 * 60)
        self.assertEqual(angell.occupancy, 0)
        self.assertLess(angell.baseline_occupancy, 400)
        self.assertNotEqual(ross.occupancy, before)

    def test_flag_off_leaves_the_fixed_numbers(self) -> None:
        os.environ["PEOPLE_DRIVES_SIM"] = "0"
        self.assertFalse(occupancy.apply_to_graph(self.graph, 14 * 60))
        self.assertEqual(self.graph.nodes["angell"].occupancy, 400)

    def test_failure_moves_different_numbers_at_different_times(self) -> None:
        from agents.logic import apply_transit
        from graph import CampusGraph

        moved = []
        for hour in (14, 20):
            graph = CampusGraph()
            occupancy.apply_to_graph(graph, hour * 60)
            graph.fail_node("angell")
            graph.tick()
            notes = apply_transit(graph)
            moved.append(next(int(n.split()[3]) for n in notes if "moved" in n))
        self.assertGreater(moved[0], moved[1] * 3)

    def test_people_now_names_the_slot(self) -> None:
        self.graph.set_clock(14 * 60)
        now = occupancy.people_now(self.graph)
        self.assertEqual(now["slot"], "Tue 14:00")
        self.assertEqual(now["buildings"][0]["node_id"], "angell")
        self.assertEqual(now["buildings"][0]["students"], 400)

    def test_evacuees_in_a_lit_building_never_multiply(self) -> None:
        # Evening: Angell is at its staff floor. 500 evacuees arrive, then classes start.
        occupancy.apply_to_graph(self.graph, 20 * 60)
        angell = self.graph.nodes["angell"]
        floor = angell.baseline_occupancy
        angell.occupancy = floor + 500
        occupancy.apply_to_graph(self.graph, 14 * 60)
        self.assertEqual(angell.occupancy, 400 + 500)
        occupancy.apply_to_graph(self.graph, 20 * 60)
        self.assertEqual(angell.occupancy, floor + 500)

    def test_counts_never_go_negative(self) -> None:
        occupancy.apply_to_graph(self.graph, 14 * 60)
        angell = self.graph.nodes["angell"]
        angell.occupancy = 3  # lit again after an evacuation, nearly empty
        occupancy.apply_to_graph(self.graph, 20 * 60)
        self.assertEqual(angell.occupancy, 0)

    def test_bad_schedule_never_breaks_the_tick(self) -> None:
        occupancy._schedule = {"meetings": None, "places": {}}
        occupancy._sim_cache.clear()
        occupancy._weekday_cache.clear()
        self.assertFalse(occupancy.apply_to_graph(self.graph, 14 * 60))
        self.assertIsNone(occupancy.people_now(self.graph)["slot"])
        self.assertEqual(self.graph.nodes["angell"].occupancy, 400)

    def test_cycle_sets_people_for_the_tick_it_runs(self) -> None:
        from agents import runtime

        self.graph.set_clock(14 * 60 - 4)  # 13:56 now; the next tick is 14:00
        runtime.run_cycle(self.graph, force=True)
        self.assertEqual(self.graph.sim_minutes(), 14 * 60)
        self.assertEqual(self.graph.nodes["angell"].baseline_occupancy, 400)

    def test_language_model_facts_are_capped(self) -> None:
        import briefing

        occupancy._schedule["meetings"] = [
            Meeting(code, frozenset({1}), 14 * 60, 15 * 60, 50, str(i), "")
            for i, code in enumerate(occupancy.NODE_BY_CODE)
        ]
        occupancy._sim_cache.clear()
        self.graph.set_clock(14 * 60)
        facts = briefing.people_facts(self.graph)
        self.assertLessEqual(len(facts["buildings"]), briefing.PEOPLE_FACTS_MAX)

    def test_clock_runs_four_minutes_a_tick(self) -> None:
        self.assertEqual(self.graph.sim_minutes(), 14 * 60)
        self.graph.tick()
        self.assertEqual(self.graph.sim_minutes(), 14 * 60 + 4)


if __name__ == "__main__":
    unittest.main()
