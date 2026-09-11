#!/bin/sh
# page.html(아티팩트 원본, 본문만) → index.html(GitHub Pages용 완전한 문서)
cd "$(dirname "$0")"
{
  printf '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="description" content="도착하기 전에 자리를 정해주는 주차장 — 병원 주차 예측·배정 MVP 프로토타입">\n<meta name="theme-color" content="#16202A">\n'
  sed -n '1,/styles.css/p' page.html
  printf '</head>\n<body>\n'
  sed '1,/styles.css/d' page.html
  printf '</body>\n</html>\n'
} > index.html
