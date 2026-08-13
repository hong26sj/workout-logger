(() => {
  const input = document.getElementById('exerciseName');
  const datalist = document.getElementById('exerciseOptions');
  const previousRecord = document.getElementById('previousRecord');
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

  function normalizeName(value) {
    return String(value || '').trim().toLowerCase();
  }

  function latestExerciseRecord(name) {
    const key = normalizeName(name);
    if (!key) return null;

    let latest = null;
    try {
      if (typeof state === 'undefined' || !Array.isArray(state.sessions)) return null;
      state.sessions.forEach(session => {
        const sessionAt = session.finished_at || session.started_at || session.workout_date || '';
        (session.exercises || []).forEach(ex => {
          if (normalizeName(ex.exercise) !== key) return;
          const candidate = { ...ex, session_at: sessionAt };
          if (!latest || new Date(candidate.session_at || 0) > new Date(latest.session_at || 0)) {
            latest = candidate;
          }
        });
      });
    } catch (_) {
      return null;
    }
    return latest;
  }

  function summaryText(ex) {
    const type = ex.record_type || 'weighted';
    if (type === 'weighted') return `${ex.weight_kg ?? 0}kg × ${ex.reps ?? 0}회 × ${ex.sets ?? 0}세트`;
    if (type === 'bodyweight') return `${ex.reps ?? 0}회 × ${ex.sets ?? 0}세트`;
    return `${ex.seconds ?? 0}초 × ${ex.sets ?? 0}세트`;
  }

  function shortDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric', month: 'numeric', day: 'numeric'
    }).format(d);
  }

  function renderRecentRecordCard() {
    if (!previousRecord) return;
    const name = input.value.trim();
    if (!name) {
      previousRecord.classList.add('hidden');
      previousRecord.innerHTML = '';
      previousRecord.removeAttribute('role');
      previousRecord.removeAttribute('tabindex');
      delete previousRecord.dataset.recentFill;
      return;
    }

    const latest = latestExerciseRecord(name);
    previousRecord.classList.remove('hidden');

    if (!latest) {
      previousRecord.innerHTML = '이 운동의 이전 기록이 없습니다.';
      previousRecord.style.cursor = 'default';
      previousRecord.removeAttribute('role');
      previousRecord.removeAttribute('tabindex');
      delete previousRecord.dataset.recentFill;
      return;
    }

    previousRecord.dataset.recentFill = '1';
    previousRecord.setAttribute('role', 'button');
    previousRecord.setAttribute('tabindex', '0');
    previousRecord.setAttribute('aria-label', '최근 운동 기록을 입력칸에 불러오기');
    previousRecord.style.cursor = 'pointer';
    previousRecord.style.userSelect = 'none';
    previousRecord.innerHTML = `<strong>최근 기록</strong><br>${shortDate(latest.session_at)} · ${summaryText(latest)}<br><span style="font-weight:800;color:#111827">터치해서 입력칸에 불러오기 ›</span>`;
  }

  function fillLatestRecord() {
    const latest = latestExerciseRecord(input.value);
    if (!latest) return;

    const type = latest.record_type || 'weighted';
    const recordType = document.getElementById('recordType');
    if (recordType) {
      recordType.value = type;
      if (typeof updateFields === 'function') updateFields();
    }

    if (type === 'weighted') {
      const weight = document.getElementById('weightKg');
      const reps = document.getElementById('repsWeighted');
      const sets = document.getElementById('setsWeighted');
      if (weight) weight.value = latest.weight_kg ?? '';
      if (reps) reps.value = latest.reps ?? '';
      if (sets) sets.value = latest.sets ?? 3;
    } else if (type === 'bodyweight') {
      const reps = document.getElementById('repsBodyweight');
      const sets = document.getElementById('setsBodyweight');
      if (reps) reps.value = latest.reps ?? '';
      if (sets) sets.value = latest.sets ?? 3;
    } else {
      const seconds = document.getElementById('secondsTimed');
      const sets = document.getElementById('setsTimed');
      if (seconds) seconds.value = latest.seconds ?? '';
      if (sets) sets.value = latest.sets ?? 3;
    }

    // RPE·통증·메모는 과거 운동 당시의 주관적 상태이므로 자동 복사하지 않는다.
    if (typeof toast === 'function') toast('최근 기록의 무게·횟수·세트를 불러왔습니다.');
  }

  if (previousRecord) {
    previousRecord.addEventListener('click', event => {
      if (previousRecord.dataset.recentFill !== '1') return;
      event.preventDefault();
      fillLatestRecord();
    });

    previousRecord.addEventListener('keydown', event => {
      if (previousRecord.dataset.recentFill !== '1') return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fillLatestRecord();
      }
    });
  }

  // 과거 Drive 기록이나 현재 입력목록이 갱신된 뒤에도
  // 포커스/입력 시 후보 목록을 다시 합쳐 최신 상태로 유지한다.
  input.addEventListener('focus', syncDatalist);
  input.addEventListener('input', syncDatalist);

  // app.js의 기존 최근 기록 표시가 실행된 뒤 터치 가능한 카드로 갱신한다.
  ['focus', 'input', 'change'].forEach(type => {
    input.addEventListener(type, () => setTimeout(renderRecentRecordCard, 0));
  });

  syncDatalist();
  renderRecentRecordCard();
})();
