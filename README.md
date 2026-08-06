# Workout Logger README

이 문서는 Workout Logger 프로젝트의 현재 운영 기준을 정리한 문서입니다.

## 목적

Workout Logger는 Apple Watch와 Apple Health 데이터를 바탕으로 운동 기록, 건강 데이터, 수동 근력운동 기록을 모아 체중감량과 근력 유지를 위한 AI 분석을 수행하는 개인용 PWA입니다.

핵심 목표는 다음과 같습니다.

- 근력운동을 직접 기록한다.
- Health Auto Export가 Google Drive에 건강/운동 데이터를 자동 저장한다.
- 사용자가 원할 때만 AI 분석을 실행한다.
- OpenAI API 비용이 자동으로 계속 발생하지 않도록 한다.
- AI 분석 결과를 Google Drive에 JSON으로 저장한다.

## 구성 요소

- PWA: GitHub Pages에서 실행되는 운동 기록 앱
- GitHub 저장소: `hong26sj/workout-logger`
- Google Apps Script: PWA와 Google Drive 사이의 API
- Google Drive: Health, Fitness, Strength, Analysis, Baseline 데이터 저장
- Health Auto Export: Apple Health/Fitness 데이터를 Google Drive로 자동 내보내는 앱
- OpenAI API: 사용자가 AI 분석 버튼을 누를 때만 호출

## 데이터 흐름

```text
Apple Watch / Apple Health
        ↓
Health Auto Export
        ↓
Google Drive Health / Fitness JSON

PWA 근력운동 입력
        ↓
Google Apps Script
        ↓
Google Drive Strength JSON

PWA AI 분석 실행
        ↓
Google Apps Script
        ↓
Health + Fitness + Strength 집계
        ↓
OpenAI API
        ↓
Analysis JSON 저장
        ↓
PWA에 마지막 분석 표시
```

## Google Drive 폴더

현재 Apps Script 코드에는 다음 폴더 ID가 설정되어 있습니다.

```javascript
const HEALTH_FOLDER_ID = '1kIMgXnimiRiVTqPmuP6hQ2KQq64zlsYy';
const FITNESS_FOLDER_ID = '1tuxq3zOz9pBQDk9b5H-N78LUWkUQ6w0l';
const STRENGTH_FOLDER_ID = '1-Qfa2hYLBCiq6TW2IemLQ31AtUpFdWAR';
```

근력운동 루트 폴더 아래에는 다음 하위 폴더가 사용됩니다.

```text
Strength root/
  YYYY-MM/
  Analysis/
  Baseline/
```

## Health Auto Export 설정 기준

권장 설정은 다음과 같습니다.

- Health 데이터: JSON
- Fitness/Workout 데이터: JSON
- Workout Metrics 포함
- Heart Rate 포함
- Distance 포함
- Step Cadence 포함
- Active Energy 포함
- Heart Rate Recovery 포함 가능하면 포함
- Time Grouping: 현재는 Minutes 기준

분 단위 내보내기를 사용하면 Apple Fitness 앱의 초 단위 계산과 약간 차이가 날 수 있습니다. 현재 AI 분석에서는 이 값을 정확한 원본값이 아니라 분단위 추정값으로 취급합니다.

## 근력운동 기록 기준

근력운동은 PWA에서 직접 입력합니다.

기록 가능한 주요 항목은 다음과 같습니다.

- 운동일자
- 운동명
- 기록 유형
- 무게
- 횟수
- 세트
- 시간 운동
- RPE
- 통증 부위
- 통증 정도
- 메모

운동일자는 오늘이 아니어도 선택할 수 있습니다. 어제 운동을 기록하지 못한 경우에도 실제 운동한 날짜로 입력합니다.

## AI 분석 실행 방식

AI 분석은 자동 실행되지 않습니다. 사용자가 PWA에서 `AI 분석 실행` 버튼을 눌렀을 때만 다음 순서로 실행됩니다.

```text
AI 분석 실행
→ 분석 시작일 확인
→ Health/Fitness/Strength JSON 수집
→ Apps Script에서 수치 통계 계산
→ OpenAI API 호출
→ Analysis JSON 저장
→ PWA에 결과 표시
```

분석 시작일은 PWA에서 선택할 수 있습니다. 기본값은 마지막 분석일 기준으로 이어서 분석할 수 있도록 설정합니다.

## 현재 AI 분석에 포함되는 항목

### 체중감량 관련

- 체중
- 체지방률
- BMI
- 허리둘레가 있을 경우 복부지방 참고 지표
- 활동 에너지
- 운동시간
- 걷기/달리기 거리

식사 데이터가 없으면 AI는 칼로리 적자를 임의로 계산하지 않습니다.

### 유산소 관련

