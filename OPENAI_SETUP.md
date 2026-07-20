# OpenAI AI 분석 기능 설정

1. OpenAI Platform에서 API 키를 생성하고 API 결제를 설정합니다.
2. Google Apps Script 편집기에서 기존 코드를 `google-apps-script.gs` 내용으로 전체 교체합니다.
3. Apps Script 왼쪽 `프로젝트 설정` → `스크립트 속성`에 추가합니다.
   - `OPENAI_API_KEY` = 발급한 API 키
   - `OPENAI_MODEL` = `gpt-5-mini` (선택, 미입력 시 이 값 사용)
4. `배포` → `배포 관리` → 기존 웹 앱의 연필 아이콘 → `새 버전` → 배포합니다.
5. GitHub 저장소에는 이 폴더의 PWA 파일을 업로드합니다.
6. 앱의 `AI 분석 실행` 버튼을 누르면 추가 요청 창이 열립니다.

분석 결과는 근력운동 루트 폴더 아래에 다음처럼 저장됩니다.

```
Analysis/
  YYYY-MM/
    analysis-YYYY-MM-DD_HHmmss.json
```

주의: API 키를 `app.js`나 GitHub에 넣지 마십시오. 반드시 Apps Script의 스크립트 속성에만 저장하십시오.
