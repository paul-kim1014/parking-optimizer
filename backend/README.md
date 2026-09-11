# 자리먼저 ParkAhead API

기획서 v0.1 부록 B의 핵심 API를 FastAPI로 구현한 백엔드입니다. 병원 주차장의 도착을 예측하고, 방문객 차량마다 슬롯을 미리 배정하고, 관제 이벤트로 배정을 확정하거나 다시 배정합니다.

- 배정 엔진: 브라우저 프로토타입(`../engine.js`)과 같은 비용 함수. 롤링 호라이즌 일괄 배정은 SciPy `linear_sum_assignment`로 풉니다.
- 도착 예정 시각(ETA): 방문객 현재 위치 → **TMAP 자동차 경로안내 API**(실시간 교통) → 실패 시 **카카오모빌리티 길찾기** → 둘 다 없으면 교통 패턴 모델.
- 교차 검증: `tests/test_facility.py`가 JS 엔진과 Python 엔진의 비용 표 · 슬롯 순위 · 교통 모델 값이 같은지 확인합니다.

## 로컬 실행

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
.venv/bin/uvicorn app.main:app --reload --port 8000
```

- API 문서: http://127.0.0.1:8000/docs
- 프론트엔드를 이 서버에 연결: `http://127.0.0.1:8765/?api=http://127.0.0.1:8000` (레포 루트에서 `python3 -m http.server 8765`)
- 테스트: `.venv/bin/python -m pytest -q`

`DEMO=1`(기본값)이면 서버가 시작할 때 오늘 07:00부터 지금까지의 합성 수요(예약 980 · 비예약 420대)를 5분 단위로 재생해 가상 시설 상태를 채우고, 이후 1분마다 계속 진행합니다. 방문객 데모용 예약 토큰은 `DEMO-VISIT`입니다(세션을 만들 때마다 45분 뒤 심장내과 예약이 새로 생깁니다).

## 환경변수

| 이름 | 설명 |
|---|---|
| `TMAP_APP_KEY` | SK open API(openapi.sk.com) 콘솔에서 발급한 TMAP appKey |
| `KAKAO_REST_KEY` | Kakao Developers REST API 키 (카카오모빌리티 길찾기 사용 권한 필요) |
| `FACILITY_API_KEY` | 시설 어댑터용 `X-Api-Key`. 비어 있으면 인증 없이 열림(로컬 전용) |
| `FACILITY_SALT` | 번호판 HMAC 솔트. 시설 LPR과 같은 값을 써야 매칭됨 |
| `PARTNER_WEBHOOK_SECRET` | Phase 2 내비 파트너 웹훅 서명 비밀값 |
| `CORS_ORIGINS` | 프론트엔드 출처(쉼표 구분) |
| `DEMO` | `1`이면 합성 수요 · 데모 엔드포인트 사용 |

키가 없어도 서버는 동작합니다. 이 경우 ETA는 교통 패턴 모델로 계산되고 응답의 `route.fallback_reason`에 이유가 담깁니다.

## 배포 (Render 예시)

레포 루트의 `render.yaml`이 Docker 기반 웹 서비스 하나를 정의합니다. Render 대시보드에서 New → Blueprint로 이 레포를 연결하고, 배포 후 `TMAP_APP_KEY`를 입력하면 됩니다. 배포 주소를 프론트엔드 `config.js`의 `api`에 넣으면 공개 링크의 방문객 화면이 서버 모드로 바뀝니다.

## 방문객 흐름

```
POST /v1/sessions {reservation_token}                 → session_token
POST /v1/sessions/{t}/consent {consent, plate, vehicle}
POST /v1/sessions/{t}/eta {source:"nav", origin:{lat,lng}, provider:"tmap"}   (이동 중 1분마다)
GET  /v1/sessions/{t}/assignment?preview=true         → 도착 15분 전 확정, 그 전에는 미리보기
관제: POST /v1/facilities/{id}/events  ENTRY(LPR) → 전광판 문구 · SLOT(면 센서) → 준수 기록 · EXIT
```

## 알려진 한계

- 상태는 서버 메모리에 있습니다. 재시작하면 초기화됩니다(기획서 9장의 PostgreSQL · Redis로 옮길 부분).
- 웹 화면은 TMAP 앱 안의 ETA를 읽을 수 없습니다. 같은 경로 엔진을 API로 부르는 방식이고, 방문객이 내비 앱으로 넘어가면 브라우저 갱신이 멈춥니다. 길안내 중 연속 ETA는 파트너 웹훅(`/v1/partners/{provider}/eta`)으로 받습니다.
- TMAP · 카카오 응답 파싱은 공개 문서 기준 필드(`features[].properties.totalTime/totalDistance`, `routes[0].summary.duration/distance`)를 씁니다. 실제 키로 첫 호출 때 응답을 한 번 확인하세요.
