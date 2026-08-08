(() => {
  const historyList = document.getElementById('historyList');
  if (!historyList) return;

  // app.js의 renderCurrent()가 `.delete-btn` 전체에 클릭 핸들러를 다시 붙이면서
  // 최근 기록의 "Drive 삭제" 버튼까지 입력 목록 삭제 핸들러로 덮어쓰는 문제를 차단한다.
  // 이벤트 위임을 capture 단계에서 처리해, 잘못 덮어쓴 onclick보다 먼저 정확한 삭제 로직을 실행한다.
  historyList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-session]');
    if (!button || !historyList.contains(button)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const sessionIndex = Number(button.dataset.deleteSession);
    if (!Number.isInteger(sessionIndex) || sessionIndex < 0) return;

    deleteDriveSession(sessionIndex);
  }, true);
})();
