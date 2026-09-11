"""배정 규칙 · hold 정책 · 관제 우선 원칙 · 열화 안전."""
import itertools
from datetime import timedelta

import numpy as np
import pytest

from app.engine import BLOCKED, CLOSED, DEFAULT_W, FREE, HELD, OCC, VehicleProfile, cost_parts, make_ctx, solve_batch


def waiting(rt, clock, zone=0, eta_min=14, plate=None):
    token = f"R-{len(rt.reservations)}"
    rt.add_reservation(token, clock() + timedelta(minutes=eta_min + 22), zone)
    s = rt.create_session(token, clock())
    rt.set_consent(s, True, clock(), plate=plate or f"12가{1000 + len(rt.sessions)}")
    rt.update_eta(s, clock() + timedelta(minutes=eta_min), 240, "tmap", clock())
    return s


def test_attribute_rules(fac):
    ctx = make_ctx(fac, np.zeros(fac.N, np.uint8), 3)
    dis = next(s.i for s in fac.slots if s.disabled)
    comp = next(s.i for s in fac.slots if s.compact)
    assert cost_parts(fac, VehicleProfile(0), dis, ctx, DEFAULT_W) is None
    assert cost_parts(fac, VehicleProfile(0, disabled=True), dis, ctx, DEFAULT_W) is not None
    assert cost_parts(fac, VehicleProfile(0, large=True), comp, ctx, DEFAULT_W) is None


def test_batch_matches_brute_force(fac):
    status = np.full(fac.N, OCC, np.uint8)
    free = [10, 40, 90, 200, 300]
    status[free] = FREE
    rows = [VehicleProfile(0), VehicleProfile(3), VehicleProfile(5)]
    ctx = make_ctx(fac, status, 3)
    got = solve_batch(fac, status, rows, ctx, DEFAULT_W)

    def cost(v, s):
        return cost_parts(fac, v, s, ctx, DEFAULT_W)["total"]

    best = min(sum(cost(v, s) for v, s in zip(rows, p)) for p in itertools.permutations(free, 3))
    assert len(set(got)) == 3
    assert sum(cost(v, s) for v, s in zip(rows, got)) == pytest.approx(best)


def test_rolling_commits_only_due_sessions(rt, clock):
    due, later = waiting(rt, clock, eta_min=14), waiting(rt, clock, eta_min=40)
    rt.tick(clock())
    assert due.status == "assigned" and rt.status[due.slot] == HELD
    assert later.status == "waiting" and later.slot is None


def test_hold_cap_leaves_room_for_walk_ins(rt, clock):
    rt.hold_cap = 0.1
    rt.status[:] = OCC
    rt.status[:20] = FREE          # 가용 20면 → hold 상한 2면
    for _ in range(5):
        waiting(rt, clock, eta_min=10)
    rt.tick(clock())
    assert int((rt.status == HELD).sum()) == 2


def test_hold_expiry_releases_and_reassigns(rt, clock):
    s = waiting(rt, clock, eta_min=10)
    rt.tick(clock())
    assert s.hold_expires_at == s.eta + timedelta(seconds=2 * 240 + 600)
    clock.advance(minutes=10 + 8 + 10 + 1)
    rt.tick(clock())
    assert s.expired == 1 and rt.counters["expire"] == 1
    assert s.status == "assigned"          # ETA를 10분 뒤로 옮겨 곧바로 다시 배정


def test_other_car_taking_held_slot_triggers_reassign(rt, clock):
    s = waiting(rt, clock)
    rt.tick(clock())
    slot = s.slot
    rt.on_slot(slot, OCC, rt.hash_plate("99하9999"), clock())
    assert rt.status[slot] == OCC                      # 관제가 이긴다
    assert s.status == "assigned" and s.slot not in (None, slot) and s.reassigns == 1
    assert any(e["kind"] == "conflict" for e in rt.log)


def test_entry_confirms_hold_and_sensor_marks_compliance(rt, clock):
    s = waiting(rt, clock, plate="34나3456")
    rt.tick(clock())
    res = rt.on_entry(rt.hash_plate("34나 3456"), s.ramp, clock())
    assert res["guided"] and res["display"][0] == "3456 차량"
    assert s.status == "entered" and s.hold_expires_at is None
    rt.on_slot(s.slot, OCC, None, clock())            # 면 센서는 번호판을 모른다
    assert s.status == "parked" and s.complied is True
    rt.on_exit(rt.hash_plate("34나3456"), clock())
    assert s.status == "exited" and rt.status[s.parked_slot] == FREE


def test_parking_elsewhere_is_logged_and_hold_released(rt, clock):
    s = waiting(rt, clock, plate="11가1111")
    rt.tick(clock())
    held = s.slot
    other = next(i for i in range(rt.fac.N) if rt.status[i] == FREE and i != held)
    rt.on_entry(rt.hash_plate("11가1111"), 0, clock())
    rt.on_slot(other, OCC, rt.hash_plate("11가1111"), clock())
    assert s.status == "parked" and s.complied is False
    assert rt.status[held] == FREE
    assert any(e["kind"] == "ignore" for e in rt.log)


def test_sensor_mismatch_blocks_slot_and_reassigns(rt, clock):
    s = waiting(rt, clock)
    rt.tick(clock())
    slot = s.slot
    rt.on_slot(slot, BLOCKED, None, clock())
    assert rt.status[slot] == BLOCKED and s.slot not in (None, slot)


def test_engine_off_degrades_gracefully(rt, clock):
    s = waiting(rt, clock)
    rt.tick(clock())
    rt.apply_operation({"type": "ENGINE_OFF"}, clock())
    assert int((rt.status == HELD).sum()) == 0 and s.status == "waiting"
    res = rt.on_entry(s.plate_hash, 0, clock())
    assert res["guided"] is False and res["display"][1].startswith("B1 ")


def test_open_and_close_zone(rt, clock):
    assert int((rt.status == CLOSED).sum()) == 42
    rt.apply_operation({"type": "OPEN_ZONE", "floor": "B3", "zone": "D"}, clock())
    assert int((rt.status == CLOSED).sum()) == 0
    with pytest.raises(ValueError):
        rt.apply_operation({"type": "SET_HOLD_CAP", "value": 3}, clock())


def test_forecast_quantiles_are_ordered(rt, clock):
    for k in range(30):
        rt.add_reservation(f"F{k}", clock() + timedelta(minutes=30 + k), 0)
    f = rt.forecast_view(clock(), 120)
    assert len(f["buckets"]) == 8
    assert all(b["p10"] <= b["p50"] <= b["p90"] for b in f["buckets"])
    assert sum(b["p50"] for b in f["buckets"]) > 25


def test_plate_hash_is_normalized_and_opaque(rt):
    h = rt.hash_plate("12가 3456")
    assert h == rt.hash_plate("12가3456") and len(h) == 32 and "3456" not in h
