교체/추가할 전체 파일

GitHub 저장소 루트에 적용:
1. index.html                전체 교체
2. activity-comparison.js    새 파일 또는 전체 교체
3. activity-comparison.css   새 파일 또는 전체 교체
4. service-worker.js         전체 교체

Google Apps Script 편집기에 적용:
5. google-apps-script.gs     기존 코드 전체 교체 후 새 버전으로 재배포

주의:
- app.js, styles.css는 기존 파일을 그대로 둡니다.
- index.html에서 activity-comparison.css는 styles.css 다음에 로드됩니다.
- activity-comparison.js는 app.js 다음에 로드됩니다.
- 이전 분석 통계가 없는 최초 분석에서는 증감 표시가 나타나지 않습니다.
- Apps Script는 저장 후 반드시 배포 관리에서 새 버전으로 재배포해야 합니다.
