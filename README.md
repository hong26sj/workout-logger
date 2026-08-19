# Workout Logger

Apple Watch / Apple Health 데이터와 수동 근력운동 기록, 식단 기록을 Google Drive에 모아, 사용자가 요청할 때만 AI 통합 분석을 실행하는 개인용 PWA입니다.

## 현재 구조

```text
Apple Watch / Apple Health
        ↓
Health Auto Export
        ↓
Google Drive Health / Fitness JSON

PWA 근력운동 입력
        ↓
Google Apps Script (토큰 인증)
        ↓
Google Drive Strength JSON

Nutrition 원본 JSON
        ↓
Google Drive Nutrition

PWA AI 분석 실행
        ↓
Google Apps Script (토큰 인증 + 호출 제한)
        ↓
Health + Fitness + Strength + Nutrition 집계
        ↓
회복 / 영양 / 운동 / 체중감량 통계 생성
        ↓
OpenAI API
        ↓
Analysis JSON 저장
        ↓
PWA 분석 화면 표시
```

Strength 폴더는 다음 구조를 사용합니다.

```text
Strength/
  YYYY-MM/
  Analysis/
  Baseline/
```

개별 `strength-*.json`이 원본이며 `recent-strength-index.json`은 최근 기록 조회를 위한 파생 인덱스입니다. AI 분석은 파생 인덱스가 아니라 개별 Strength 원본 파일을 사용합니다.

## 보안 원칙

이 저장소에는 다음 값을 절대로 기록하지 않습니다.

- Google Drive 폴더 ID
- OpenAI API Key
- 앱 숫자 비밀번호
- 인증 토큰

Google Drive 폴더 ID는 비밀번호 자체는 아니지만 개인 데이터 저장 위치를 식별하는 값이므로 공개 GitHub 저장소에는 두지 않습니다. 실제 값은 **Google Apps Script의 스크립트 속성**에만 저장합니다.

필요한 스크립트 속성은 다음과 같습니다.

```text
HEALTH_FOLDER_ID      = Health 폴더 ID
FITNESS_FOLDER_ID     = Fitness 폴더 ID
STRENGTH_FOLDER_ID    = Strength 폴더 ID
NUTRITION_FOLDER_ID   = Nutrition 폴더 ID
OPENAI_API_KEY        = OpenAI API Key
OPENAI_MODEL          = gpt-5-mini
APP_PASSWORD          = 앱에서 사용할 숫자 6~12자리 비밀번호
```

## Google Drive 폴더 ID 찾는 방법

Google Drive에서 사용할 폴더를 브라우저로 엽니다. 주소창은 일반적으로 다음 형태입니다.

```text
https://drive.google.com/drive/folders/여기가_폴더_ID
```

`/folders/` 뒤의 문자열이 폴더 ID입니다. Health, Fitness, Strength, Nutrition 폴더 각각에서 확인한 뒤 Apps Script의 `프로젝트 설정` → `스크립트 속성`에 등록합니다.

## 접근 보안

PWA와 Apps Script 사이에는 다음 정책을 사용합니다.

- 숫자 비밀번호: 6~12자리
- 비밀번호는 Apps Script 스크립트 속성에만 저장
- 로그인 성공 시 무작위 인증 토큰 발급
- 토큰 유효기간: 최대 180일
- 브라우저 localStorage에는 인증 토큰만 저장
- 서버에는 토큰 원문이 아니라 SHA-256 해시를 저장
- 비밀번호 5회 연속 실패 시 10분 로그인 잠금
- Drive 기록 조회/저장/삭제 및 AI 분석은 모두 유효한 토큰 필요
- 민감한 조회 요청은 인증 POST 방식으로 처리
- AI 분석 최소 호출 간격: 60초
- AI 분석 하루 최대 10회
- 설정 화면에서 현재 기기 인증 해제 가능
- 서버에서 전체 인증 토큰 무효화 가능

