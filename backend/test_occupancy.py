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


if __name__ == "__main__":
    unittest.main()
