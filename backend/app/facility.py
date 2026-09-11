"""7.1 주차장 그래프 모델 (가상 파일럿 시설 '한결종합병원').

engine.js의 buildFacility()와 같은 식을 쓴다. tests/test_facility.py가 두 구현의 비용 표를 교차 검증한다.
좌표 단위는 m, 시간 단위는 초. 시간대 인덱스 h는 07시=0 … 19시=12.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from .config import KST

FLOORS = ("B1", "B2", "B3")
COLS, X0, SW, SD, W, H = 32, 10.0, 2.5, 5.0, 100.0, 48.0
ROW_Y = (0, 11, 16, 27, 32, 43)
ROW_LANE = (0, 0, 1, 1, 2, 2)
LANE_Y = (8, 24, 40)
RAMPS = (
    {"id": "W", "name": "서측 램프", "x": 5.0},
    {"id": "E", "name": "동측 램프", "x": 95.0},
)
ELEV = (
    {"id": "E1", "bld": "본관", "cols": (6, 7, 8), "rows": (1, 2), "base": 25.0},
    {"id": "E2", "bld": "본관", "cols": (15, 16, 17), "rows": (1, 2), "base": 38.0},
    {"id": "E3", "bld": "외래동", "cols": (20, 21, 22), "rows": (3, 4), "base": 30.0},
    {"id": "E4", "bld": "외래동", "cols": (27, 28, 29), "rows": (3, 4), "base": 26.0},
)
for _e in ELEV:
    _e["x"] = X0 + SW * _e["cols"][0] + SW * 1.5
    _e["y"] = (ROW_Y[_e["rows"][0]] + ROW_Y[_e["rows"][1]] + SD) / 2

# 목적지 존. lobby = 승강기 하차 후 진료과 입구까지 도보 거리(m), 승강기 E1~E4 순
ZONES = (
    {"id": "CARD", "name": "본관 3층 심장내과", "short": "심장내과", "fl": 3, "lobby": (55, 18, 150, 185), "share": .16, "dwell": 100},
    {"id": "RAD", "name": "본관 1층 영상의학과", "short": "영상의학과", "fl": 1, "lobby": (20, 40, 130, 170), "share": .12, "dwell": 70},
    {"id": "GI", "name": "본관 5층 소화기내과", "short": "소화기내과", "fl": 5, "lobby": (15, 50, 160, 195), "share": .14, "dwell": 120},
    {"id": "ORTHO", "name": "외래동 2층 정형외과", "short": "정형외과", "fl": 2, "lobby": (150, 120, 15, 50), "share": .16, "dwell": 90},
    {"id": "EYE", "name": "외래동 4층 안과", "short": "안과", "fl": 4, "lobby": (175, 140, 45, 15), "share": .12, "dwell": 80},
    {"id": "ONC", "name": "암센터 2층 종양내과", "short": "종양내과", "fl": 2, "lobby": (190, 160, 60, 20), "share": .14, "dwell": 180},
    {"id": "PED", "name": "외래동 1층 소아청소년과", "short": "소아청소년과", "fl": 1, "lobby": (140, 110, 20, 45), "share": .16, "dwell": 75},
)
NZ = len(ZONES)

# 시간대별 승강기 대기 배수 (07시~19시). 초기값 [가정], 파일럿 실측으로 대체
ELEV_MULT = (1.0, 1.5, 2.4, 2.4, 1.9, 1.3, 1.8, 1.8, 1.5, 1.2, 1.0, 0.9, 0.8)


def elev_wait(e: int, h: int) -> float:
    return ELEV[e]["base"] * ELEV_MULT[max(0, min(12, h))]


def hour_index(dt: datetime) -> int:
    return max(0, min(12, dt.astimezone(KST).hour - 7))


@dataclass(frozen=True, slots=True)
class Slot:
    i: int
    f: int
    r: int
    c: int
    num: int
    zone: str
    x: float
    y: float
    lane: int
    label: str
    disabled: bool
    ev: bool
    compact: bool
    closed_default: bool


class Facility:
    def __init__(self, facility_id: str = "hangyeol", name: str = "한결종합병원",
                 lat: float = 37.5006, lng: float = 127.0364, walkin_daily: int = 420):
        self.id, self.name, self.lat, self.lng, self.walkin_daily = facility_id, name, lat, lng, walkin_daily
        core = {r * COLS + c for e in ELEV for r in e["rows"] for c in e["cols"]}
        slots: list[Slot] = []
        for f in range(3):
            num = 0
            for r in range(6):
                for c in range(COLS):
                    if r * COLS + c in core:
                        continue
                    num += 1
                    zone = "ABCD"[c // 8]
                    slots.append(Slot(
                        i=len(slots), f=f, r=r, c=c, num=num, zone=zone,
                        x=X0 + SW * c + SW / 2, y=ROW_Y[r] + SD / 2, lane=ROW_LANE[r],
                        label=f"{FLOORS[f]}-{zone}-{num:03d}",
                        disabled=f == 0 and any(r in e["rows"] and c in (e["cols"][0] - 1, e["cols"][2] + 1) for e in ELEV),
                        ev=f < 2 and r == 5 and c >= 24,
                        compact=r in (0, 5) and c < 3,
                        closed_default=f == 2 and zone == "D",
                    ))
        self.slots = slots
        self.N = len(slots)
        self.by_label = {s.label: s.i for s in slots}
        # 엣지 비용: 게이트(램프)→슬롯 주행, 슬롯→존 도보(승강기 대기 포함)
        self.drive = np.array([[self._drive(s, 0), self._drive(s, 1)] for s in slots])
        walk = np.zeros((13, self.N, NZ))
        best = np.zeros((13, self.N, NZ), dtype=np.int8)
        for h in range(13):
            for s in slots:
                for z in range(NZ):
                    vals = [self._walk_via(s, z, e, h) for e in range(4)]
                    bi = min(range(4), key=vals.__getitem__)
                    walk[h, s.i, z] = vals[bi]
                    best[h, s.i, z] = bi
        self.walk_tab, self.best_e = walk, best
        self.floor_of = np.array([s.f for s in slots])
        self.is_disabled = np.array([s.disabled for s in slots])
        self.is_ev = np.array([s.ev for s in slots])
        self.is_compact = np.array([s.compact for s in slots])

    @staticmethod
    def _drive(s: Slot, k: int) -> float:
        return 30 * (s.f + 1) + (abs(s.x - RAMPS[k]["x"]) + abs(LANE_Y[s.lane] - 24)) / 2.8

    @staticmethod
    def _walk_via(s: Slot, z: int, e: int, h: int) -> float:
        E, Z = ELEV[e], ZONES[z]
        return (abs(s.x - E["x"]) + abs(s.y - E["y"])) / 1.1 + elev_wait(e, h) + (8 + 3 * (s.f + Z["fl"])) + Z["lobby"][e] / 1.1

    def walk(self, s: int, z: int, h: int) -> float:
        return float(self.walk_tab[h, s, z])

    def walk_parts(self, s: int, z: int, h: int) -> dict:
        sl, e = self.slots[s], int(self.best_e[h, s, z])
        E, Z = ELEV[e], ZONES[z]
        to_elev = abs(sl.x - E["x"]) + abs(sl.y - E["y"])
        return {
            "elev": E["id"], "elev_index": e,
            "to_elev_m": round(to_elev), "to_elev_s": to_elev / 1.1,
            "wait_s": elev_wait(e, h), "ride_s": 8 + 3 * (sl.f + Z["fl"]),
            "lobby_m": Z["lobby"][e], "lobby_s": Z["lobby"][e] / 1.1,
            "total_s": self.walk(s, z, h),
        }

    def zone_index(self, zone_id: str) -> int:
        for i, z in enumerate(ZONES):
            if z["id"] == zone_id:
                return i
        raise KeyError(zone_id)

    def meta(self) -> dict:
        return {
            "id": self.id, "name": self.name, "location": {"lat": self.lat, "lng": self.lng},
            "slots": self.N, "floors": list(FLOORS),
            "ramps": [{"id": r["id"], "name": r["name"]} for r in RAMPS],
            "elevators": [{"id": e["id"], "building": e["bld"]} for e in ELEV],
            "zones": [{"id": z["id"], "name": z["name"]} for z in ZONES],
        }
