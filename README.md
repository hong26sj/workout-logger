# Workout Logger

Apple Watch / Apple Health 데이터와 수동 근력운동 기록, 식단 기록을 Google Drive에 모아, 사용자가 요청할 때만 AI 통합 분석을 실행하는 개인용 PWA입니다.

## 보안 원칙

이 저장소에는 다음 값을 절대로 기록하지 않습니다.

- Google Drive 폴더 ID
- OpenAI API Key
- 앱 숫자 비밀번호
- 인증 토큰

Google Drive 폴더 ID는 비밀번호 자체는 아니지만, 개인 데이터 저장 위치를 식별하는 값이므로 공개 GitHub 저장소에는 두지 않습니다. 실제 값은 **Google Apps Script의 스크립트 속성**에만 저장합니다.

## Google Drive 폴더 ID 찾는 방법

Google Drive에서 사용할 폴더를 브라우저로 엽니다. 주소창은 일반적으로 다음 형태입니다.

```text
https://drive.google.com/drive/folders/여기가_폴더_ID
```

`/folders/` 뒤의 문자열이 폴더 ID입니다. Health, Fitness, Strength, Nutrition 폴더 각각에서 ID를 확인합니다.

확인한 값은 GitHub 코드에 넣지 말고 Google Apps Script에서 다음과 같이 등록합니다.

1. Apps Script 프로젝트를 엽니다.
2. 왼쪽 `프로젝트 설정`을 엽니다.
3. `스크립트 속성`에서 `스크립트 속성 추가`를 선택합니다.
4. 아래 속성을 등록합니다.

```text
HEALTH_FOLDER_ID      = Health 폴더 ID
FITNESS_FOLDER_ID     = Fitness 폴더 ID
STRENGTH_FOLDER_ID    = Strength 폴더 ID
NUTRITION_FOLDER_ID   = Nutrition 폴더 ID
OPENAI_API_KEY        = OpenAI API Key
OPENAI_MODEL          = gpt-5-mini
APP_PASSWORD          = 앱에서 사용할 숫자 6~12자리 비밀번호
```

`APP_PASSWORD`도 GitHub 코드에 직접 적지 않습니다.

## 데이터 구조

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
회복/영양/운동/체중감량 통계 생성
        ↓
OpenAI API
        ↓
Analysis JSON 저장
```

Strength 폴더 아래에는 다음 구조가 사용됩니다.

```text
Strength/
  YYYY-MM/
  Analysis/
  Baseline/
