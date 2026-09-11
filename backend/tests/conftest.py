import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import KST, Settings  # noqa: E402
from app.facility import Facility  # noqa: E402
from app.main import create_app  # noqa: E402
from app.runtime import Runtime  # noqa: E402

FAC_KEY = {"X-Api-Key": "fac-key"}


class Clock:
    def __init__(self, t: datetime):
        self.t = t

    def __call__(self) -> datetime:
        return self.t

    def advance(self, **kw) -> None:
        self.t += timedelta(**kw)


def make_settings(**over) -> Settings:
    base = dict(tmap_app_key="", kakao_rest_key="", facility_api_key="fac-key", facility_salt="test-salt",
                partner_secret="partner-secret", cors_origins=["http://localhost:8765"], demo=False, tick_loop=False,
                tick_seconds=60, nav_min_interval=30, nav_timeout=2)
    base.update(over)
    return Settings(**base)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture(scope="session")
def fac() -> Facility:
    return Facility()


@pytest.fixture
def clock() -> Clock:
    return Clock(datetime(2026, 9, 14, 9, 30, tzinfo=KST))


@pytest.fixture
def rt(fac, settings, clock) -> Runtime:
    return Runtime(fac, settings, clock=clock)


@pytest.fixture
def client(settings, clock):
    app = create_app(settings)
    with TestClient(app) as c:
        for r in app.state.runtimes.values():
            r.clock = clock
        yield c
