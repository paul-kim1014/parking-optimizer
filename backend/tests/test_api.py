"""HTTP API: 방문객 흐름, 시설 인증, 이벤트 검증, 파트너 웹훅."""
import hashlib
import hmac
import json
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.main import create_app
from conftest import FAC_KEY, make_settings

PANGYO = {"lat": 37.3947, "lng": 127.1112}


def new_session(client, clock, token="RES-1", minutes=50):
    appt = (clock() + timedelta(minutes=minutes)).isoformat()
    r = client.post("/v1/facilities/hangyeol/reservations", headers=FAC_KEY,
                    json={"reservations": [{"token": token, "appointment_at": appt, "zone_id": "CARD"}]})
    assert r.status_code == 200
    r = client.post("/v1/sessions", json={"reservation_token": token})
    assert r.status_code == 201
    return r.json()["session_token"]


def test_visitor_flow_end_to_end(client, clock):
    tok = new_session(client, clock)
    assert client.post(f"/v1/sessions/{tok}/eta", json={"origin": PANGYO}).status_code == 403   # 동의 전

    r = client.post(f"/v1/sessions/{tok}/consent", json={"consent": True, "plate": "12가3456"})
    assert r.status_code == 200 and r.json()["plate_tail"] == "3456" and r.json()["status"] == "waiting"

    r = client.post(f"/v1/sessions/{tok}/eta", json={"source": "nav", "origin": PANGYO, "provider": "tmap"})
    body = r.json()
    assert r.status_code == 200 and body["cached"] is False
    assert body["eta_source"] == "model" and "TMAP 키 미설정" in body["route"]["fallback_reason"]
    assert body["route"]["distance_m"] > 15000
    assert "lat" not in json.dumps(body["route"])                    # 위치 좌표는 남기지 않는다
    assert client.post(f"/v1/sessions/{tok}/eta", json={"origin": PANGYO}).json()["cached"] is True

    a = client.get(f"/v1/sessions/{tok}/assignment?preview=true").json()
    assert a["status"] == "preview" and a["slot"]["label"] and len(a["candidates"]) >= 3
    assert a["walk"]["elev"] in ("E1", "E2")                         # 본관 심장내과 → 본관 승강기

    clock.t = datetime.fromisoformat(body["eta"]) - timedelta(minutes=15)
    client.post("/v1/facilities/hangyeol/tick", headers=FAC_KEY)
    a = client.get(f"/v1/sessions/{tok}/assignment").json()
    assert a["status"] == "assigned"
    label, ramp = a["slot"]["label"], a["ramp"]["id"]

    ev = client.post("/v1/facilities/hangyeol/events", headers=FAC_KEY,
                     json={"events": [{"type": "ENTRY", "plate": "12가 3456", "ramp": ramp}]}).json()["results"][0]
    assert ev["guided"] and ev["slot"] == label and ev["display"][0] == "3456 차량"

    client.post("/v1/facilities/hangyeol/events", headers=FAC_KEY, json={"events": [{"type": "SLOT", "slot": label, "status": "OCCUPIED"}]})
    assert client.get(f"/v1/sessions/{tok}").json()["status"] == "parked"
    client.post("/v1/facilities/hangyeol/events", headers=FAC_KEY, json={"events": [{"type": "EXIT", "plate": "12가3456"}]})
    assert client.get(f"/v1/sessions/{tok}").json()["status"] == "exited"

    st = client.get("/v1/facilities/hangyeol/state?slots=true").json()
    assert len(st["slots"]) == 504 and st["counters"]["comply"] == 1


def test_facility_endpoints_require_key(client):
    r = client.post("/v1/facilities/hangyeol/events", json={"events": [{"type": "GATE", "ramp": "W", "wait_sec": 10}]})
    assert r.status_code == 401