- 유산소 세션 수
- 총 유산소 시간
- 거리
- 평균 페이스
- 평균 심박수
- 최대 심박수
- 평균 케이던스
- 활동 칼로리
- GPS 반복 경로 여부
- 느린 야외 걷기 제외 여부

추가로 Apps Script는 Health Auto Export가 제공하는 분단위 운동 지표를 이용해 다음 세부값을 AI 입력에 포함합니다.

- 1km 단위 추정 스플릿
- km별 평균 심박수
- km별 평균 케이던스
- 심박수 영역별 체류 시간
- 운동 후 심박수 회복

이 값은 `minute_level_estimate`로 표시되며, Apple Fitness의 초단위 원본값처럼 과도하게 단정하지 않도록 OpenAI 지침에 포함되어 있습니다.

### 근력운동 관련

- 근력운동 세션 수
- 운동별 세트 수
- 반복 수
- 총 볼륨
- 최근 중량
- 평균 RPE
- 통증 기록

근력운동 수동 기록은 2026-07-20부터 시작된 것으로 간주합니다. 그 이전 근력운동 공백은 실제 운동 부재가 아니라 기록 누락 가능성으로 봅니다.

## 고정 AI 규칙

현재 Apps Script에는 다음 고정 규칙이 포함되어 있습니다.

- 목표는 체중감량과 근력 유지 또는 향상이다.
- 제공된 측정값만 근거로 사용한다.
- 식사 데이터가 없으면 칼로리 적자를 추정하지 않는다.
- 통증 기록을 최우선으로 반영한다.
- 허리 통증 또는 악화 신호가 있으면 허리에 부담되는 동작을 제외한다.
- 의료 진단을 하지 않는다.
- 7월 초 실내 걷기와 최근 실내 달리기/실내 운동은 Apple Watch 운동명 선택 차이일 수 있으므로, 운동명 변화 자체를 운동 방식 전환으로 해석하지 않는다.
- 같은 실내 유산소 흐름은 거리, 시간, 페이스, 심박수, 케이던스, 활동칼로리 기준으로 비교한다.
- 유산소 세부 지표는 분단위 추정값으로만 사용한다.

## PWA 업데이트 주의사항

PWA는 서비스워커 캐시를 사용합니다.

GitHub Pages에 파일을 수정해도 아이폰 홈 화면 앱에 이전 캐시가 남을 수 있습니다. 화면 파일을 수정한 뒤 반영이 이상하면 다음 순서를 사용합니다.

1. 아이폰 홈 화면의 기존 PWA 삭제
2. Safari에서 GitHub Pages 주소 접속
3. 필요하면 Safari 웹사이트 데이터에서 `hong26sj.github.io` 삭제
4. 다시 홈 화면에 추가

Apps Script만 수정하는 경우에는 GitHub Pages/PWA 캐시와 무관합니다. Apps Script 코드를 교체하고 새 버전으로 배포하면 됩니다.

## Apps Script 배포 절차

Apps Script 코드를 수정한 경우:

1. Google Apps Script 편집기 열기
2. `Code.gs` 내용을 저장소의 `google-apps-script.gs` 내용으로 교체
3. 필요한 경우 `appsscript.json` 확인
4. 저장
5. 배포
6. 배포 관리
7. 기존 웹 앱 선택
8. 새 버전으로 배포

웹 앱 URL은 기존 `/exec` URL을 유지합니다.

## OpenAI 설정

Apps Script의 스크립트 속성에 다음 값이 필요합니다.

```text
OPENAI_API_KEY
OPENAI_MODEL
```

현재 기본 모델은 코드상 `gpt-5-mini`입니다.

API 키는 절대로 GitHub, PWA 코드, `app.js`, `index.html`에 넣지 않습니다.

## 운영 체크리스트

AI 분석 전 확인:

- Health Auto Export가 최신 Health JSON을 Drive에 저장했는가
- Fitness JSON이 최신 운동 기록을 포함하는가
- 근력운동 기록을 PWA에 입력했는가
- 분석 시작일이 원하는 기간으로 설정되어 있는가
- 추가 요청사항이 필요한 경우 입력했는가

문제가 있을 때 확인:

- Drive의 Health/Fitness 파일 날짜
- Analysis 폴더의 최신 분석 JSON
- Apps Script 실행 로그
- OpenAI API 키와 결제 상태
- PWA 캐시 여부

## 향후 추가 후보

아직 반영하지 않은 후보 기능입니다.

- 데이터 진단 리포트
- source 우선순위와 중복 측정 정리 강화
- 수면/HRV 기반 회복 분석
- 로컬 또는 저비용 모델 선택 옵션
- 분석 결과의 원인 추적용 summary JSON 별도 저장

