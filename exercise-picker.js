(() => {
  const input = document.getElementById('exerciseName');
  const datalist = document.getElementById('exerciseOptions');
  if (!input || !datalist) return;

  // iOS Safari는 autocomplete="off"를 무시하고 연락처/이름 자동완성을 제안하는 경우가 있다.
  // 브라우저 기본 datalist 대신 직접 제어하는 운동명 선택창을 사용한다.
  input.removeAttribute('list');
  input.setAttribute('name', 'workout-exercise-name');
  input.setAttribute('autocomplete', 'new-password');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('spellcheck', 'false');

  const style = document.createElement('style');
  style.textContent = `
    .exercise-picker-wrap{position:relative}
    .exercise-picker-menu{position:absolute;z-index:1000;left:0;right:0;top:calc(100% + 4px);max-height:260px;overflow:auto;background:#fff;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 12px 28px rgba(15,23,42,.14);padding:6px;display:none}
    .exercise-picker-menu.show{display:block}
    .exercise-picker-option{display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:8px;padding:11px 12px;font:inherit;color:#111827}
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

    // app.js의 기본 운동명
    try {
      if (typeof DEFAULT_EXERCISES !== 'undefined') {
        DEFAULT_EXERCISES.forEach(name => names.add(String(name || '').trim()));
      }
    } catch (_) {}

    // Drive에서 불러온 과거 운동명
    try {
      if (typeof state !== 'undefined' && Array.isArray(state.sessions)) {
        state.sessions.forEach(session => {
          (session.exercises || []).forEach(ex => names.add(String(ex.exercise || '').trim()));
        });
      }
    } catch (_) {}

    // datalist에 이미 렌더된 항목도 포함
    datalist.querySelectorAll('option').forEach(option => {
      names.add(String(option.value || '').trim());
    });

    return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ko'));
  }

  function renderMenu() {
    const query = input.value.trim().toLocaleLowerCase('ko');
    const names = currentNames();
    const matches = query
      ? names.filter(name => name.toLocaleLowerCase('ko').includes(query))
      : names;

    if (!matches.length) {
      menu.innerHTML = '<div class="exercise-picker-empty">일치하는 운동명이 없습니다. 새 운동명은 그대로 입력할 수 있습니다.</div>';
    } else {
      menu.innerHTML = matches.slice(0, 60).map(name =>
        `<button type="button" class="exercise-picker-option" data-exercise-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`
      ).join('');
    }
    menu.classList.add('show');
  }

  function closeMenu() {
    menu.classList.remove('show');
  }

  input.addEventListener('focus', renderMenu);
  input.addEventListener('click', renderMenu);
  input.addEventListener('input', renderMenu);

  menu.addEventListener('pointerdown', event => {
    const button = event.target.closest('[data-exercise-name]');
    if (!button) return;
    event.preventDefault();
    input.value = button.dataset.exerciseName || '';
    closeMenu();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  document.addEventListener('pointerdown', event => {
    if (event.target === input || menu.contains(event.target)) return;
    closeMenu();
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenu();
  });
})();