실제 보호 지점은 GitHub Pages가 아니라 **Apps Script 서버**입니다. 공개된 HTML/JavaScript를 숨기는 방식이 아니라, 인증되지 않은 요청이 Drive 데이터에 접근하거나 OpenAI API 비용을 발생시키지 못하도록 서버에서 차단합니다.

## Apps Script 5파일 구조

Apps Script 백업 코드는 저장소의 `apps-script/` 폴더에 5개 파일로 분리되어 있습니다.

```text
apps-script/
  Code.gs
  Security.gs
  Data.gs
  Analysis.gs
  AI.gs
```

각 파일 역할은 다음과 같습니다.

- `Code.gs`
  - Script Properties 기반 설정
  - `doGet`, `doPost`
  - 요청 라우팅
  - 공통 진입점
- `Security.gs`
  - 로그인
  - 인증 토큰 발급/검증
  - 로그인 실패 잠금
  - AI 호출 간격/일일 제한
- `Data.gs`
  - Strength 저장/삭제
  - 최근 Strength 인덱스 관리
  - Drive 파일 수집
  - Health/Fitness/Strength/Nutrition 원본 로딩
  - 중복 제거 및 저장 관련 처리
- `Analysis.gs`
  - 체중/체지방/BMI/허리둘레 통계
  - HRV/안정시 심박/수면/SpO₂/호흡수 회복 통계
  - Nutrition 완전/불완전 기록 처리 및 누락 끼니 추정
  - Fitness/Health 기반 유산소·MET 통계
  - 근력운동 통계
  - 활동량 통계와 분석용 파생값 계산
- `AI.gs`
  - 통합 AI 분석 실행
  - OpenAI 요청/응답 처리
  - JSON schema
  - prompt 규칙
  - Analysis JSON 저장

기존 단일 통합 `.gs` 파일은 더 이상 사용하지 않습니다.

## Apps Script 적용 절차

GitHub의 `apps-script/` 파일은 **백업/버전관리용**입니다. 실제 서비스에는 Apps Script 편집기에 같은 5개 파일을 생성해 적용합니다.

1. Google Apps Script 프로젝트를 엽니다.
2. 기존 단일 통합 코드는 제거합니다.
3. 아래 5개 스크립트 파일을 생성합니다.

```text
Code.gs
Security.gs
Data.gs
Analysis.gs
AI.gs
```

4. GitHub `apps-script/`의 각 파일 내용을 동일한 이름의 Apps Script 파일에 붙여넣습니다.
5. 필요한 스크립트 속성이 모두 등록되어 있는지 확인합니다.
6. 저장합니다.
7. `배포` → `배포 관리`로 이동합니다.
8. 기존 웹 앱 배포를 편집합니다.
9. 새 버전을 선택하여 배포합니다.
10. 기존 `/exec` 웹 앱 URL을 그대로 사용합니다.

웹 앱 실행 사용자는 **본인**으로 두고 기존 PWA에서 호출 가능한 접근 설정을 유지합니다.

## Health Auto Export 권장 설정

- Health 데이터: JSON
- Fitness / Workout 데이터: JSON
- Workout Metrics 포함
- Heart Rate 포함
- HRV 포함
- Sleep Analysis 포함
- Respiratory Rate 포함
- Blood Oxygen Saturation 포함
- Distance 포함
- Step Cadence 포함
- Active Energy 포함
- Heart Rate Recovery 가능하면 포함
- Physical Effort 포함
- Time Grouping: Minutes

분 단위 내보내기는 Apple Fitness 앱의 초 단위 계산과 약간 다를 수 있으므로 AI 분석에서는 분 단위 추정값으로 취급합니다.

## 근력운동 기록

PWA에서 다음 항목을 기록합니다.

- 운동일자
- 운동명
- 기록 유형
- 무게
- 횟수
- 세트
- 시간
- RPE
- 통증 정도/부위
- 메모

최근 기록은 Google Drive를 단일 원본으로 사용합니다. 브라우저 로컬 캐시는 최근 기록의 원본으로 사용하지 않습니다.

