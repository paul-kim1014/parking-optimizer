"""데모 드라이버가 하루 수요를 재생했을 때 상태가 현실적인 범위에 드는지."""
from datetime import datetime

from app.config import KST
from app.demo import DemoDriver
from app.runtime import Runtime
from conftest import Clock


def test_demo_day_replay(fac, settings):
    clock = Clock(datetime(2026, 9, 14, 10, 0, tzinfo=KST))
    rt = Runtime(fac, settings, clock=clock)
    drv = DemoDriver(rt, clock().date(), seed=7)
    drv.seed()
    drv.fast_forward(clock())
    st = rt.state_view(clock())
    used = sum(f["occupied"] + f["held"] for f in st["floors"])
    open_ = sum(f["open"] for f in st["floors"])
    c = st["counters"]
    assert 0.6 < used / open_ <= 1.0
    assert c["entry"] > 300 and c["assign"] > 100
    assert c.get("comply", 0) > c.get("ignore", 0) > 0
    assert rt.forecast_view(clock(), 60)["buckets"][0]["p50"] > 5
