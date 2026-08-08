(() => {
  // app.js의 기존 renderCurrent()는 `.delete-btn`을 문서 전체에서 찾기 때문에
  // 최근 기록의 "Drive 삭제" 버튼까지 입력 목록 삭제 핸들러로 덮어쓸 수 있다.
  // renderCurrent 자체를 교체해 입력 목록(#exerciseList) 내부 버튼에만 이벤트를 연결한다.
  renderCurrent = function renderCurrentScoped() {
    $("exerciseCount").textContent = `${state.current.length}개`;
    $("emptyState").style.display = state.current.length ? "none" : "block";
    $("saveSessionBtn").disabled = !state.current.length;
    $("clearBtn").disabled = !state.current.length;

    const exerciseList = $("exerciseList");
    exerciseList.innerHTML = state.current.map((ex, i) => `
      <article class="exercise-item">
        <div class="item-head">
          <div>
            <div class="item-title">${escapeHtml(ex.exercise)}</div>
            <div class="item-meta">${summary(ex)}${ex.rpe ? ` · RPE ${ex.rpe}` : ""}${ex.pain_level ? ` · 통증 ${ex.pain_level}/10` : ""}</div>
          </div>
          <div class="item-buttons">
            <button class="edit-btn" data-edit="${i}">수정</button>
            <button class="delete-btn" data-index="${i}">삭제</button>
          </div>
        </div>
      </article>`).join("");

    exerciseList.querySelectorAll(".edit-btn").forEach(btn => {
      btn.onclick = () => startEditExercise(Number(btn.dataset.edit));
    });

    exerciseList.querySelectorAll(".delete-btn").forEach(btn => {
      btn.onclick = () => {
        const idx = Number(btn.dataset.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= state.current.length) return;

        state.current.splice(idx, 1);
        if (state.editingIndex === idx) cancelEdit();
        else if (state.editingIndex !== null && state.editingIndex > idx) state.editingIndex--;
        renderCurrent();
      };
    });
  };
})();
