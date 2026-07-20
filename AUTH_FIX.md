# OpenAI 외부 요청 권한 승인

1. Apps Script 프로젝트 설정에서 `appsscript.json 매니페스트 파일 표시`를 켭니다.
2. 이 폴더의 `appsscript.json` 내용을 Apps Script의 동일 파일에 붙여넣습니다.
3. `google-apps-script.gs` 코드를 교체합니다.
4. 편집기 함수 목록에서 `authorizeOpenAIConnection`을 선택해 한 번 실행합니다.
5. Google 권한 승인 화면에서 허용합니다.
6. 배포 관리에서 웹 앱을 새 버전으로 재배포합니다.