운동명 입력은 iOS Safari 기본 `datalist`를 사용하며, 정확한 운동명을 선택하면 이전 기록을 확인할 수 있습니다. 이전 기록을 다시 불러올 때 RPE, 통증, 메모는 그대로 복사하지 않습니다.

## Nutrition 기록 원칙

Nutrition JSON은 실제로 기록된 섭취만 저장합니다.

- 하루 1개 JSON
- `breakfast / lunch / dinner`를 주식사 기준으로 사용
- 세 끼 모두 기록되면 complete
- 1~2끼만 기록되면 incomplete
- incomplete의 `recorded_total`은 실제 하루 총섭취량이 아니라 **기록된 최소 섭취량**으로 취급
- 누락 끼니 추정치는 분석 시 메모리에서만 계산
- 추정값을 Nutrition 원본 JSON에 저장하지 않음
- 우선순위: complete 실제값 > 완전 보정 추정값 > incomplete recorded lower bound
- 완전 기록일 평균과 기록 전체 평균을 구분해서 표시

AI 영양 평가는 너무 긴 설명을 피하고 핵심 판단을 짧게 표시합니다. 부족 또는 보완이 필요한 영양 항목이 근거로 확인될 때만 최대 3개까지 추천 식단을 표시하며, 데이터가 없는 미량영양소 결핍을 임의로 추정하지 않습니다.

## AI 통합 분석

AI 분석은 자동 실행되지 않고 사용자가 버튼을 누른 경우에만 실행됩니다. Health/Fitness/Strength/Nutrition JSON을 집계하고 OpenAI API를 호출한 뒤 결과를 Strength의 `Analysis` 폴더에 별도 JSON으로 저장합니다.

현재 분석 결과의 기본 표시 순서는 다음과 같습니다.

```text
종합 평가        기본 펼침
현재 수치        기본 펼침
회복 상태        기본 접힘
영양 상태        기본 접힘
운동 분석        기본 접힘
체중감량 분석    기본 접힘
다음 운동 계획   기본 접힘
주의사항         기본 접힘
```

### 종합 평가

상태값은 다음 4단계 중 하나만 사용합니다.

```text
양호
주의
부족
자료 없음
```

체중감량 / 운동 / 회복 / 영양을 각각 짧은 상태 배지로 표시하고 상세 근거는 별도 설명 영역에 둡니다.

### 회복 상태

회복 상태를 펼치면 최상단에 현재 단계가 표시됩니다. 주요 입력은 다음과 같습니다.

- HRV
- 안정시 심박
- 수면시간과 수면단계
- 수면 중 심박
- SpO₂
- 호흡수
- 장기 참고값: VO₂ max, Walking Heart Rate Average 등

수면 데이터가 충분하지 않은 경우 해당 한계를 명시하고 HRV/RHR 등 더 밀도가 높은 지표를 함께 사용합니다.

### 영양 상태

영양 상태도 동일한 4단계 상태를 사용합니다.

- 완전 기록일 평균을 우선 표시
- 평가문은 모바일에서 읽기 쉬운 짧은 형태로 제한
- 부족/보완 필요 영양소 위주로 추천 음식 표시
- 추천 항목 최대 3개
- 항목별 음식 최대 4개
- 추정과 실제 기록을 명확히 구분

### 운동 분석 시각화

운동 분석에는 텍스트뿐 아니라 다음 시각자료를 표시합니다.

1. **최근 7일 운동 구성**
   - 근력 세션 수
   - 유산소 세션 수
2. **유산소 강도 분포**
   - 저강도
   - 중강도
   - 고강도
3. **최근 7일 운동량 추세 이중축 그래프**
   - 꺾은선: 유산소 운동시간(분)
   - 막대: 근력 총 세트 수
   - 좌측 Y축: 유산소 운동시간
   - 우측 Y축: 근력 총 세트 수

유산소 강도는 Fitness workout의 intensity 값을 우선 사용하고, 없을 때 Health `physical_effort`를 보조값으로 사용합니다. 두 값을 단순 합산하지 않습니다.