```

## 적용된 접근 보안

PWA와 Apps Script 사이에는 다음 정책을 사용합니다.

- 숫자 비밀번호: 6~12자리
- 비밀번호는 Apps Script 스크립트 속성에만 저장
- 로그인 성공 시 무작위 인증 토큰 발급
- 토큰 유효기간: 최대 180일
- 토큰은 브라우저의 localStorage에 저장
- 비밀번호 5회 연속 실패 시 10분 동안 로그인 잠금
- Drive 기록 조회/저장/삭제 및 AI 분석은 모두 유효한 토큰 필요
- 기존 GET 방식의 기록 조회도 클라이언트에서 인증 POST 방식으로 변환
- AI 분석은 최소 60초 간격
- AI 분석은 하루 최대 10회
- 설정 화면에서 현재 기기의 인증 토큰을 삭제할 수 있음

이 보안은 공개 GitHub Pages의 HTML/JavaScript를 숨기는 방식이 아닙니다. **실제 보호 지점은 Apps Script 서버**이며, 인증되지 않은 요청이 Drive 데이터에 접근하거나 OpenAI API 비용을 발생시키지 못하도록 막습니다.

## Apps Script 적용 절차

저장소의 `google-apps-script.gs`는 참고/백업용입니다. 실제 적용은 Apps Script 편집기의 `Code.gs`에 현재 통합 분석 적용본을 넣고 새 버전으로 배포해야 완료됩니다.

1. Google Apps Script 편집기를 엽니다.
2. 기존 `Code.gs`를 백업합니다.
3. 통합 분석 적용 Apps Script 전체 코드를 `Code.gs`에 붙여넣습니다.
4. 위의 스크립트 속성을 모두 등록합니다.
5. 저장합니다.
6. `배포` → `배포 관리`로 이동합니다.
7. 기존 웹 앱 배포를 편집합니다.
8. 새 버전을 선택하여 배포합니다.
9. 기존 `/exec` 웹 앱 URL을 그대로 사용합니다.

웹 앱 실행 사용자는 **본인**으로 두고, 접근 권한은 기존 PWA에서 호출 가능한 설정을 유지합니다. 공개 호출이 가능하더라도 Apps Script 내부의 앱 인증이 실제 데이터 접근을 차단합니다.

## Health Auto Export 권장 설정

- Health 데이터: JSON
- Fitness/Workout 데이터: JSON
- Workout Metrics 포함
- Heart Rate 포함
- HRV 포함
- Sleep Analysis 포함
- Respiratory Rate 포함
- Blood Oxygen Saturation 포함
- Distance 포함
- Step Cadence 포함
- Active Energy 포함
- Heart Rate Recovery 포함 가능하면 포함
- Physical Effort 포함
- Time Grouping: Minutes

분 단위 내보내기는 Apple Fitness 앱의 초 단위 계산과 약간 다를 수 있으므로 AI 분석에서는 분 단위 추정값으로 취급합니다.

## 근력운동 기록

PWA에서 운동일자, 운동명, 기록 유형, 무게, 횟수, 세트, 시간, RPE, 통증 정도/부위, 메모를 기록합니다. 최근 기록은 Google Drive를 단일 원본으로 사용합니다.

운동명 입력은 iOS Safari의 기본 `datalist`를 사용하며, 정확한 운동명을 선택하면 최근 기록 카드가 표시됩니다.

## AI 통합 분석

AI 분석은 자동 실행되지 않고 사용자가 버튼을 누른 경우에만 실행됩니다. Health/Fitness/Strength/Nutrition JSON을 집계하고 OpenAI API를 호출한 뒤 결과를 Analysis 폴더에 JSON으로 저장합니다.

PWA 분석 결과는 다음 순서로 표시합니다.

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

회복 분석은 HRV, 안정시 심박, 수면, 수면 중 심박, SpO₂, 호흡수 등을 사용합니다. 영양 분석에서 불완전 기록일의 `recorded_total`은 실제 하루 총섭취량으로 간주하지 않고 최소 기록 섭취량으로만 취급합니다. 완전 기록일 평균을 우선하고, 누락 끼니 보정치는 원본과 분리된 추정값으로만 사용합니다.

## PWA 업데이트

서비스워커 캐시를 사용하므로 GitHub Pages 변경 후 아이폰 홈 화면 앱에 이전 버전이 남을 수 있습니다. 현재 캐시 버전은 `workout-logger-ai-v23`입니다.

앱은 실행 시 서비스워커 업데이트를 확인하고 새 버전이 활성화되면 자동으로 새로고침합니다. 반영이 이상하면 홈 화면 PWA를 완전히 종료한 뒤 다시 실행하거나 Safari에서 페이지를 다시 열어 확인합니다.

Apps Script만 수정한 경우에는 PWA 캐시와 무관하며 Apps Script를 새 버전으로 재배포하면 됩니다.

## 주의사항

- `OPENAI_API_KEY`, `APP_PASSWORD`, Drive 폴더 ID를 GitHub Issue, README, 소스코드에 커밋하지 않습니다.
- Apps Script 웹 앱 URL은 API Key와 같은 비밀키는 아니지만 불필요하게 외부에 공유하지 않는 것이 좋습니다.
- 휴대전화를 분실했거나 인증 토큰 유출이 의심되면 Apps Script에서 발급된 인증 토큰을 전부 무효화한 뒤 다시 로그인하도록 합니다.
