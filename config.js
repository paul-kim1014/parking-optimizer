/* 백엔드 API 연결 설정.
 * 백엔드를 배포한 뒤 api에 주소를 넣으면 방문객 화면이 TMAP 실시간 교통 ETA와 서버 배정을 쓴다.
 * 비워 두면 서버 없이 브라우저 안의 모델로 동작한다(데모 모드).
 * 로컬 테스트는 주소 뒤에 ?api=http://127.0.0.1:8000 을 붙이면 된다. ?api=off 로 해제. */
window.PARKAHEAD_CONFIG = {
  api: '',
  allowedApiOrigins: [],
};
