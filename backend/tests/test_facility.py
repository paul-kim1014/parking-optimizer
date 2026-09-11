"""Python 구현이 브라우저 엔진(engine.js · nav.js)과 같은 값을 내는지 교차 검증."""
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from app.config import KST
from app.engine import DEFAULT_W, Ctx, VehicleProfile, rank_slots
from app.facility import ZONES
from app.nav import model_route

FIX = json.loads((Path(__file__).parent / "fixtures" / "js_tables.json").read_text())


def test_layout_matches_js(fac):
    assert fac.N == FIX["N"] == 504
    assert sum(s.closed_default for s in fac.slots) == 42
    for row in FIX["slots"]:
        s = fac.slots[row["i"]]
        assert (s.label, s.f, s.zone, s.disabled, s.ev, s.compact, s.closed_default) == \
            (row["label"], row["f"], row["zone"], row["disabled"], row["ev"], row["compact"], row["closed"])


def test_edge_costs_match_js(fac):
    for row in FIX["slots"]:
        i = row["i"]
        assert fac.drive[i].tolist() == pytest.approx(row["drive"], abs=1e-3)
        for h in FIX["hours"]:
            assert [fac.walk(i, z, h) for z in range(len(ZONES))] == pytest.approx(row["walk"][str(h)], abs=1e-3)
            assert fac.best_e[h, i].tolist() == row["best"][str(h)]


def test_cost_ranking_matches_js(fac):
    case = FIX["rank_case"]
    status = np.array(case["status"], dtype=np.uint8)
    c = case["ctx"]
    ctx = Ctx(c["h"], tuple(c["rampPen"]), tuple(c["floorPen"]))
    for v, expected in zip(case["vehicles"], case["ranks"]):
        prof = VehicleProfile(v["zone"], disabled=v.get("disabled", False), ev=v.get("ev", False),
                              ev_want=v.get("evWant", False), large=v.get("large", False))
        got = rank_slots(fac, status, prof, ctx, DEFAULT_W, 5)
        assert [g["s"] for g in got] == [e["s"] for e in expected]
        assert [g["ramp"] for g in got] == [e["ramp"] for e in expected]
        assert [g["total"] for g in got] == pytest.approx([e["total"] for e in expected], abs=1e-2)


def test_model_route_matches_js():
    for c in FIX["model"]:
        o = c["origin"]
        est = model_route(o["lat"], o["lng"], 37.5006, 127.0364, datetime(2026, 9, 14, c["hour"], 0, tzinfo=KST))
        assert est.duration_s == pytest.approx(c["duration_s"], rel=1e-9)
        assert est.distance_m == pytest.approx(c["distance_m"], rel=1e-9)
        assert est.std_s == pytest.approx(c["std_s"], rel=1e-9)
