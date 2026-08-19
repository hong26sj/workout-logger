(() => {
  const originalRenderLatestAnalysis = window.renderLatestAnalysis;
  if (typeof originalRenderLatestAnalysis !== 'function') return;

  const style = document.createElement('style');
  style.textContent = `
    .training-v2-summary{display:flex;justify-content:space-between;gap:10px;margin:-1px 0 7px;color:var(--muted);font-size:11px}
    .training-v2-summary strong{color:var(--text);font-size:12px}
    .training-v2-legend{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:5px;color:var(--muted);font-size:10px;font-weight:800}
    .training-v2-legend span{display:inline-flex;align-items:center;gap:5px}
    .training-v2-line::before{content:"";width:15px;height:3px;border-radius:999px;background:#111827}
    .training-v2-bar::before{content:"";width:10px;height:10px;border-radius:3px;background:#cbd5e1}
    .training-v2-chart{display:block;width:100%;height:132px;overflow:visible}
    .training-v2-grid{stroke:#e5e7eb;stroke-width:1}
    .training-v2-strength{fill:#cbd5e1}
    .training-v2-cardio{fill:none;stroke:#111827;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
    .training-v2-points circle{fill:#111827}
    .training-v2-labels text{fill:#6b7280;font-size:8px}
    .training-v2-unit{fill:#6b7280;font-size:8px;font-weight:900}
    .training-v2-tick{fill:#9ca3af;font-size:7px}
  `;
  document.head.appendChild(style);

  const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  const num = value => finite(value) ? Number(value) : 0;
  const fmt = (value, digits = 0) => Number(value || 0).toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });

  const parseDate = value => {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  };

  const dateKey = value => {
    const d = parseDate(value);
    if (!d) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function buildSevenDays(periodTo) {
    const end = parseDate(periodTo) || new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      const key = dateKey(d);
      days.push({
        key,
        label: i === 0 ? '오늘' : `${d.getMonth() + 1}/${d.getDate()}`
      });
    }
    return days;
  }

  function sessionDurationMinutes(session) {
    if (finite(session.duration_min) && Number(session.duration_min) > 0) return Number(session.duration_min);
    if (finite(session.distance_km) && finite(session.pace_min_per_km) && Number(session.distance_km) > 0 && Number(session.pace_min_per_km) > 0) {
      return Number(session.distance_km) * Number(session.pace_min_per_km);
    }
    return 0;
  }

  function recentCardioSessions(stats, daySet) {
    const activity = stats.activity || {};
    const fitness = stats.fitness || {};
    const cardioSummary = activity.cardio_summary || {};

    // quality_sessions는 Apps Script에서 통근성/저속 야외걷기 제외 규칙까지 적용된 전체 유산소 세션 목록입니다.
    let source = Array.isArray(cardioSummary.quality_sessions) ? cardioSummary.quality_sessions : [];
    if (!source.length && Array.isArray(activity.cardio_sessions)) source = activity.cardio_sessions;
    if (!source.length && Array.isArray(fitness.cardio_sessions)) source = fitness.cardio_sessions;
    if (!source.length && Array.isArray(fitness.sessions)) {
      source = fitness.sessions.filter(session => session.is_walk_run && !session.cardio_exclusion_reason);
    }

    return source
      .filter(session => daySet.has(dateKey(session.start || session.date)))
      .map(session => ({...session, duration_min: sessionDurationMinutes(session)}));
  }

  function recentStrengthSessions(stats, daySet) {
    const strength = stats.strength || {};
    return (Array.isArray(strength.daily_sessions) ? strength.daily_sessions : [])
      .filter(session => daySet.has(dateKey(session.date || session.started_at || session.finished_at)));
  }

  function intensityDistribution(cardioSessions) {
    const totals = {low: 0, moderate: 0, vigorous: 0};

    cardioSessions.forEach(session => {
      const duration = sessionDurationMinutes(session);
      const category = String(session.intensity_category || '').toLowerCase();
      if (category === 'low' || category === 'moderate' || category === 'vigorous') {
        totals[category] += duration;
        return;
      }

      const pe = session.physical_effort || {};
      totals.low += num(pe.low_minutes_est);
      totals.moderate += num(pe.moderate_minutes_est);
      totals.vigorous += num(pe.vigorous_minutes_est);
    });

    const total = totals.low + totals.moderate + totals.vigorous;
    const pct = key => total > 0 ? Math.round(totals[key] / total * 100) : 0;
    return {total, low: pct('low'), moderate: pct('moderate'), vigorous: pct('vigorous')};
  }

  function dualAxisSvg(days, cardioByDay, strengthByDay) {
    const cardioValues = days.map(day => cardioByDay[day.key] || 0);
    const strengthValues = days.map(day => strengthByDay[day.key] || 0);
    const maxMinutes = Math.max(...cardioValues, 1);
    const maxSets = Math.max(...strengthValues, 1);

    const left = 30;
    const right = 282;
    const top = 14;
    const bottom = 70;
    const height = bottom - top;
    const stepX = (right - left) / 6;
    const barWidth = 18;
    const xAt = index => left + index * stepX;
    const cardioY = value => bottom - (Number(value || 0) / maxMinutes) * height;
    const strengthY = value => bottom - (Number(value || 0) / maxSets) * height;

    const bars = strengthValues.map((value, index) => {
      const x = xAt(index) - barWidth / 2;
      const y = strengthY(value);
      return `<rect class="training-v2-strength" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth}" height="${Math.max(0, bottom - y).toFixed(1)}" rx="4"></rect>`;
    }).join('');

    const points = cardioValues.map((value, index) => `${xAt(index).toFixed(1)},${cardioY(value).toFixed(1)}`).join(' ');
    const circles = cardioValues.map((value, index) => `<circle cx="${xAt(index).toFixed(1)}" cy="${cardioY(value).toFixed(1)}" r="3.2"></circle>`).join('');
    const labels = days.map((day, index) => `<text x="${xAt(index).toFixed(1)}" y="91" text-anchor="${index === 0 ? 'start' : index === 6 ? 'end' : 'middle'}">${day.label}</text>`).join('');

    return `<svg class="training-v2-chart" viewBox="0 0 312 98" role="img" aria-label="최근 7일 유산소 운동시간과 근력 총 세트 이중축 그래프">
      <text class="training-v2-unit" x="4" y="10">분</text>
      <text class="training-v2-unit" x="308" y="10" text-anchor="end">세트</text>
      <text class="training-v2-tick" x="4" y="${top + 3}">${fmt(maxMinutes, 0)}</text>
      <text class="training-v2-tick" x="4" y="${bottom + 3}">0</text>
      <text class="training-v2-tick" x="308" y="${top + 3}" text-anchor="end">${fmt(maxSets, 0)}</text>
      <text class="training-v2-tick" x="308" y="${bottom + 3}" text-anchor="end">0</text>
      <line class="training-v2-grid" x1="${left}" y1="${top}" x2="${right}" y2="${top}"></line>
      <line class="training-v2-grid" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"></line>
      <g>${bars}</g>
      <polyline class="training-v2-cardio" points="${points}"></polyline>
      <g class="training-v2-points">${circles}</g>
      <g class="training-v2-labels">${labels}</g>
    </svg>`;
  }

  function buildVisualHtml(analysis) {
    const stats = analysis.statistics || {};
    const days = buildSevenDays((analysis.period && analysis.period.to) || analysis.created_at);
    const daySet = new Set(days.map(day => day.key));
    const cardioSessions = recentCardioSessions(stats, daySet);
    const strengthSessions = recentStrengthSessions(stats, daySet);
    const intensity = intensityDistribution(cardioSessions);

    const cardioByDay = Object.fromEntries(days.map(day => [day.key, 0]));
    cardioSessions.forEach(session => {
      const key = dateKey(session.start || session.date);
      if (Object.prototype.hasOwnProperty.call(cardioByDay, key)) cardioByDay[key] += sessionDurationMinutes(session);
    });

    const strengthByDay = Object.fromEntries(days.map(day => [day.key, 0]));
    strengthSessions.forEach(session => {
      const key = dateKey(session.date || session.started_at || session.finished_at);
      if (Object.prototype.hasOwnProperty.call(strengthByDay, key)) strengthByDay[key] += num(session.total_sets);
    });

    const cardioMinutes = Object.values(cardioByDay).reduce((sum, value) => sum + value, 0);
    const strengthSets = Object.values(strengthByDay).reduce((sum, value) => sum + value, 0);
    const maxCount = Math.max(cardioSessions.length, strengthSessions.length, 1);

    return `<div class="training-viz">
      <div class="viz-card">
        <div class="viz-title">최근 7일 운동 구성</div>
        <div class="freq-grid">
          <div class="freq-box"><span>근력</span><strong>${strengthSessions.length}회</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.round(strengthSessions.length / maxCount * 100)}%"></div></div></div>
          <div class="freq-box"><span>유산소</span><strong>${cardioSessions.length}회</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.round(cardioSessions.length / maxCount * 100)}%"></div></div></div>
        </div>
      </div>
      <div class="viz-card">
        <div class="viz-title">유산소 강도 분포</div>
        ${intensity.total > 0 ? `
          <div class="intensity-row"><span>저강도</span><div class="bar-track"><div class="bar-fill" style="width:${intensity.low}%"></div></div><strong>${intensity.low}%</strong></div>
          <div class="intensity-row"><span>중강도</span><div class="bar-track"><div class="bar-fill" style="width:${intensity.moderate}%"></div></div><strong>${intensity.moderate}%</strong></div>
          <div class="intensity-row"><span>고강도</span><div class="bar-track"><div class="bar-fill" style="width:${intensity.vigorous}%"></div></div><strong>${intensity.vigorous}%</strong></div>
        ` : '<p class="viz-empty">최근 7일 강도 데이터가 없습니다.</p>'}
        <p class="viz-note">Fitness intensity(MET-equivalent)를 우선하고 Health physical_effort를 보조값으로 사용합니다.</p>
      </div>
      <div class="viz-card">
        <div class="viz-title">최근 7일 운동량 추세</div>
        <div class="training-v2-summary"><span>유산소 <strong>${fmt(cardioMinutes, 0)}분</strong></span><span>근력 <strong>${fmt(strengthSets, 0)}세트</strong></span></div>
        <div class="training-v2-legend"><span class="training-v2-line">유산소 시간(분)</span><span class="training-v2-bar">근력 총 세트</span></div>
        ${dualAxisSvg(days, cardioByDay, strengthByDay)}
        <p class="viz-note">좌축은 유산소 운동시간(분), 우축은 근력운동 총 세트 수입니다. 서로 다른 단위는 각각 독립적으로 스케일링합니다.</p>
      </div>
    </div>`;
  }

  function patchTrainingVisual(analysis) {
    const root = document.getElementById('analysisResult');
    if (!root || !analysis) return;
    const block = [...root.querySelectorAll('details.analysis-block')]
      .find(details => (details.querySelector('summary')?.textContent || '').trim().startsWith('운동 분석'));
    if (!block) return;
    const oldVisual = block.querySelector('.training-viz');
    if (!oldVisual) return;
    oldVisual.outerHTML = buildVisualHtml(analysis);
  }

  window.renderLatestAnalysis = function renderLatestAnalysisTrainingV2(analysis) {
    const result = originalRenderLatestAnalysis(analysis);
    patchTrainingVisual(analysis);
    return result;
  };
})();