근력 그래프에는 `kg × reps × sets` 총중량 대신 **총 세트 수**를 사용합니다. 체중운동과 시간운동도 포함되어 있어 전체 훈련량 비교에 더 일관적이기 때문입니다.

## 활동량 종합

활동량 영역은 다음 데이터를 표시합니다.

- 평균 걸음 수
- 걷기·달리기 거리
- 유산소 운동 횟수 및 시간
- 평균 페이스
- 평균 심박수
- 활동 칼로리

장기간 전체 분석값과 최근 비교값을 혼동하지 않도록 각 수치의 단위를 명확히 표시합니다. 분석 비교는 데이터가 실제로 변화한 구간을 기준으로 해석해야 하며, 같은 날 거의 동일한 기간으로 반복 실행한 분석은 변화량이 0에 가깝게 나올 수 있습니다.

## 유산소 세션 판정

Fitness 세션을 무조건 모두 유산소로 취급하지 않습니다. 걷기/달리기 세션 중 품질 조건을 만족한 세션만 유산소 분석에 포함하며, 느린 일상 걷기나 반복 GPS 경로 등은 제외 사유와 함께 별도 관리할 수 있습니다.

운동 분석 UI는 Apps Script가 계산한 품질 필터링 결과를 우선 사용합니다.

## PWA 파일 구조

주요 클라이언트 파일은 다음과 같습니다.

```text
index.html
styles.css
app.js
auth-client.js
session-delete-fix.js
exercise-picker.js
activity-comparison.js
activity-comparison.css
ai-integrated-ui.js
ai-integrated-ui.css
training-visual-v2.js
service-worker.js
manifest.webmanifest
```

`training-visual-v2.js`는 최근 7일 운동 구성, 유산소 강도 분포, 유산소 시간 + 근력 세트 이중축 그래프를 최종 렌더링합니다.

## PWA 업데이트

서비스워커 캐시를 사용합니다. 현재 캐시 버전은:

```text
workout-logger-ai-v26
```

앱은 실행 시 서비스워커 업데이트를 확인하고 새 버전이 활성화되면 자동으로 새로고침합니다. 반영이 이상하면 홈 화면 PWA를 완전히 종료한 뒤 다시 실행하거나 Safari에서 페이지를 다시 열어 확인합니다.

Apps Script만 수정한 경우에는 PWA 캐시와 무관하며 Apps Script를 새 버전으로 재배포해야 실제 서버에 반영됩니다.

## 현재 최종 상태

2026-08-19 기준 현재 버전을 최종 기준점으로 사용합니다.

- PWA 정상 작동
- Apps Script 5파일 구조 적용
- 기존 단일 Apps Script 통합 파일 제거
- GitHub에는 `apps-script/` 5파일을 백업용으로 유지
- 회복 상태 단계 표시 적용
- 영양 상태 단계 표시 및 평가 축약 적용
- 부족 영양소 중심 추천 식단 적용
- 최근 7일 근력/유산소 구성 시각화 적용
- 유산소 MET 강도 분포 적용
- 유산소 운동시간 + 근력 총 세트 이중축 그래프 적용
- 최근 유산소 세션 참조 문제 수정
- 서비스워커 캐시 v26 적용

이후 변경은 이 상태를 기준으로 증분 수정합니다.

## 주의사항

- `OPENAI_API_KEY`, `APP_PASSWORD`, Drive 폴더 ID를 GitHub Issue, README, 소스코드에 커밋하지 않습니다.
- Apps Script 웹 앱 URL은 API Key와 같은 비밀키는 아니지만 불필요하게 외부에 공유하지 않는 것이 좋습니다.
- 휴대전화를 분실했거나 인증 토큰 유출이 의심되면 Apps Script에서 발급된 인증 토큰을 모두 무효화한 뒤 다시 로그인합니다.
- GitHub의 `apps-script/` 코드는 백업/버전관리용이며 실제 서버 반영은 Apps Script 편집기 적용 및 새 버전 배포가 필요합니다.
