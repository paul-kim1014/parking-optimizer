"""8.2 배정 최적화 · 8.1 도착 예측.

비용 함수는 engine.js와 같다. 일괄 배정(롤링 호라이즌)은 SciPy linear_sum_assignment(헝가리안 계열)로 푼다.
cost(v, s) = w1·drive + w2·walk + w3·ramp_penalty + w4·floor_balance + w5·mismatch  (단위: 초 환산)
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

import numpy as np
from scipy.optimize import linear_sum_assignment

from .config import KST
from .facility import Facility, Slot

FREE, HELD, OCC, BLOCKED, CLOSED = 0, 1, 2, 3, 4
STATUS_NAMES = ("FREE", "HELD", "OCCUPIED", "BLOCKED", "CLOSED")
INF = 1e7
DEFAULT_W = {"w1": 1.0, "w2": 1.5, "w3": 1.0, "w4": 1.0, "w5": 1.0}
WALK_PROFILE = (0.05, 0.09, 0.12, 0.12, 0.11, 0.09, 0.10, 0.10, 0.09, 0.08, 0.05)  # 비예약 도착 07~17시


@dataclass
class VehicleProfile:
    zone: int
    disabled: bool = False
    ev: bool = False
    ev_want: bool = False
    large: bool = False


@dataclass(frozen=True)
class Ctx:
    h: int
    ramp_pen: tuple[float, float]
    floor_pen: tuple[float, float, float]


def make_ctx(fac: Facility, status: np.ndarray, h: int, gate_wait=(0.0, 0.0), searching=(0, 0), pending=(0, 0)) -> Ctx:
    ramp_pen = tuple(max(0.0, float(gate_wait[k])) + 2 * searching[k] + 1.5 * pending[k] for k in (0, 1))
    usable = (status != CLOSED) & (status != BLOCKED)
    rates = []
    for f in range(3):
        on = usable & (fac.floor_of == f)
        n = int(on.sum())
        rates.append(float(((status != FREE) & on).sum()) / n if n else 1.0)
    mean = sum(rates) / 3
    return Ctx(h, ramp_pen, tuple(max(0.0, r - mean) * 300 for r in rates))


def cost_parts(fac: Facility, v: VehicleProfile, s: int, ctx: Ctx, w: dict, ramp_fixed: int | None = None) -> dict | None:
    sl = fac.slots[s]
    if (sl.disabled and not v.disabled) or (sl.compact and v.large):
        return None
    mis = 0.0
    if v.disabled and not sl.disabled:
        mis += 60
    if sl.ev and not v.ev:
        mis += 120
    if v.ev_want and not sl.ev:
        mis += 90
    if ramp_fixed is None:
        d0 = w["w1"] * fac.drive[s, 0] + w["w3"] * ctx.ramp_pen[0]
        d1 = w["w1"] * fac.drive[s, 1] + w["w3"] * ctx.ramp_pen[1]
        ramp = 0 if d0 <= d1 else 1
    else:
        ramp = ramp_fixed
    drive, walk = float(fac.drive[s, ramp]), fac.walk(s, v.zone, ctx.h)
    rp, fp = ctx.ramp_pen[ramp], ctx.floor_pen[sl.f]
    total = w["w1"] * drive + w["w2"] * walk + w["w3"] * rp + w["w4"] * fp + w["w5"] * mis
    return {"s": s, "ramp": ramp, "drive": drive, "walk": walk, "ramp_pen": rp, "floor_pen": fp, "mismatch": mis, "total": total}


def cost_row(fac: Facility, v: VehicleProfile, ctx: Ctx, w: dict, ramp_fixed: int | None = None) -> np.ndarray:
    """모든 슬롯에 대한 비용 벡터 (cost_parts와 같은 값, 벡터화)."""
    if ramp_fixed is None:
        d0 = w["w1"] * fac.drive[:, 0] + w["w3"] * ctx.ramp_pen[0]
        d1 = w["w1"] * fac.drive[:, 1] + w["w3"] * ctx.ramp_pen[1]
        dr = np.minimum(d0, d1)
    else:
        dr = w["w1"] * fac.drive[:, ramp_fixed] + w["w3"] * ctx.ramp_pen[ramp_fixed]
    mis = (~fac.is_disabled & v.disabled) * 60.0 + (fac.is_ev & (not v.ev)) * 120.0 + (~fac.is_ev & v.ev_want) * 90.0
    total = dr + w["w2"] * fac.walk_tab[ctx.h, :, v.zone] + w["w4"] * np.asarray(ctx.floor_pen)[fac.floor_of] + w["w5"] * mis
    forbid = (fac.is_disabled & (not v.disabled)) | (fac.is_compact & v.large)
    return np.where(forbid, INF, total)


def rank_slots(fac: Facility, status: np.ndarray, v: VehicleProfile, ctx: Ctx, w: dict, limit: int = 5) -> list[dict]:
    row = np.where(status == FREE, cost_row(fac, v, ctx, w), INF)
    order = np.argsort(row, kind="stable")[:limit]
    return [cost_parts(fac, v, int(s), ctx, w) for s in order if row[s] < INF]


def solve_batch(fac: Facility, status: np.ndarray, rows: list[VehicleProfile], ctx: Ctx, w: dict, k: int = 24) -> list[int | None]:
    """롤링 호라이즌 일괄 배정: 행(차량) × 후보 슬롯 비용 행렬의 최소 비용 매칭."""
    out: list[int | None] = [None] * len(rows)
    free = np.flatnonzero(status == FREE)
    if not rows or free.size == 0:
        return out
    use = rows[: free.size]
    full = np.vstack([cost_row(fac, v, ctx, w)[free] for v in use])
    cols: set[int] = set()
    for r in full:
        cols.update(np.argsort(r, kind="stable")[:k].tolist())
    j = 0
    while len(cols) < len(use) and j < free.size:
        cols.add(j)
        j += 1
    cl = np.array(sorted(cols))
    sub = full[:, cl]
    ri, ci = linear_sum_assignment(sub)
    for r, c in zip(ri, ci):
        if sub[r, c] < INF:
            out[r] = int(free[cl[c]])
    return out


def turn_of(sl: Slot, ramp: int) -> dict:
    if sl.lane == 1:
        return {"arrow": "↑", "word": "직진"}
    left = (ramp == 0) == (sl.lane == 0)
    return {"arrow": "←", "word": "좌회전"} if left else {"arrow": "→", "word": "우회전"}


# ---------- 8.1 도착 예측 (집계) ----------
def phi(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def walkin_rate(fac: Facility, dt: datetime) -> float:
    idx = dt.astimezone(KST).hour - 7
    return fac.walkin_daily * WALK_PROFILE[idx] if 0 <= idx < len(WALK_PROFILE) else 0.0


def forecast_bucket(items: list[tuple[float, float]], b0: float, b1: float, issue: float, walk_per_hour: float) -> dict:
    """items = 아직 도착하지 않은 예약 차량의 (도착 평균, 표준편차) epoch 초. 발행 시점 이후 도착으로 조건부."""
    lo = max(b0, issue)
    lam = 0.0
    if b1 > lo:
        for mu, sd in items:
            tail = max(0.02, 1 - phi((issue - mu) / sd))
            lam += (phi((b1 - mu) / sd) - phi((lo - mu) / sd)) / tail
        lam += walk_per_hour * (b1 - lo) / 3600
    sd = math.sqrt(lam + (0.12 * lam) ** 2)
    return {"p10": max(0.0, lam - 1.2816 * sd), "p50": lam, "p90": lam + 1.2816 * sd}
