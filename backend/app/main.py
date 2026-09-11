"""자리먼저 ParkAhead API — 기획서 부록 B 핵심 API + 내비게이션 ETA 연동.

실행:  uvicorn app.main:app --reload     문서:  /docs
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Path, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from . import __version__, nav
from .config import KST, Settings
from .demo import DEMO_TOKEN, DemoDriver
from .engine import BLOCKED, FREE, OCC, VehicleProfile
from .facility import Facility
from .runtime import Runtime, Session, iso
from .schemas import (ConsentIn, EtaIn, EventsIn, OperationIn, PartnerEtaIn, ReservationsIn, SessionCreate)

log = logging.getLogger("parkahead")
STATUS_IN = {"FREE": FREE, "OCCUPIED": OCC, "BLOCKED": BLOCKED}
RAMP_IN = {"W": 0, "E": 1}


def aware(dt: datetime) -> datetime:
    return dt.replace(tzinfo=KST) if dt.tzinfo is None else dt.astimezone(KST)


async def _loop(app: FastAPI) -> None:
    settings: Settings = app.state.settings
    while True:
        await asyncio.sleep(settings.tick_seconds)
        for fid, rt in app.state.runtimes.items():
            try:
                now = rt.now()
                drv = app.state.drivers.get(fid)
                if drv:
                    drv.step(now)
                rt.tick(now)
            except Exception:  # 한 시설의 오류가 루프 전체를 멈추지 않게
                log.exception("tick 실패: %s", fid)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        fac = Facility()
        rt = Runtime(fac, settings)
        app.state.runtimes = {fac.id: rt}
        app.state.drivers = {}
        if settings.demo:
            drv = DemoDriver(rt, rt.now().date())
            drv.seed()
            drv.fast_forward(rt.now())
            app.state.drivers[fac.id] = drv
        if not settings.facility_api_key:
            log.warning("FACILITY_API_KEY 미설정 — 시설용 엔드포인트가 인증 없이 열려 있습니다 (로컬 개발 전용).")
        app.state.http = httpx.AsyncClient(timeout=settings.nav_timeout)
        task = asyncio.create_task(_loop(app)) if settings.tick_loop else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await app.state.http.aclose()

    app = FastAPI(
        title="자리먼저 ParkAhead API", version=__version__, lifespan=lifespan,
        description="도착하기 전에 자리를 정해주는 주차장 — 예약 · 내비 ETA · 관제 이벤트로 슬롯을 배정한다. "
                    "시설용 엔드포인트는 X-Api-Key, 방문객용은 세션 토큰으로 접근한다.",
    )
    app.state.settings = settings
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                       allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "X-Api-Key", "X-Signature"])

    # ---------- 공통 의존성 ----------
    def get_rt(facility_id: str) -> Runtime:
        rt = app.state.runtimes.get(facility_id)
        if rt is None:
            raise HTTPException(404, f"시설 '{facility_id}'을(를) 찾을 수 없습니다.")
        return rt

    def facility_auth(x_api_key: str | None = Header(default=None)) -> None:
        if settings.facility_api_key and not hmac.compare_digest(x_api_key or "", settings.facility_api_key):
            raise HTTPException(401, "시설 API 키가 필요합니다 (X-Api-Key 헤더).")

    def get_session(token: str = Path(min_length=8, max_length=64)) -> tuple[Runtime, Session]:
        for rt in app.state.runtimes.values():
            sess = rt.sessions.get(token)
            if sess:
                return rt, sess
        raise HTTPException(404, "세션을 찾을 수 없습니다. 알림톡 링크를 다시 열어 주세요.")

    def require_demo() -> None:
        if not settings.demo:
            raise HTTPException(404, "데모 모드(DEMO=1)에서만 쓸 수 있습니다.")

    # ---------- 기본 ----------
    @app.get("/", include_in_schema=False)
    def root():
        return {"service": "자리먼저 ParkAhead API", "version": __version__, "docs": "/docs", "demo": settings.demo}

    @app.get("/health", tags=["기본"])
    def health():
        return {"ok": True, "version": __version__, "demo": settings.demo,
                "nav_providers": {"tmap": bool(settings.tmap_app_key), "kakao": bool(settings.kakao_rest_key), "model": True}}

    @app.get("/v1/facilities", tags=["시설"])
    def facilities():
        return {"facilities": [rt.fac.meta() for rt in app.state.runtimes.values()]}

    @app.get("/v1/facilities/{facility_id}", tags=["시설"])
    def facility(facility_id: str):
        return get_rt(facility_id).fac.meta()

    # ---------- 예약 어댑터 ----------
    @app.post("/v1/facilities/{facility_id}/reservations", tags=["시설"], dependencies=[Depends(facility_auth)])
    def reservations(facility_id: str, body: ReservationsIn):
        rt = get_rt(facility_id)
        try:
            zones = [rt.fac.zone_index(r.zone_id) for r in body.reservations]
        except KeyError as e:
            raise HTTPException(422, f"알 수 없는 zone_id: {e.args[0]}") from None
        for r, z in zip(body.reservations, zones):
            rt.add_reservation(r.token, aware(r.appointment_at), z)
        return {"upserted": len(body.reservations)}

    # ---------- 방문객 세션 ----------
    @app.post("/v1/sessions", tags=["방문객"], status_code=201)
    def create_session(body: SessionCreate):
        rt = get_rt(body.facility_id)
        now = rt.now()
        token = body.reservation_token
        if token == DEMO_TOKEN and settings.demo:
            token = rt.add_demo_reservation(now)
        if token not in rt.reservations:
            raise HTTPException(404, "예약을 찾을 수 없습니다. 링크가 만료되었을 수 있습니다.")
        sess = rt.create_session(token, now)
        return {"session_token": sess.token, **rt.session_view(sess),
                "facility": {"id": rt.fac.id, "name": rt.fac.name, "location": {"lat": rt.fac.lat, "lng": rt.fac.lng}}}

    @app.get("/v1/sessions/{token}", tags=["방문객"])
    def session_status(ctx: tuple = Depends(get_session)):
        rt, sess = ctx
        return rt.session_view(sess)

    @app.post("/v1/sessions/{token}/consent", tags=["방문객"])
    def consent(body: ConsentIn, ctx: tuple = Depends(get_session)):
        rt, sess = ctx
        v = body.vehicle
        rt.set_consent(sess, body.consent, rt.now(), plate=body.plate,
                       vehicle=VehicleProfile(sess.zone, disabled=v.disabled, ev=v.ev, ev_want=v.ev and v.ev_charge, large=v.large))
        return rt.session_view(sess)

    @app.post("/v1/sessions/{token}/eta", tags=["방문객"])
    async def eta(body: EtaIn, ctx: tuple = Depends(get_session)):
        """내비 경로(거리 · 실시간 교통)로 도착 예정 시각을 계산한다. 이동 중 주기적으로 다시 호출한다."""
        rt, sess = ctx
        if not sess.consent:
            raise HTTPException(403, "위치 · 도착 시각 공유 동의가 먼저 필요합니다.")
        now = rt.now()
        if body.source == "manual":
            if body.eta is None:
                raise HTTPException(422, "manual 방식에는 eta가 필요합니다.")
            rt.update_eta(sess, aware(body.eta), 480.0, "manual", now, route=None)
            return {**rt.session_view(sess), "cached": False}
        if body.origin is None:
            raise HTTPException(422, "nav 방식에는 origin(현재 위치)이 필요합니다.")
        if sess.last_nav_at and sess.route and (now - sess.last_nav_at).total_seconds() < settings.nav_min_interval:
            return {**rt.session_view(sess), "cached": True}
        try:
            est = await nav.estimate(body.provider, body.origin.lat, body.origin.lng, rt.fac.lat, rt.fac.lng,
                                     now, settings, app.state.http, rt.fac.name)
        except nav.NavError as e:
            raise HTTPException(502, f"경로 계산 실패: {e}") from None
        route = {"provider": est.provider, "traffic": est.traffic, "duration_s": round(est.duration_s),
                 "distance_m": round(est.distance_m), "computed_at": iso(now), "fallback_reason": est.fallback_reason}
        sess.last_nav_at = now
        rt.update_eta(sess, now + timedelta(seconds=est.duration_s), est.std_s, est.provider, now, route=route)
        return {**rt.session_view(sess), "cached": False}

    @app.get("/v1/sessions/{token}/assignment", tags=["방문객"])
    def assignment(preview: bool = Query(False, description="아직 배정 전이면 지금 기준 최적 슬롯을 보여 준다(보관하지 않음)"),
                   ctx: tuple = Depends(get_session)):
        rt, sess = ctx
        return rt.assignment_view(sess, rt.now(), preview)

    # ---------- 데모 전용: 방문객 흐름을 끝까지 따라가기 위한 가상 관제 이벤트 ----------
    @app.post("/v1/sessions/{token}/assign-now", tags=["데모"], dependencies=[Depends(require_demo)])
    def assign_now(ctx: tuple = Depends(get_session)):
        rt, sess = ctx
        now = rt.now()
        if not sess.consent:
            raise HTTPException(403, "동의가 먼저 필요합니다.")
        if sess.status == "waiting":
            b = rt.best_for(sess, now)
            if b is None:
                raise HTTPException(409, "배정 가능한 자리가 없습니다.")
            rt._assign(sess, b[0], b[1], now, "assign", "데모 즉시 배정")
        return rt.assignment_view(sess, now)

    @app.post("/v1/sessions/{token}/demo/enter", tags=["데모"], dependencies=[Depends(require_demo)])
    def demo_enter(ctx: tuple = Depends(get_session)):
        rt, sess = ctx
        ramp = sess.ramp if sess.ramp is not None else 0
        return rt.on_entry(sess.plate_hash, ramp, rt.now(), sess=sess)

    @app.post("/v1/sessions/{token}/demo/park", tags=["데모"], dependencies=[Depends(require_demo)])
    def demo_park(ctx: tuple = Depends(get_session)):
        rt, sess = ctx
        if sess.status != "entered" or sess.slot is None:
            raise HTTPException(409, "입차 후에 주차할 수 있습니다.")
        result = rt.on_slot(sess.slot, OCC, sess.plate_hash, rt.now())
        return {"result": result, **rt.session_view(sess)}

    # ---------- 관제 어댑터 ----------
    @app.post("/v1/facilities/{facility_id}/events", tags=["시설"], dependencies=[Depends(facility_auth)])
    def events(facility_id: str, body: EventsIn):
        """입출차(LPR) · 면 점유 센서 · 게이트 대기 이벤트. 관제 데이터가 hold보다 우선한다."""
        rt = get_rt(facility_id)
        for i, ev in enumerate(body.events):   # 먼저 전부 검증하고 적용 (부분 적용 방지)
            if ev.type in ("ENTRY", "GATE") and ev.ramp is None:
                raise HTTPException(422, f"events[{i}]: {ev.type}에는 ramp(W/E)가 필요합니다.")
            if ev.type == "SLOT" and (ev.slot not in rt.fac.by_label or ev.status is None):
                raise HTTPException(422, f"events[{i}]: 알 수 없는 슬롯 또는 status 누락 ({ev.slot})")
        results = []
        for ev in body.events:
            ts = aware(ev.ts) if ev.ts else rt.now()
            ph = ev.plate_hash or (rt.hash_plate(ev.plate) if ev.plate else None)
            if ev.type == "ENTRY":
                results.append({"type": "ENTRY", **rt.on_entry(ph, RAMP_IN[ev.ramp], ts)})
            elif ev.type == "SLOT":
                results.append({"type": "SLOT", "slot": ev.slot, "result": rt.on_slot(rt.fac.by_label[ev.slot], STATUS_IN[ev.status], ph, ts)})
            elif ev.type == "EXIT":
                rt.on_exit(ph, ts)
                results.append({"type": "EXIT"})
            else:
                rt.on_gate(RAMP_IN[ev.ramp], ev.wait_sec or 0.0, ev.searching or 0)
                results.append({"type": "GATE"})
        return {"results": results}

    @app.post("/v1/facilities/{facility_id}/tick", tags=["시설"], dependencies=[Depends(facility_auth)])
    def tick(facility_id: str):
        """hold 만료 처리와 롤링 호라이즌 배정을 즉시 한 번 돌린다 (평소에는 백그라운드에서 주기 실행)."""
        rt = get_rt(facility_id)
        now = rt.now()
        rt.tick(now)
        return rt.state_view(now)

    # ---------- 운영 · 대시보드 ----------
    @app.get("/v1/facilities/{facility_id}/forecast", tags=["운영"])
    def forecast(facility_id: str, horizon: int = Query(120, ge=15, le=360)):
        rt = get_rt(facility_id)
        return rt.forecast_view(rt.now(), horizon)

    @app.get("/v1/facilities/{facility_id}/state", tags=["운영"])
    def state(facility_id: str, slots: bool = Query(False, description="슬롯별 상태 코드 문자열 포함")):
        rt = get_rt(facility_id)
        return rt.state_view(rt.now(), slots)

    @app.post("/v1/facilities/{facility_id}/operations", tags=["운영"], dependencies=[Depends(facility_auth)])
    def operations(facility_id: str, body: OperationIn):
        rt = get_rt(facility_id)
        try:
            msg = rt.apply_operation(body.model_dump(), rt.now())
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        return {"applied": msg, **rt.state_view(rt.now())}

    @app.get("/v1/facilities/{facility_id}/log", tags=["운영"], dependencies=[Depends(facility_auth)])
    def event_log(facility_id: str, limit: int = Query(50, ge=1, le=500)):
        rt = get_rt(facility_id)
        return {"events": list(rt.log)[-limit:][::-1]}

    # ---------- Phase 2: 내비 파트너 웹훅 ----------
    @app.post("/v1/partners/{provider}/eta", tags=["파트너"])
    async def partner_eta(request: Request, provider: str = Path(pattern=r"^[a-z0-9_-]{2,20}$"),
                          x_signature: str | None = Header(default=None)):
        """내비 앱이 길안내 중 ETA를 직접 보내는 경로 (파트너 계약 후). 본문 HMAC-SHA256 서명을 검증한다."""
        if not settings.partner_secret:
            raise HTTPException(503, "파트너 웹훅이 설정되지 않았습니다 (PARTNER_WEBHOOK_SECRET).")
        raw = await request.body()
        expected = hmac.new(settings.partner_secret.encode(), raw, hashlib.sha256).hexdigest()
        if not x_signature or not hmac.compare_digest(x_signature, expected):
            raise HTTPException(401, "서명이 올바르지 않습니다.")
        try:
            body = PartnerEtaIn.model_validate_json(raw)
        except ValidationError as e:
            raise HTTPException(422, e.errors(include_url=False)) from None
        rt, sess = get_session(body.session_token)
        if not sess.consent:
            raise HTTPException(403, "방문객 동의가 없는 세션입니다.")
        now = rt.now()
        route = {"provider": provider, "traffic": True, "remaining_distance_m": body.remaining_distance_m, "computed_at": iso(now)}
        rt.update_eta(sess, aware(body.eta), 180.0, f"partner:{provider}", now, route=route)
        return {"ok": True, "eta": iso(sess.eta)}

    return app


app = create_app()
