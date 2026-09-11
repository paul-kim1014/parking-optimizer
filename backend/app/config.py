"""환경변수 기반 설정. 비밀값(API 키 · 솔트)은 코드에 두지 않고 배포 환경에서 주입한다."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import timedelta, timezone

KST = timezone(timedelta(hours=9), "KST")

DEFAULT_CORS = "https://paul-kim1014.github.io,http://localhost:8765,http://127.0.0.1:8765"


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    # 내비게이션 경로 API 키 — 없으면 교통 패턴 모델로 대체
    tmap_app_key: str = field(default_factory=lambda: _env("TMAP_APP_KEY"))
    kakao_rest_key: str = field(default_factory=lambda: _env("KAKAO_REST_KEY"))
    # 시설(관제 · 예약 어댑터)용 API 키. 비어 있으면 인증 없이 열린다(로컬 개발 전용)
    facility_api_key: str = field(default_factory=lambda: _env("FACILITY_API_KEY"))
    # 번호판 해시 솔트 — 시설 LPR과 같은 값을 써야 매칭된다 (7.4)
    facility_salt: str = field(default_factory=lambda: _env("FACILITY_SALT", "dev-only-salt-change-me"))
    # Phase 2 내비 파트너 웹훅 서명 비밀값
    partner_secret: str = field(default_factory=lambda: _env("PARTNER_WEBHOOK_SECRET"))
    cors_origins: list[str] = field(default_factory=lambda: [o for o in _env("CORS_ORIGINS", DEFAULT_CORS).split(",") if o])
    # 데모: 합성 수요로 가상 시설을 채우고 방문객 데모 엔드포인트를 연다
    demo: bool = field(default_factory=lambda: _env_bool("DEMO", True))
    tick_loop: bool = field(default_factory=lambda: _env_bool("TICK_LOOP", True))
    tick_seconds: float = field(default_factory=lambda: float(_env("TICK_SECONDS", "60")))
    nav_min_interval: float = field(default_factory=lambda: float(_env("NAV_MIN_INTERVAL", "30")))
    nav_timeout: float = field(default_factory=lambda: float(_env("NAV_TIMEOUT", "5")))
