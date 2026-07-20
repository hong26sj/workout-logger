# 근력 운동 기록 PWA v4

## 내장된 Apps Script URL

https://script.google.com/macros/s/AKfycbxsQLOyMwtGe2lM8oTl6ABjH_WKM1ko2OUKPy0NjCtdLmYVE4ly9NKIq2C7QI58WhZELA/exec

앱을 홈 화면에서 삭제한 뒤 다시 설치해도 URL을 다시 입력할 필요가 없습니다.

## v4 추가 기능

- Apps Script URL 기본 내장
- 앱 실행 시 Google Drive 기록 자동 불러오기
- `Drive 새로고침` 버튼
- 로컬 기록과 Drive 기록 병합
- `session_id` 기준 중복 제거
- 홈 화면 앱 재설치 후 과거 기록 복원
- 최근 기록을 오늘 운동으로 불러오기
- 오늘 운동 종목별 수정

## 반드시 해야 하는 Apps Script 작업

현재 배포된 Apps Script는 저장 기능만 있으므로 `google-apps-script.gs` 내용으로 수정해야 합니다.

1. 기존 Apps Script 프로젝트 열기
2. 기존 `DRIVE_FOLDER_ID` 값을 확인
3. v4의 `google-apps-script.gs` 코드 붙여넣기
4. 첫 줄의 `DRIVE_FOLDER_ID`에 기존 폴더 ID 입력
5. `배포 > 배포 관리`
6. 기존 웹 앱 배포의 연필 아이콘 선택
7. 버전을 `새 버전`으로 선택
8. 배포

기존 배포를 업데이트하면 위 `/exec` URL은 그대로 유지됩니다.

## GitHub Pages 업데이트

압축파일의 웹 파일을 기존 GitHub 저장소에 덮어쓰세요.

업데이트 전 현재 앱의 `전체 내보내기`로 로컬 기록을 백업하는 것을 권장합니다.

test
