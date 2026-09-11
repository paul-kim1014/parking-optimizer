"""요청 스키마. 입력 범위를 좁게 잡아 잘못된 데이터가 상태를 오염시키지 않게 한다."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class LatLng(BaseModel):
    lat: float = Field(ge=33.0, le=39.0, description="위도 (대한민국 범위)")
    lng: float = Field(ge=124.0, le=132.0, description="경도 (대한민국 범위)")


class VehicleIn(BaseModel):
    disabled: bool = False
    ev: bool = False
    ev_charge: bool = False
    large: bool = False


class SessionCreate(BaseModel):
    facility_id: str = "hangyeol"
    reservation_token: str = Field(min_length=3, max_length=64, description="알림톡 링크에 담긴 예약 토큰")


class ConsentIn(BaseModel):
    consent: bool
    plate: str | None = Field(default=None, pattern=r"^[0-9가-힣A-Za-z ]{2,16}$", description="차량 번호 — 즉시 해시되고 원문은 저장하지 않음")
    vehicle: VehicleIn = VehicleIn()


class EtaIn(BaseModel):
    source: Literal["nav", "manual"] = "nav"
    origin: LatLng | None = Field(default=None, description="현재 위치 — 경로 계산에만 쓰고 저장하지 않음")
    provider: Literal["auto", "tmap", "kakao", "model"] = "auto"
    eta: datetime | None = None


class ReservationIn(BaseModel):
    token: str = Field(min_length=3, max_length=64)
    appointment_at: datetime
    zone_id: str


class ReservationsIn(BaseModel):
    reservations: list[ReservationIn] = Field(min_length=1, max_length=5000)


class EventIn(BaseModel):
    type: Literal["ENTRY", "SLOT", "EXIT", "GATE"]
    ts: datetime | None = None
    plate_hash: str | None = Field(default=None, max_length=64)
    plate: str | None = Field(default=None, max_length=16, description="개발용 — 운영에서는 시설 측에서 해시한 plate_hash를 보낸다")
    ramp: Literal["W", "E"] | None = None
    slot: str | None = Field(default=None, max_length=16)
    status: Literal["FREE", "OCCUPIED", "BLOCKED"] | None = None
    wait_sec: float | None = Field(default=None, ge=0, le=3600)
    searching: int | None = Field(default=None, ge=0, le=500)


class EventsIn(BaseModel):
    events: list[EventIn] = Field(min_length=1, max_length=1000)


class OperationIn(BaseModel):
    type: Literal["OPEN_ZONE", "CLOSE_ZONE", "ENGINE_OFF", "ENGINE_ON", "SET_WEIGHTS", "SET_HOLD_CAP", "STAFF"]
    floor: Literal["B1", "B2", "B3"] | None = None
    zone: Literal["A", "B", "C", "D"] | None = None
    weights: dict[str, float] | None = None
    value: float | None = None
    ramp: Literal["W", "E"] | None = None


class PartnerEtaIn(BaseModel):
    session_token: str = Field(min_length=8, max_length=64)
    eta: datetime
    remaining_distance_m: float | None = Field(default=None, ge=0)