def test_event_batch_is_validated_before_applying(client):
    r = client.post("/v1/facilities/hangyeol/events", headers=FAC_KEY, json={"events": [
        {"type": "GATE", "ramp": "W", "wait_sec": 99},
        {"type": "SLOT", "slot": "B9-Z-999", "status": "OCCUPIED"},
    ]})
    assert r.status_code == 422
    assert client.get("/v1/facilities/hangyeol/state").json()["gate_wait_s"][0] == 0


def test_bad_inputs_are_rejected(client, clock):
    assert client.post("/v1/sessions", json={"reservation_token": "NOPE"}).status_code == 404
    tok = new_session(client, clock)
    client.post(f"/v1/sessions/{tok}/consent", json={"consent": True})
    assert client.post(f"/v1/sessions/{tok}/eta", json={"origin": {"lat": 10, "lng": 127}}).status_code == 422
    assert client.post(f"/v1/sessions/{tok}/consent", json={"consent": True, "plate": "<script>"}).status_code == 422
    assert client.post("/v1/facilities/hangyeol/operations", headers=FAC_KEY, json={"type": "SET_HOLD_CAP", "value": 5}).status_code == 422


def test_withdrawing_consent_clears_eta(client, clock):
    tok = new_session(client, clock)
    client.post(f"/v1/sessions/{tok}/consent", json={"consent": True})
    client.post(f"/v1/sessions/{tok}/eta", json={"origin": PANGYO})
    s = client.post(f"/v1/sessions/{tok}/consent", json={"consent": False}).json()
    assert s["eta"] is None and s["route"] is None and s["status"] == "created"


def test_partner_webhook_requires_valid_signature(client, clock):
    tok = new_session(client, clock)
    client.post(f"/v1/sessions/{tok}/consent", json={"consent": True})
    raw = json.dumps({"session_token": tok, "eta": (clock() + timedelta(minutes=12)).isoformat()}).encode()
    hdr = {"Content-Type": "application/json"}
    assert client.post("/v1/partners/tmap/eta", content=raw, headers={**hdr, "X-Signature": "00"}).status_code == 401
    sig = hmac.new(b"partner-secret", raw, hashlib.sha256).hexdigest()
    assert client.post("/v1/partners/tmap/eta", content=raw, headers={**hdr, "X-Signature": sig}).status_code == 200
    assert client.get(f"/v1/sessions/{tok}").json()["eta_source"] == "partner:tmap"


def test_operations_and_forecast(client, clock):
    r = client.post("/v1/facilities/hangyeol/operations", headers=FAC_KEY, json={"type": "OPEN_ZONE", "floor": "B3", "zone": "D"})
    assert r.status_code == 200 and "42면" in r.json()["applied"]
    new_session(client, clock, minutes=40)
    f = client.get("/v1/facilities/hangyeol/forecast?horizon=60").json()
    assert len(f["buckets"]) == 4 and f["buckets"][0]["p90"] >= f["buckets"][0]["p50"]


def test_demo_endpoints_are_hidden_outside_demo(client, clock):
    tok = new_session(client, clock)
    assert client.post(f"/v1/sessions/{tok}/assign-now").status_code == 404


def test_demo_server_runs_full_visitor_flow():
    app = create_app(make_settings(demo=True, facility_api_key=""))
    with TestClient(app) as c:
        tok = c.post("/v1/sessions", json={"reservation_token": "DEMO-VISIT"}).json()["session_token"]
        c.post(f"/v1/sessions/{tok}/consent", json={"consent": True, "plate": "3456", "vehicle": {"ev": True, "ev_charge": True}})
        c.post(f"/v1/sessions/{tok}/eta", json={"origin": PANGYO})
        a = c.post(f"/v1/sessions/{tok}/assign-now").json()
        assert a["status"] == "assigned"
        enter = c.post(f"/v1/sessions/{tok}/demo/enter").json()
        assert enter["guided"] and enter["slot"] == a["slot"]["label"]
        park = c.post(f"/v1/sessions/{tok}/demo/park").json()
        assert park["result"] == "complied" and park["status"] == "parked"
