(() => {
  const input = document.getElementById('exerciseName');
  const datalist = document.getElementById('exerciseOptions');
  if (!input || !datalist) return;

  // 기본 datalist 연결은 유지한다.
  // - 입력값이 비어 있을 때: 자체 전체목록을 입력창 아래에 표시
  // - 한 글자라도 입력하면: 자체 목록을 닫고 iOS/Safari의 네이티브 datalist 후보를 사용
  input.setAttribute('list', 'exerciseOptions');
  input.setAttribute('name', 'workout-exercise-name');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('spellcheck', 'false');

  const style = document.createElement('style');
  style.textContent = `
    .exercise-picker-wrap{position:relative}
    .exercise-picker-menu{position:absolute;z-index:1000;left:0;right:0;top:calc(100% + 4px);max-height:260px;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;background:#fff;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 12px 28px rgba(15,23,42,.14);padding:6px;display:none}
    .exercise-picker-menu.show{display:block}
    .exercise-picker-option{display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:8px;padding:11px 12px;font:inherit;color:#111827;touch-action:pan-y}
    .exercise-picker-option:active,.exercise-picker-option:hover{background:#f3f4f6}
    .exercise-picker-empty{padding:10px 12px;color:#6b7280;font-size:.9rem}
  `;
  document.head.appendChild(style);

  const parent = input.parentElement;
  parent.classList.add('exercise-picker-wrap');
  const menu = document.createElement('div');
  menu.className = 'exercise-picker-menu';
  menu.id = 'exercisePickerMenu';
  parent.appendChild(menu);

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
    return names;
  }

  function renderFullMenu() {
    if (input.value.trim()) {
      closeMenu();
      return;
    }

    const names = syncDatalist();
    if (!names.length) {
      menu.innerHTML = '<div class="exercise-picker-empty">저장된 운동명이 없습니다.</div>';
    } else {
      menu.innerHTML = names.slice(0, 80).map(name =>
        `<button type="button" class="exercise-picker-option" data-exercise-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`
      ).join('');
    }
    menu.scrollTop = 0;
    menu.classList.add('show');
  }

  function closeMenu() {
    menu.classList.remove('show');
  }

  function selectExercise(button) {
    input.value = button.dataset.exerciseName || '';
    closeMenu();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  input.addEventListener('focus', renderFullMenu);
  input.addEventListener('click', () => {
    if (!input.value.trim()) renderFullMenu();
  });

  input.addEventListener('input', () => {
    syncDatalist();
    if (input.value.trim()) closeMenu();
    else renderFullMenu();
  });

  // 중요: pointerdown에서 선택하면 iOS에서 스크롤을 시작하려는 첫 터치가
  // 즉시 항목 선택으로 처리된다. 실제 tap(click)이 끝났을 때만 선택한다.
  // 손가락을 위/아래로 움직이면 브라우저가 스크롤 제스처로 처리하므로 선택되지 않는다.
  menu.addEventListener('click', event => {
    const button = event.target.closest('[data-exercise-name]');
    if (!button) return;
    selectExercise(button);
  });

  document.addEventListener('pointerdown', event => {
    if (event.target === input || menu.contains(event.target)) return;
    closeMenu();
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenu();
  });

  syncDatalist();
})();
