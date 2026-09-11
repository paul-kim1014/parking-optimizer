"""내비게이션 경로 기반 도착 예정 시각(ETA).

제공자
- tmap : TMAP 자동차 경로안내 API (SK open API). searchOption=0(교통최적+추천)으로 실시간 교통을 반영한다.
- kakao: 카카오모빌리티 길찾기 API. 실시간 교통을 반영한다.
- model: 키가 없거나 외부 API가 실패할 때 쓰는 교통 패턴 모델(시간대별 평균 속도). 정확도가 낮다.
auto는 tmap → kakao → model 순서로 시도한다.

현재 위치 좌표는 이 요청 안에서만 쓰고 저장하지 않는다(7.4). 결과로는 소요 시간 · 거리 · 제공자만 남긴다.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import datetime

import httpx

from .config import KST, Settings

TMAP_URL = "https://apis.openapi.sk.com/tmap/routes?version=1&format=json"
KAKAO_URL = "https://apis-navi.kakaomobility.com/v1/directions"

# 교통 패턴 모델: 시간대(0~23시)별 도심 · 간선 평균 속도(km/h) [가정] — nav.js와 같은 값
URBAN_KMH = (38, 40, 40, 40, 38, 34, 30, 26, 19, 21, 25, 26, 26, 26, 25, 25, 24, 20, 18, 22, 28, 32, 34, 36)
HWY_KMH = (85, 88, 88, 88, 85, 78, 68, 60, 42, 50, 62, 65, 66, 66, 65, 64, 60, 45, 40, 55, 68, 75, 80, 82)


class NavError(Exception):
    pass


@dataclass
class RouteEstimate:
    provider: str
    duration_s: float
    distance_m: float
    traffic: bool
    std_s: float
    fallback_reason: str | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def nav_std(duration_s: float, traffic: bool) -> float:
    """ETA 표준편차 [가정]: 실시간 교통 경로는 소요 시간의 8%(최소 3분), 모델은 15%(최소 4분)."""
    return max(180.0, 0.08 * duration_s) if traffic else max(240.0, 0.15 * duration_s)


def haversine_km(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    r, to = 6371.0088, math.pi / 180
    d_lat, d_lng = (b_lat - a_lat) * to, (b_lng - a_lng) * to
    x = math.sin(d_lat / 2) ** 2 + math.cos(a_lat * to) * math.cos(b_lat * to) * math.sin(d_lng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))


def model_route(o_lat: float, o_lng: float, d_lat: float, d_lng: float, depart: datetime) -> RouteEstimate:
    air = haversine_km(o_lat, o_lng, d_lat, d_lng)
    km = air * (1.25 + 0.15 * math.exp(-air / 5))       # 도로 우회 계수 (근거리일수록 큼)
    urban = min(km, 6 + 0.15 * max(0.0, km - 6))       # 출발 · 도착 주변 도심 구간
    hwy = km - urban
    h = depart.astimezone(KST).hour
    dur = urban / URBAN_KMH[h] * 3600 + hwy / HWY_KMH[h] * 3600 + 90
    return RouteEstimate("model", dur, km * 1000, False, nav_std(dur, False))


def parse_tmap(data: dict) -> RouteEstimate:
    for feat in data.get("features") or []:
        p = feat.get("properties") or {}
        if "totalTime" in p:
            dur = float(p["totalTime"])
            return RouteEstimate("tmap", dur, float(p.get("totalDistance", 0)), True, nav_std(dur, True))
    raise NavError("TMAP 응답에 totalTime이 없습니다")


def parse_kakao(data: dict) -> RouteEstimate:
    routes = data.get("routes") or []
    if not routes:
        raise NavError("카카오 길찾기 응답에 경로가 없습니다")
    r0 = routes[0]
    if r0.get("result_code") != 0:
        raise NavError(f"카카오 길찾기 실패: {r0.get('result_msg', r0.get('result_code'))}")
    s = r0["summary"]
    dur = float(s["duration"])
    return RouteEstimate("kakao", dur, float(s["distance"]), True, nav_std(dur, True))


async def tmap_route(client: httpx.AsyncClient, key: str, o_lat: float, o_lng: float, d_lat: float, d_lng: float, dest_name: str) -> RouteEstimate:
    body = {
        "startX": f"{o_lng:.7f}", "startY": f"{o_lat:.7f}",
        "endX": f"{d_lng:.7f}", "endY": f"{d_lat:.7f}",
        "reqCoordType": "WGS84GEO", "resCoordType": "WGS84GEO",
        "searchOption": "0", "trafficInfo": "N",
        "startName": "출발지", "endName": dest_name,
    }
    r = await client.post(TMAP_URL, json=body, headers={"appKey": key, "Accept": "application/json"})
    if r.status_code != 200:
        raise NavError(f"TMAP HTTP {r.status_code}")
    return parse_tmap(r.json())


async def kakao_route(client: httpx.AsyncClient, key: str, o_lat: float, o_lng: float, d_lat: float, d_lng: float) -> RouteEstimate:
    params = {"origin": f"{o_lng:.7f},{o_lat:.7f}", "destination": f"{d_lng:.7f},{d_lat:.7f}", "priority": "RECOMMEND", "summary": "true"}
    r = await client.get(KAKAO_URL, params=params, headers={"Authorization": f"KakaoAK {key}"})
    if r.status_code != 200:
        raise NavError(f"카카오 HTTP {r.status_code}")
    return parse_kakao(r.json())


ORDER = {"auto": ("tmap", "kakao", "model"), "tmap": ("tmap", "model"), "kakao": ("kakao", "model"), "model": ("model",)}


async def estimate(pref: str, o_lat: float, o_lng: float, d_lat: float, d_lng: float, depart: datetime,
                   settings: Settings, client: httpx.AsyncClient, dest_name: str) -> RouteEstimate:
    reasons: list[str] = []
    for p in ORDER[pref]:
        try:
            if p == "tmap":
                if not settings.tmap_app_key:
                    reasons.append("TMAP 키 미설정")
                    continue
                return await tmap_route(client, settings.tmap_app_key, o_lat, o_lng, d_lat, d_lng, dest_name)
            if p == "kakao":
                if not settings.kakao_rest_key:
                    reasons.append("카카오 키 미설정")
                    continue
                return await kakao_route(client, settings.kakao_rest_key, o_lat, o_lng, d_lat, d_lng)
        except (NavError, httpx.HTTPError, ValueError, KeyError, TypeError) as e:
            reasons.append(f"{p} 오류: {e}")
            continue
        est = model_route(o_lat, o_lng, d_lat, d_lng, depart)
        est.fallback_reason = "; ".join(reasons) or None
        return est
    raise NavError("; ".join(reasons))
