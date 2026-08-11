(() => {
  const input = document.getElementById('exerciseName');
  const datalist = document.getElementById('exerciseOptions');
  if (!input || !datalist) return;

  // iPhone/Safari의 기본 datalist UI만 사용한다.
  // 커스텀 드롭다운은 생성하지 않는다.
  input.setAttribute('list', 'exerciseOptions');
  input.setAttribute('name', 'workout-exercise-name');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('spellcheck', 'false');

  function currentNames() {
    const names = new Set();

    try {
      if (typeof DEFAULT_EXERCISES !== 'undefined') {
        DEFAULT_EXERCISES.forEach(name => names.add(String(name || '').trim()));
      }
    } catch (_) {}

    try {
      if (typeof state !== 'undefined' && Array.isArray(state.current)) {
        state.current.forEach(ex => names.add(String(ex.exercise || '').trim()));
      }
    } catch (_) {}

    try {
      if (typeof state !== 'undefined' && Array.isArray(state.sessions)) {
        state.sessions.forEach(session => {
          (session.exercises || []).forEach(ex => names.add(String(ex.exercise || '').trim()));
        });
      }
    } catch (_) {}

    datalist.querySelectorAll('option').forEach(option => {
      names.add(String(option.value || '').trim());
    });

    return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ko'));
  }

  function syncDatalist() {
    const names = currentNames();
    datalist.innerHTML = names
      .map(name => `<option value="${escapeHtml(name)}"></option>`)
      .join('');
  }

  // 과거 Drive 기록이나 현재 입력목록이 갱신된 뒤에도
  // 포커스/입력 시 후보 목록을 다시 합쳐 최신 상태로 유지한다.
  input.addEventListener('focus', syncDatalist);
  input.addEventListener('input', syncDatalist);

  syncDatalist();
})();
