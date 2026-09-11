"""시설별 실시간 상태 · 세션 · 이벤트 처리 (기획서 6.3, 7.2, 8.2).

설계 원칙
- 관제가 진실의 원천: SLOT 이벤트는 항상 플랫폼의 hold보다 우선한다. 충돌하면 hold를 풀고 재배정한다.
- 열화 안전: 배정 엔진이 꺼져도 입차 · 점유 이벤트는 처리된다. 배정 실패는 "안내 없음"이다.
- 개인정보 최소화: 번호판은 시설 솔트 HMAC 해시와 끝 4자리만 보관하고, 위치 좌표는 받지 않는다.
"""
from __future__ import annotations

import hashlib
import hmac
import math
import re
import secrets
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np

from .config import KST, Settings
from .engine import (BLOCKED, CLOSED, DEFAULT_W, FREE, HELD, INF, OCC, Ctx, VehicleProfile, cost_parts, cost_row,
                     forecast_bucket, make_ctx, rank_slots, solve_batch, turn_of, walkin_rate)
from .facility import FLOORS, RAMPS, ZONES, Facility, hour_index

PRIOR_LEAD_S = 22 * 60        # 예약 대비 평균 도착 리드타임 [가정]
PRIOR_STD_S = 660.0           # 예약 기반 사전분포 표준편차 [가정]
ASSIGN_LEAD_S = 900           # 도착 15분 전 배정
HOLD_SLACK_S = 600            # hold 유효 = ETA + 2σ + 10분
PURGE_AFTER = timedelta(hours=24)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(KST).isoformat(timespec="seconds") if dt else None


@dataclass
class Reservation:
    token: str
    appointment_at: datetime
    zone: int


@dataclass
class Session:
    token: str
    reservation_token: str
    zone: int
    appointment_at: datetime
    created_at: datetime
    consent: bool = False
    plate_hash: str | None = None
    plate_tail: str | None = None
    vehicle: VehicleProfile | None = None
    eta: datetime | None = None
    eta_std_s: float = PRIOR_STD_S
    eta_source: str = "reservation-prior"
    eta_updated_at: datetime | None = None
    route: dict | None = None
    last_nav_at: datetime | None = None
    status: str = "created"   # created → waiting → assigned → entered → parked → exited
    slot: int | None = None
    ramp: int | None = None
    hold_expires_at: datetime | None = None
    assigned_at: datetime | None = None
    entered_at: datetime | None = None
    parked_at: datetime | None = None
    parked_slot: int | None = None
    exited_at: datetime | None = None
    complied: bool | None = None
    reassigns: int = 0
    expired: int = 0

    @property
    def sid(self) -> str:
        """로그용 짧은 식별자 (세션 토큰 자체는 로그에 남기지 않는다)."""
        return hashlib.sha256(self.token.encode()).hexdigest()[:8]

    @property
    def tail(self) -> str:
        return self.plate_tail or "····"


