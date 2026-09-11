"""내비 제공자 어댑터: 요청 형식, 응답 파싱, 실패 시 대체 순서."""
import asyncio
import json
from datetime import datetime

import httpx
import pytest

from app import nav
from app.config import KST
from conftest import make_settings

TMAP_SAMPLE = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [127.1112, 37.3947]},
     "properties": {"totalDistance": 18432, "totalTime": 1985, "totalFare": 0, "taxiFare": 21300, "index": 0, "pointType": "S"}},
    {"type": "Feature", "geometry": {"type": "LineString", "coordinates": []}, "properties": {"index": 1, "distance": 120, "time": 30}},
]}
KAKAO_SAMPLE = {"trans_id": "t", "routes": [{"result_code": 0, "result_msg": "길찾기 성공",
                                             "summary": {"distance": 18110, "duration": 2040, "fare": {"taxi": 21000, "toll": 0}}}]}
DEPART = datetime(2026, 9, 14, 9, 30, tzinfo=KST)
PANGYO = (37.3947, 127.1112)
DEST = (37.5006, 127.0364)


def run(pref, handler, **keys):
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await nav.estimate(pref, *PANGYO, *DEST, DEPART, make_settings(**keys), c, "한결종합병원")
    return asyncio.run(go())


def test_parse_tmap():
    e = nav.parse_tmap(TMAP_SAMPLE)
    assert (e.provider, e.duration_s, e.distance_m, e.traffic) == ("tmap", 1985, 18432, True)
    assert e.std_s == pytest.approx(180.0)


def test_parse_kakao_success_and_failure():
    e = nav.parse_kakao(KAKAO_SAMPLE)
    assert (e.provider, e.duration_s, e.distance_m) == ("kakao", 2040, 18110)
    with pytest.raises(nav.NavError):
        nav.parse_kakao({"routes": [{"result_code": 104, "result_msg": "출발지와 도착지가 너무 가깝습니다"}]})


def test_tmap_request_shape():
    seen = {}

    def handler(req: httpx.Request):
        seen.update(url=str(req.url), key=req.headers.get("appKey"), body=json.loads(req.content))
        return httpx.Response(200, json=TMAP_SAMPLE)

    est = run("auto", handler, tmap_app_key="K")
    assert est.provider == "tmap" and est.fallback_reason is None
    assert seen["url"].startswith("https://apis.openapi.sk.com/tmap/routes?version=1")
    assert seen["key"] == "K"
    b = seen["body"]
    assert b["startX"].startswith("127.1112") and b["startY"].startswith("37.3947")
    assert b["endX"].startswith("127.0364") and b["reqCoordType"] == "WGS84GEO" and b["searchOption"] == "0"


def test_tmap_failure_falls_back_to_kakao():
    def handler(req: httpx.Request):
        if req.url.host == "apis.openapi.sk.com":
            return httpx.Response(500)
        assert req.headers["Authorization"] == "KakaoAK KK"
        assert req.url.params["origin"].startswith("127.1112") and req.url.params["priority"] == "RECOMMEND"
        return httpx.Response(200, json=KAKAO_SAMPLE)

    est = run("auto", handler, tmap_app_key="K", kakao_rest_key="KK")
    assert est.provider == "kakao"


def test_all_providers_down_uses_model_with_reason():
    est = run("auto", lambda req: httpx.Response(503), tmap_app_key="K", kakao_rest_key="KK")
    assert est.provider == "model" and est.traffic is False
    assert "tmap 오류" in est.fallback_reason and "kakao 오류" in est.fallback_reason


def test_missing_key_is_reported():
    est = run("tmap", lambda req: pytest.fail("키가 없으면 호출하지 않아야 한다"))
    assert est.provider == "model" and "TMAP 키 미설정" in est.fallback_reason


def test_model_route_is_slower_in_rush_hour():
    rush = nav.model_route(*PANGYO, *DEST, datetime(2026, 9, 14, 8, 30, tzinfo=KST))
    night = nav.model_route(*PANGYO, *DEST, datetime(2026, 9, 14, 2, 0, tzinfo=KST))
    assert rush.duration_s > night.duration_s * 1.5
    assert 15_000 < rush.distance_m < 25_000
