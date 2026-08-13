(() => {
  const input = document.getElementById('exerciseName');
  const box = document.getElementById('previousRecord');
  if (!input || !box) return;

  function latestExercise(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key || typeof state === 'undefined' || !Array.isArray(state.sessions)) return null;

    let latest = null;
    for (const session of state.sessions) {
      const sessionAt = session.finished_at || session.started_at || session.workout_date || '';
      for (const exercise of (session.exercises || [])) {
        if (String(exercise.exercise || '').trim().toLowerCase() !== key) continue;
        const candidate = { ...exercise, session_at: sessionAt };
        if (!latest || new Date(candidate.session_at || 0) > new Date(latest.session_at || 0)) {
          latest = candidate;
        }
      }
    }
    return latest;
  }

  function render() {
    const name = input.value.trim();
    if (!name) {
      box.classList.add('hidden');
      box.classList.remove('previous-record-action');
      box.innerHTML = '';
      box.removeAttribute('role');
      box.removeAttribute('tabindex');
      return;
    }

    const prev = latestExercise(name);
    if (!prev) {
      box.classList.remove('hidden');
      box.classList.remove('previous-record-action');
      box.innerHTML = '이 운동의 이전 기록이 없습니다.';
      box.removeAttribute('role');
      box.removeAttribute('tabindex');
      return;
    }

    const dateText = typeof dateLabel === 'function' ? dateLabel(prev.session_at) : (prev.session_at || '');
    const recordText = typeof summary === 'function' ? summary(prev) : '';
    box.classList.remove('hidden');
    box.classList.add('previous-record-action');
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');
    box.dataset.exercise = name;
    box.innerHTML = `<div class="previous-record-head"><strong>최근 기록</strong><span>불러오기 ›</span></div><div class="previous-record-summary">${escapeHtml(dateText)} · ${escapeHtml(recordText)}</div>`;
  }

  function fillFromLatest() {
    const prev = latestExercise(input.value);
    if (!prev) return;

    const type = prev.record_type || 'weighted';
    const recordType = document.getElementById('recordType');
    if (recordType) recordType.value = type;
    if (typeof updateFields === 'function') updateFields();

    if (type === 'weighted') {
      document.getElementById('weightKg').value = prev.weight_kg ?? '';
      document.getElementById('repsWeighted').value = prev.reps ?? '';
      document.getElementById('setsWeighted').value = prev.sets ?? 3;
    } else if (type === 'bodyweight') {
      document.getElementById('repsBodyweight').value = prev.reps ?? '';
      document.getElementById('setsBodyweight').value = prev.sets ?? 3;
    } else if (type === 'timed') {
      document.getElementById('secondsTimed').value = prev.seconds ?? '';
      document.getElementById('setsTimed').value = prev.sets ?? 3;
    }

    if (typeof toast === 'function') toast('최근 기록의 중량·횟수·세트를 불러왔습니다.');
  }

  input.addEventListener('input', () => setTimeout(render, 0));
  input.addEventListener('change', () => setTimeout(render, 0));
  input.addEventListener('blur', () => setTimeout(render, 0));

  box.addEventListener('click', event => {
    if (!box.classList.contains('previous-record-action')) return;
    event.preventDefault();
    event.stopPropagation();
    fillFromLatest();
  });

  box.addEventListener('keydown', event => {
    if (!box.classList.contains('previous-record-action')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fillFromLatest();
    }
  });

  render();
})();
