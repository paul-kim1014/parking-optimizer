"""데모 드라이버 (DEMO=1): 합성 수요로 가상 시설의 예약 · 관제 어댑터 역할을 대신한다.

실제 배포에서는 이 모듈 대신 시설 어댑터가 /reservations · /events 로 같은 데이터를 보낸다.
모든 상태 변경은 Runtime의 공개 이벤트 처리기(on_entry · on_slot · on_exit · on_gate)를 거친다.
"""
from __future__ import annotations

import heapq
import math
import random
from datetime import date, datetime, time, timedelta

from .config import KST
from .engine import FREE, HELD, OCC, VehicleProfile
from .facility import ZONES
from .runtime import Runtime

DEMO_TOKEN = "DEMO-VISIT"
RES_PROFILE = (0.06, 0.14, 0.16, 0.14, 0.05, 0.10, 0.13, 0.11, 0.07, 0.04)          # 예약 시각 08~17시
WALK_PROFILE = (0.05, 0.09, 0.12, 0.12, 0.11, 0.09, 0.10, 0.10, 0.09, 0.08, 0.05)   # 비예약 도착 07~17시
HANGUL = "가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주"


class DemoDriver:
    def __init__(self, rt: Runtime, day: date, n_res: int = 980, n_walk: int = 420, participation: float = 0.6,
                 eta_share: float = 0.45, compliance: float = 0.65, initial: int = 130, seed: int | None = None):
        self.rt, self.day = rt, day
        self.n_res, self.n_walk, self.initial = n_res, n_walk, initial
        self.participation, self.eta_share, self.compliance = participation, eta_share, compliance
        self.rng = random.Random(seed if seed is not None else int(day.strftime("%Y%m%d")))
        self.day0 = datetime.combine(day, time(0), KST)
        self.arrivals: list[dict] = []
        self.ptr = 0
        self.exits: list[tuple] = []
        self.seq = 0
        self.recent: list[tuple[datetime, int, bool]] = []
        self.started = False
        fac = rt.fac
        # 자율 탐색 순서: B1부터, 진입 램프에서 가까운 순
        self.order = [sorted(range(fac.N), key=lambda s, k=k: (fac.slots[s].f, fac.drive[s, k])) for k in (0, 1)]

    def _plate(self) -> str:
        r = self.rng
        return f"{r.randrange(10, 1000)}{r.choice(HANGUL)}{r.randrange(1000, 10000)}"

    def _dwell(self, median_min: float) -> timedelta:
        return timedelta(minutes=math.exp(math.log(median_min) + 0.35 * self.rng.gauss(0, 1)))

    def seed(self) -> None:
        rng, rt = self.rng, self.rt
        zshare = [z["share"] for z in ZONES]
        for k in range(self.n_res):
            h = rng.choices(range(len(RES_PROFILE)), weights=RES_PROFILE)[0]
            appt = self.day0 + timedelta(hours=8 + h, minutes=10 * rng.randrange(6))
            z = rng.choices(range(len(ZONES)), weights=zshare)[0]
            lead = max(-15.0, min(60.0, rng.gauss(22, 11)))
            arr = appt - timedelta(minutes=lead)
            if rng.random() < 0.04:
                arr += timedelta(minutes=20 + 30 * rng.random())
            token = f"R{self.day0:%m%d}-{k:04d}"
            rt.add_reservation(token, appt, z)
            plate = self._plate()
            ev = rng.random() < .07
            prof = VehicleProfile(z, disabled=rng.random() < .04, ev=ev, ev_want=ev and rng.random() < .5, large=rng.random() < .05)
            v = {"arr": arr, "hash": rt.hash_plate(plate), "ramp": 0 if rng.random() < .65 else 1,
                 "comply": rng.random() < self.compliance, "dwell": self._dwell(ZONES[z]["dwell"]), "token": None}
            part, shared = rng.random() < self.participation, rng.random() < self.eta_share
            if part:
                created = appt - timedelta(hours=18)
                sess = rt.create_session(token, created)
                rt.set_consent(sess, True, created, plate=plate, vehicle=prof)
                if shared:
                    rt.update_eta(sess, arr + timedelta(seconds=rng.gauss(0, 180)), 240.0, "tmap", arr - timedelta(minutes=40), log=False)
                v["token"] = sess.token
            self.arrivals.append(v)
        for _ in range(self.n_walk):
            h = rng.choices(range(len(WALK_PROFILE)), weights=WALK_PROFILE)[0]
            plate = self._plate()
            self.arrivals.append({"arr": self.day0 + timedelta(hours=7 + h, seconds=rng.random() * 3600), "hash": rt.hash_plate(plate),
                                  "ramp": 0 if rng.random() < .65 else 1, "comply": False, "dwell": self._dwell(70), "token": None})
        self.arrivals.sort(key=lambda v: v["arr"])

    def _push_exit(self, ts: datetime, s: int, plate_hash: str, token: str | None) -> None:
        self.seq += 1
        heapq.heappush(self.exits, (ts, self.seq, s, plate_hash, token))

    def _place_initial(self) -> None:
        fac, rng = self.rt.fac, self.rng
        t7 = self.day0 + timedelta(hours=7)
        plain = [s.i for s in fac.slots if not (s.closed_default or s.disabled or s.ev or s.compact)]
        for s in rng.sample(plain, self.initial):
            h = self.rt.hash_plate(self._plate())
            self.rt.on_slot(s, OCC, h, t7)
            self._push_exit(t7 + timedelta(minutes=30 + rng.random() * 540), s, h, None)

    def _search(self, ramp: int) -> int | None:
        rt, rng, fac = self.rt, self.rng, self.rt.fac
        for s in self.order[ramp]:
            st = rt.status[s]
            if st == HELD:
                if rng.random() >= 0.25:     # 노란 배정석은 대부분 비켜 간다
                    continue
            elif st != FREE:
                continue
            sl = fac.slots[s]
            if sl.disabled or (sl.ev and rng.random() > 0.1) or rng.random() < 0.15:
                continue
            return s
        return None

    def _arrive(self, v: dict) -> None:
        rt, ts = self.rt, v["arr"]
        sess = rt.sessions.get(v["token"]) if v["token"] else None
        follows = sess is not None and v["comply"]
        ramp = sess.ramp if (follows and sess.status == "assigned" and sess.ramp is not None) else v["ramp"]
        res = rt.on_entry(v["hash"], ramp, ts, sess=sess)
        guided = res["guided"] and follows
        self.recent.append((ts, ramp, guided))
        s = sess.slot if guided else self._search(ramp)
        if s is None:
            return
        park_ts = ts + timedelta(seconds=90)
        rt.on_slot(s, OCC, v["hash"], park_ts)
        self._push_exit(park_ts + v["dwell"], s, v["hash"], v["token"])

    def _gate(self, now: datetime) -> None:
        cutoff = now - timedelta(minutes=5)
        self.recent = [r for r in self.recent if r[0] > cutoff]
        for k in (0, 1):
            n = sum(1 for r in self.recent if r[1] == k)
            searching = sum(1 for r in self.recent if r[1] == k and not r[2])
            rho = min(0.95, n * 11 / 300)
            self.rt.on_gate(k, 11 * rho / (1 - rho), searching // 2)

    def step(self, now: datetime) -> None:
        if not self.started:
            self._place_initial()
            self.started = True
        while self.exits and self.exits[0][0] <= now:
            ts, _, s, h, tok = heapq.heappop(self.exits)
            if self.rt.occupant[s] == h:
                self.rt.on_slot(s, FREE, None, ts)
            if tok:
                self.rt.on_exit(h, ts, sess=self.rt.sessions.get(tok))
        while self.ptr < len(self.arrivals) and self.arrivals[self.ptr]["arr"] <= now:
            self._arrive(self.arrivals[self.ptr])
            self.ptr += 1
        self._gate(now)

    def fast_forward(self, until: datetime) -> None:
        """서버 시작 시 07:00부터 현재 시각까지 5분 단위로 하루를 재생해 상태를 채운다."""
        t = self.day0 + timedelta(hours=7)
        while t <= until:
            self.step(t)
            self.rt.tick(t, window_s=300)
            t += timedelta(minutes=5)
        self.step(until)
        self.rt.tick(until)