class Runtime:
    def __init__(self, fac: Facility, settings: Settings, clock=None):
        self.fac, self.settings = fac, settings
        self.clock = clock or (lambda: datetime.now(KST))
        self.status = np.full(fac.N, FREE, dtype=np.uint8)
        for s in fac.slots:
            if s.closed_default:
                self.status[s.i] = CLOSED
        self.holder: list[str | None] = [None] * fac.N
        self.occupant: list[str | None] = [None] * fac.N
        self.gate_wait = [0.0, 0.0]
        self.searching = [0, 0]
        self.engine_on = True
        self.weights = dict(DEFAULT_W)
        self.hold_cap = 0.7
        self.horizon_s = 1800
        self.reservations: dict[str, Reservation] = {}
        self.sessions: dict[str, Session] = {}
        self.by_plate: dict[str, str] = {}
        self.by_res: dict[str, str] = {}
        self.log: deque = deque(maxlen=2000)
        self.entries: deque = deque(maxlen=20000)
        self.counters: Counter = Counter()

    def now(self) -> datetime:
        return self.clock()

    # ---------- 개인정보 ----------
    def hash_plate(self, plate: str) -> str:
        norm = re.sub(r"\s+", "", plate).upper()
        return hmac.new(self.settings.facility_salt.encode(), norm.encode(), hashlib.sha256).hexdigest()[:32]

    def emit(self, now: datetime, kind: str, text: str, **extra) -> None:
        self.log.append({"ts": iso(now), "kind": kind, "text": text, **extra})

    # ---------- 예약 · 세션 ----------
    def add_reservation(self, token: str, appointment_at: datetime, zone: int) -> Reservation:
        r = Reservation(token, appointment_at.astimezone(KST), zone)
        self.reservations[token] = r
        return r

    def add_demo_reservation(self, now: datetime, zone: int = 0) -> str:
        appt = now + timedelta(minutes=45)
        appt = appt.replace(second=0, microsecond=0) + timedelta(minutes=(10 - appt.minute % 10) % 10)
        token = "DEMO-" + secrets.token_hex(4)
        self.add_reservation(token, appt, zone)
        return token

    def create_session(self, reservation_token: str, now: datetime) -> Session:
        r = self.reservations[reservation_token]
        sess = Session(secrets.token_urlsafe(18), r.token, r.zone, r.appointment_at, now)
        self.sessions[sess.token] = sess
        self.by_res[r.token] = sess.token
        return sess

    def set_consent(self, sess: Session, consent: bool, now: datetime, plate: str | None = None,
                    vehicle: VehicleProfile | None = None) -> None:
        if not consent:
            self._release(sess)
            sess.consent, sess.slot, sess.status = False, None, "created"
            sess.eta, sess.route = None, None
            return
        sess.consent = True
        if plate:
            sess.plate_hash = self.hash_plate(plate)
            digits = re.sub(r"\D", "", plate)
            sess.plate_tail = digits[-4:] or None
            self.by_plate[sess.plate_hash] = sess.token
        sess.vehicle = vehicle or sess.vehicle or VehicleProfile(sess.zone)
        if sess.eta is None:
            sess.eta = sess.appointment_at - timedelta(seconds=PRIOR_LEAD_S)
            sess.eta_std_s, sess.eta_source = PRIOR_STD_S, "reservation-prior"
        if sess.status == "created":
            sess.status = "waiting"

    def update_eta(self, sess: Session, eta: datetime, std_s: float, source: str, now: datetime,
                   route: dict | None = None, log: bool = True) -> None:
        sess.eta, sess.eta_std_s, sess.eta_source, sess.eta_updated_at = eta.astimezone(KST), float(std_s), source, now
        if route is not None:
            sess.route = route
        if sess.status == "assigned":
            sess.hold_expires_at = self._hold_exp(sess)
        if log:
            self.emit(now, "eta", f"{sess.tail} ETA {sess.eta:%H:%M} ±{round(std_s / 60)}분 ({source})", session=sess.sid)

    # ---------- 배정 ----------
    def _hold_exp(self, sess: Session) -> datetime:
        return sess.eta + timedelta(seconds=2 * sess.eta_std_s + HOLD_SLACK_S)

    def _holds(self, sess: Session) -> bool:
        return sess.slot is not None and self.holder[sess.slot] == sess.token and self.status[sess.slot] == HELD

    def ctx(self, now: datetime) -> Ctx:
        pend = [0, 0]
        for s in self.sessions.values():
            if s.status == "assigned" and s.ramp is not None and s.eta and (s.eta - now).total_seconds() < 1200:
                pend[s.ramp] += 1
        return make_ctx(self.fac, self.status, hour_index(now), self.gate_wait, self.searching, pend)

    def hold_budget(self) -> int:
        free, held = int((self.status == FREE).sum()), int((self.status == HELD).sum())
        return math.floor(self.hold_cap * (free + held)) - held

    def _assign(self, sess: Session, s: int, ramp: int, now: datetime, kind: str, note: str = "") -> None:
        self.status[s], self.holder[s] = HELD, sess.token
        sess.slot, sess.ramp, sess.status = s, ramp, "assigned"
        sess.hold_expires_at = self._hold_exp(sess)
        if sess.assigned_at is None:
            sess.assigned_at = now
        self.counters["assign"] += 1
        label = self.fac.slots[s].label
        self.emit(now, kind, f"{sess.tail} → {label}" + (f" ({note})" if note else ""), slot=label, ramp=RAMPS[ramp]["id"])

    def _release(self, sess: Session) -> None:
        if self._holds(sess):
            self.status[sess.slot], self.holder[sess.slot] = FREE, None

    def best_for(self, sess: Session, now: datetime, ramp_fixed: int | None = None) -> tuple[int, int] | None:
        ctx = self.ctx(now)
        v = sess.vehicle or VehicleProfile(sess.zone)
        row = np.where(self.status == FREE, cost_row(self.fac, v, ctx, self.weights, ramp_fixed), INF)
        s = int(np.argmin(row))
        if row[s] >= INF:
            return None
        ramp = ramp_fixed if ramp_fixed is not None else cost_parts(self.fac, v, s, ctx, self.weights)["ramp"]
        return s, ramp

    def lost_hold(self, sess: Session, now: datetime, reason: str) -> None:
        entered = sess.status == "entered"
        sess.slot = None
        sess.reassigns += 1
        self.counters["reassign"] += 1
        if sess.status == "assigned":
            sess.status = "waiting"
        if not self.engine_on or sess.status not in ("waiting", "entered"):
            return
        b = self.best_for(sess, now, ramp_fixed=sess.ramp if entered else None)
        if b:
            self._assign(sess, b[0], b[1], now, "reassign", reason)
            if entered:
                sess.status, sess.hold_expires_at = "entered", None

    def tick(self, now: datetime, window_s: float | None = None) -> None:
        self._expire(now)
        if self.engine_on:
            self._rolling(now, window_s if window_s is not None else self.settings.tick_seconds)
        self._purge(now)

    def _expire(self, now: datetime) -> None:
        for sess in self.sessions.values():
            if sess.status == "assigned" and sess.hold_expires_at and sess.hold_expires_at < now:
                label = self.fac.slots[sess.slot].label
                self._release(sess)
                sess.slot, sess.status = None, "waiting"
                sess.expired += 1
                self.counters["expire"] += 1
                sess.eta, sess.eta_std_s = now + timedelta(minutes=10), 300.0
                self.emit(now, "expire", f"{sess.tail} hold 만료 · {label} 해제", slot=label)

    def _rolling(self, now: datetime, window_s: float) -> None:
        """롤링 호라이즌: 배정 시점이 된 차량(commit)과 다음 30분 안의 차량(look)을 함께 풀고 commit만 확정."""
        commit, look = [], []
        for sess in self.sessions.values():
            if sess.status != "waiting" or not sess.consent or sess.eta is None:
                continue
            lead = (sess.eta - now).total_seconds() - ASSIGN_LEAD_S
            if lead <= window_s:
                commit.append(sess)
            elif lead <= self.horizon_s:
                look.append(sess)
        if not commit:
            return
        budget = self.hold_budget()
        if budget <= 0:
            self.counters["cap_block"] += 1
            return
        commit.sort(key=lambda x: x.eta)
        cm = commit[:budget]
        ctx = self.ctx(now)
        rows = cm + sorted(look, key=lambda x: x.eta)
        res = solve_batch(self.fac, self.status, [x.vehicle or VehicleProfile(x.zone) for x in rows], ctx, self.weights)
        for sess, s in zip(cm, res):
            if s is None:
                continue
            p = cost_parts(self.fac, sess.vehicle or VehicleProfile(sess.zone), s, ctx, self.weights)
            self._assign(sess, s, p["ramp"], now, "assign")

    def _purge(self, now: datetime) -> None:
        cutoff = now - PURGE_AFTER
        dead = [t for t, s in self.sessions.items()
                if (s.exited_at and s.exited_at < cutoff) or (s.status in ("created", "waiting") and s.created_at < cutoff and s.appointment_at < cutoff)]
        for t in dead:
            s = self.sessions.pop(t)
            self._release(s)
            if s.plate_hash and self.by_plate.get(s.plate_hash) == t:
                del self.by_plate[s.plate_hash]
            if self.by_res.get(s.reservation_token) == t:
                del self.by_res[s.reservation_token]
        for k in [k for k, r in self.reservations.items() if r.appointment_at < cutoff]:
            del self.reservations[k]

    # ---------- 관제 이벤트 ----------
    def session_for_plate(self, plate_hash: str | None) -> Session | None:
        tok = self.by_plate.get(plate_hash) if plate_hash else None
        return self.sessions.get(tok) if tok else None

    def signage_lines(self, sess: Session) -> list[str]:
        sl = self.fac.slots[sess.slot]
        t = turn_of(sl, sess.ramp or 0)
        return [f"{sess.tail} 차량", f"{FLOORS[sl.f]} {sl.zone}-{sl.num} {t['arrow']}{t['word']}"]

    def free_by_floor(self) -> list[int]:
        return [int(((self.status == FREE) & (self.fac.floor_of == f)).sum()) for f in range(3)]

    def vacancy_lines(self, tail: str | None = None) -> list[str]:
        n = self.free_by_floor()
        return [f"{tail} 차량" if tail else self.fac.name, f"B1 {n[0]} B2 {n[1]} B3 {n[2]}"]

    def on_entry(self, plate_hash: str | None, ramp: int, ts: datetime, sess: Session | None = None) -> dict:
        """LPR 입차: 배정 차량이면 hold 확정 + 방향 안내, 아니면 층별 빈자리 안내."""
        sess = sess or self.session_for_plate(plate_hash)
        self.entries.append(ts.timestamp())
        self.counters["entry"] += 1
        if sess and sess.consent and sess.status in ("waiting", "assigned"):
            if not self._holds(sess) and self.engine_on:
                b = self.best_for(sess, ts, ramp_fixed=ramp)
                if b:
                    self._assign(sess, b[0], ramp, ts, "gate-assign")
                    self.counters["gate_assign"] += 1
            if self._holds(sess):
                sess.status, sess.entered_at, sess.hold_expires_at, sess.ramp = "entered", ts, None, ramp
                label = self.fac.slots[sess.slot].label
                self.emit(ts, "enter", f"{sess.tail} 입차 → {label}", ramp=RAMPS[ramp]["id"], slot=label, guided=True)
                return {"guided": True, "slot": label, "display": self.signage_lines(sess)}
            if self.engine_on:
                self.counters["fail"] += 1
        tail = sess.tail if sess else None
        self.emit(ts, "enter", f"{tail or '····'} 입차 (자율 탐색)", ramp=RAMPS[ramp]["id"], guided=False)
        return {"guided": False, "slot": None, "display": self.vacancy_lines(tail)}

    def _set_occ(self, s: int, plate_hash: str | None) -> None:
        self.status[s], self.holder[s], self.occupant[s] = OCC, None, plate_hash or "?"

    def _park(self, sess: Session, s: int, ts: datetime) -> None:
        sess.complied = sess.slot == s
        sess.status, sess.parked_slot, sess.parked_at, sess.hold_expires_at = "parked", s, ts, None
        self.counters["comply" if sess.complied else "ignore"] += 1

    def on_slot(self, s: int, new: int, plate_hash: str | None, ts: datetime) -> str:
        """면 센서 · 관제 상태 변경. 관제 우선 원칙에 따라 hold보다 먼저 반영한다."""
        st = int(self.status[s])
        label = self.fac.slots[s].label
        if new == OCC:
            hs = self.sessions.get(self.holder[s]) if st == HELD and self.holder[s] else None
            if hs is not None:
                if (plate_hash and plate_hash == hs.plate_hash) or (plate_hash is None and hs.status == "entered"):
                    self._set_occ(s, plate_hash or hs.plate_hash)
                    self._park(hs, s, ts)
                    return "complied"
                self._set_occ(s, plate_hash)
                self.emit(ts, "conflict", f"{label} 다른 차량 점유 → {hs.tail} 배정 해제", slot=label)
                self.lost_hold(hs, ts, "다른 차량 점유")
            else:
                if st == CLOSED:
                    self.emit(ts, "sensor", f"{label} 폐쇄 구역 점유 감지", slot=label)
                self._set_occ(s, plate_hash)
            ps = self.session_for_plate(plate_hash)
            if ps is not None and ps is not hs and ps.parked_slot is None and ps.status in ("waiting", "assigned", "entered"):
                if ps.slot is not None and ps.slot != s:
                    hlabel = self.fac.slots[ps.slot].label
                    self._release(ps)
                    self.emit(ts, "ignore", f"{ps.tail} 배정 무시 · {label}에 주차 (배정 {hlabel} 해제)", slot=label)
                self._park(ps, s, ts)
            return "occupied"
        if new == FREE:
            if st in (OCC, BLOCKED):
                self.status[s], self.occupant[s] = FREE, None
            return "free"
        hs = self.sessions.get(self.holder[s]) if st == HELD and self.holder[s] else None
        self.status[s], self.holder[s] = BLOCKED, None
        self.counters["sensor"] += 1
        self.emit(ts, "sensor", f"{label} 센서·LPR 불일치 → BLOCKED", slot=label)
        if hs:
            self.lost_hold(hs, ts, "센서 불일치")
        return "blocked"

    def on_exit(self, plate_hash: str | None, ts: datetime, sess: Session | None = None) -> None:
        sess = sess or self.session_for_plate(plate_hash)
        self.counters["exit"] += 1
        if sess is None or sess.status != "parked":
            return
        sess.status, sess.exited_at = "exited", ts
        s = sess.parked_slot
        if s is not None and self.status[s] == OCC and self.occupant[s] == sess.plate_hash:
            self.status[s], self.occupant[s] = FREE, None
        if sess.plate_hash and self.by_plate.get(sess.plate_hash) == sess.token:
            del self.by_plate[sess.plate_hash]

    def on_gate(self, ramp: int, wait_s: float, searching: int) -> None:
        self.gate_wait[ramp], self.searching[ramp] = float(wait_s), int(searching)

    # ---------- 운영 조치 ----------
    def apply_operation(self, op: dict, now: datetime) -> str:
        t = op["type"]
        if t in ("OPEN_ZONE", "CLOSE_ZONE"):
            if not op.get("floor") or not op.get("zone"):
                raise ValueError("floor와 zone이 필요합니다")
            f, z, n = FLOORS.index(op["floor"]), op["zone"], 0
            for sl in self.fac.slots:
                if sl.f != f or sl.zone != z:
                    continue
                st = self.status[sl.i]
                if t == "OPEN_ZONE" and st == CLOSED:
                    self.status[sl.i] = FREE
                    n += 1
                elif t == "CLOSE_ZONE" and st in (FREE, HELD):
                    hs = self.sessions.get(self.holder[sl.i]) if st == HELD else None
                    self.status[sl.i], self.holder[sl.i] = CLOSED, None
                    n += 1
                    if hs:
                        self.lost_hold(hs, now, "구역 폐쇄")
            msg = f"{op['floor']} {z}구역 {'임시 개방' if t == 'OPEN_ZONE' else '폐쇄'} ({n}면)"
        elif t == "ENGINE_OFF":
            self.engine_on = False
            n = 0
            for sess in self.sessions.values():
                if sess.status == "assigned":
                    self._release(sess)
                    sess.slot, sess.status = None, "waiting"
                    n += 1
            msg = f"배정 엔진 중지 — 열화 모드, hold {n}건 해제 (기존 방식 주차)"
        elif t == "ENGINE_ON":
            self.engine_on = True
            msg = "배정 엔진 재가동"
        elif t == "SET_WEIGHTS":
            w = op.get("weights") or {}
            if not w or any(k not in DEFAULT_W or not 0 <= float(v) <= 10 for k, v in w.items()):
                raise ValueError("weights는 w1~w5, 0~10 범위여야 합니다")
            self.weights.update({k: float(v) for k, v in w.items()})
            msg = "비용 가중치 변경 " + " · ".join(f"{k}={v:g}" for k, v in self.weights.items())
        elif t == "SET_HOLD_CAP":
            v = op.get("value")
            if v is None or not 0.1 <= float(v) <= 1.0:
                raise ValueError("value는 0.1~1.0이어야 합니다")
            self.hold_cap = float(v)
            msg = f"hold 상한 {self.hold_cap:.0%}"
        elif t == "STAFF":
            msg = f"{op.get('ramp') or '서측'} 램프 진입 유도요원 배치"
        else:
            raise ValueError(f"알 수 없는 조치: {t}")
        self.emit(now, "op", "운영 조치: " + msg)
        return msg

    # ---------- 조회 ----------
    def session_view(self, sess: Session) -> dict:
        z = ZONES[sess.zone]
        return {
            "status": sess.status, "facility_id": self.fac.id,
            "reservation": {"appointment_at": iso(sess.appointment_at), "zone_id": z["id"], "zone_name": z["name"]},
            "consent": sess.consent, "plate_tail": sess.plate_tail,
            "eta": iso(sess.eta), "eta_std_s": round(sess.eta_std_s), "eta_source": sess.eta_source,
            "eta_updated_at": iso(sess.eta_updated_at), "route": sess.route,
            "assign_at": iso(sess.eta - timedelta(seconds=ASSIGN_LEAD_S)) if sess.eta else None,
            "slot": self.fac.slots[sess.slot].label if sess.slot is not None else None,
            "hold_expires_at": iso(sess.hold_expires_at), "reassigns": sess.reassigns, "expired": sess.expired,
        }

    def _cand_view(self, c: dict) -> dict:
        return {"s": c["s"], "label": self.fac.slots[c["s"]].label, "ramp": c["ramp"],
                **{k: round(float(c[k]), 1) for k in ("drive", "walk", "ramp_pen", "floor_pen", "mismatch", "total")}}

    def assignment_view(self, sess: Session, now: datetime, preview: bool = False) -> dict:
        ctx = self.ctx(now)
        v = sess.vehicle or VehicleProfile(sess.zone)
        state, parts = "pending", None
        if sess.slot is not None and (self._holds(sess) or sess.status in ("entered", "parked")):
            state = "confirmed" if sess.status in ("entered", "parked") else "assigned"
            parts = cost_parts(self.fac, v, sess.slot, ctx, self.weights, ramp_fixed=sess.ramp)
            if parts is None:   # 속성 불일치 슬롯을 게이트에서 받은 경우에도 설명은 보여준다
                parts = {"s": sess.slot, "ramp": sess.ramp, "drive": float(self.fac.drive[sess.slot, sess.ramp]), "walk": 0.0,
                         "ramp_pen": 0.0, "floor_pen": 0.0, "mismatch": 0.0, "total": 0.0}
        elif preview and sess.consent and self.engine_on:
            top = rank_slots(self.fac, self.status, v, ctx, self.weights, 1)
            if top:
                parts, state = top[0], "preview"
        cands = rank_slots(self.fac, self.status, v, ctx, self.weights, 5)
        if parts and all(c["s"] != parts["s"] for c in cands):
            cands = [parts] + cands[:4]
        free, held = int((self.status == FREE).sum()), int((self.status == HELD).sum())
        out = {
            "status": state, "engine_on": self.engine_on,
            "eta": iso(sess.eta), "eta_std_s": round(sess.eta_std_s), "eta_source": sess.eta_source,
            "appointment_at": iso(sess.appointment_at),
            "assign_at": iso(sess.eta - timedelta(seconds=ASSIGN_LEAD_S)) if sess.eta else None,
            "assigned_at": iso(sess.assigned_at),
            "hold_expires_at": iso(sess.hold_expires_at or (self._hold_exp(sess) if sess.eta and state != "confirmed" else None)),
            "candidates": [self._cand_view(c) for c in cands],
            "state": {"at": iso(now), "free": free, "held": held, "gate_wait_s": [round(x) for x in self.gate_wait], "searching": list(self.searching)},
        }
        if parts:
            s, ramp = parts["s"], parts["ramp"]
            sl = self.fac.slots[s]
            walk = self.fac.walk_parts(s, sess.zone, hour_index(sess.eta or now))
            t = turn_of(sl, ramp)
            out.update({
                "slot": {"index": s, "label": sl.label, "floor": FLOORS[sl.f], "zone": sl.zone, "num": sl.num, "lane": sl.lane},
                "ramp": {"index": ramp, "id": RAMPS[ramp]["id"], "name": RAMPS[ramp]["name"]},
                "drive_s": round(parts["drive"], 1), "walk_s": round(walk["total_s"], 1),
                "walk": {k: (round(v, 1) if isinstance(v, float) else v) for k, v in walk.items()},
                "turn": t, "display": [f"{sess.tail} 차량", f"{FLOORS[sl.f]} {sl.zone}-{sl.num} {t['arrow']}{t['word']}"],
            })
        return out

    def forecast_view(self, now: datetime, horizon_min: int = 120) -> dict:
        items: list[tuple[float, float]] = []
        floor_ts = now.timestamp() - 3 * 3600
        for r in self.reservations.values():
            sess = self.sessions.get(self.by_res.get(r.token, ""))
            if sess and sess.status in ("entered", "parked", "exited"):
                continue
            if sess and sess.eta and sess.eta_source != "reservation-prior":
                mu, sd = sess.eta.timestamp(), sess.eta_std_s
            else:
                mu, sd = (r.appointment_at - timedelta(seconds=PRIOR_LEAD_S)).timestamp(), PRIOR_STD_S
            if mu >= floor_ts:
                items.append((mu, sd))
        start = now.replace(minute=now.minute - now.minute % 15, second=0, microsecond=0)
        issue = now.timestamp()
        buckets = []
        for i in range(math.ceil(horizon_min / 15)):
            b0 = start + timedelta(minutes=15 * i)
            b1 = b0 + timedelta(minutes=15)
            f = forecast_bucket(items, b0.timestamp(), b1.timestamp(), issue, walkin_rate(self.fac, b0))
            buckets.append({"start": iso(b0), "end": iso(b1), **{k: round(v, 1) for k, v in f.items()}})
        recent = []
        for i in range(8, 0, -1):
            b0 = start - timedelta(minutes=15 * i)
            b1 = b0 + timedelta(minutes=15)
            recent.append({"start": iso(b0), "count": sum(1 for t in self.entries if b0.timestamp() <= t < b1.timestamp())})
        return {"issued_at": iso(now), "horizon_min": horizon_min, "model": "예약 사전분포 + 내비 ETA + 비예약 시간대 기저 수요",
                "buckets": buckets, "recent_actual": recent}

    def state_view(self, now: datetime, include_slots: bool = False) -> dict:
        floors = []
        for f in range(3):
            st = self.status[self.fac.floor_of == f]
            open_ = int(((st != CLOSED) & (st != BLOCKED)).sum())
            occ, held = int((st == OCC).sum()), int((st == HELD).sum())
            floors.append({"floor": FLOORS[f], "open": open_, "occupied": occ, "held": held, "free": int((st == FREE).sum()),
                           "blocked": int((st == BLOCKED).sum()), "closed": int((st == CLOSED).sum()),
                           "rate": round((occ + held) / open_, 3) if open_ else None})
        out = {"at": iso(now), "floors": floors, "gate_wait_s": [round(x, 1) for x in self.gate_wait], "searching": list(self.searching),
               "engine_on": self.engine_on, "hold_cap": self.hold_cap, "weights": self.weights,
               "sessions": dict(Counter(s.status for s in self.sessions.values())), "counters": dict(self.counters)}
        if include_slots:
            out["slots"] = "".join(str(int(x)) for x in self.status)
            out["slot_codes"] = {"0": "FREE", "1": "HELD", "2": "OCCUPIED", "3": "BLOCKED", "4": "CLOSED"}
        return out
