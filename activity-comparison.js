(() => {
  const originalRenderLatestAnalysis = window.renderLatestAnalysis;

  function isFiniteNumber(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function formatAbs(value, digits = 0) {
    return Math.abs(Number(value)).toLocaleString('ko-KR', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function signedPrefix(value) {
    const n = Number(value);
    return n > 0 ? '+' : n < 0 ? '-' : '';
  }

  function formatPaceDelta(minutes) {
    if (!isFiniteNumber(minutes)) return '';
    const seconds = Math.round(Math.abs(Number(minutes)) * 60);
    if (seconds < 60) return `${seconds}초`;
    const min = Math.floor(seconds / 60);
    const sec = String(seconds % 60).padStart(2, '0');
    return `${min}'${sec}\"`;
  }

  function comparisonClass(item) {
    if (!item) return 'comparison-neutral';
    if (item.improved === true) return 'comparison-positive';
    if (item.improved === false) return 'comparison-negative';
    return 'comparison-neutral';
  }

  function comparisonHtml(item, formatter) {
    if (!item || !isFiniteNumber(item.change)) return '';
    const change = Number(item.change);
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '–';
    return `<div class="activity-comparison ${comparisonClass(item)}">
      <strong>${arrow} ${formatter(item)}</strong>
      <span>(이전 대비)</span>
    </div>`;
  }

  function metricCard(label, valueHtml, comparison) {
    return `<div class="activity-metric activity-metric-with-comparison">
      <div class="activity-metric-copy">
        <span>${label}</span>
        <strong>${valueHtml}</strong>
      </div>
      ${comparison}
    </div>`;
  }

  window.activitySummaryHtml = function activitySummaryHtmlWithComparison(activity, fitness) {
    const cardio = activity.cardio_summary || {};
    const comparison = window.__activityComparison || {};

    const steps = comparisonHtml(
      comparison.steps_daily_average,
      item => `${signedPrefix(item.change)}${formatAbs(item.change, 0)}보`
    );

    const distance = comparisonHtml(
      comparison.distance_km,
      item => `${signedPrefix(item.change)}${formatAbs(item.change, 1)}km`
    );

    let cardioChange = '';
    const sessionChange = comparison.cardio_session_count;
    const minutesChange = comparison.cardio_minutes;
    if ((sessionChange && isFiniteNumber(sessionChange.change)) ||
        (minutesChange && isFiniteNumber(minutesChange.change))) {
      const basis = sessionChange || minutesChange;
      const basisChange = Number(basis.change || 0);
      const arrow = basisChange > 0 ? '▲' : basisChange < 0 ? '▼' : '–';
      const parts = [];
      if (sessionChange && isFiniteNumber(sessionChange.change)) {
        parts.push(`${signedPrefix(sessionChange.change)}${formatAbs(sessionChange.change, 0)}회`);
      }
      if (minutesChange && isFiniteNumber(minutesChange.change)) {
        parts.push(`${signedPrefix(minutesChange.change)}${formatAbs(minutesChange.change, 0)}분`);
      }
      cardioChange = `<div class="activity-comparison ${comparisonClass(basis)}">
        <strong>${arrow} ${parts.join(' · ')}</strong>
        <span>(이전 대비)</span>
      </div>`;
    }

    const pace = comparisonHtml(
      comparison.average_pace_min_per_km,
      item => `${signedPrefix(item.change)}${formatPaceDelta(item.change)}`
    );

    const heart = comparisonHtml(
      comparison.average_heart_rate,
      item => `${signedPrefix(item.change)}${formatAbs(item.change, 0)}bpm`
    );

    const kcal = comparisonHtml(
      comparison.active_kcal,
      item => `${signedPrefix(item.change)}${formatAbs(item.change, 0)}kcal`
    );

    return `<div class="activity-summary">
      ${metricCard('평균 걸음 수', `${formatNumber(activity.steps_daily_average, 0)}보/일`, steps)}
      ${metricCard('걷기·달리기 거리', `${formatNumber(cardio.distance_km ?? activity.distance_total_km, 1)}km`, distance)}
      ${metricCard('유산소 운동', `${formatNumber(cardio.session_count ?? fitness.session_count, 0)}회 · ${formatNumber(cardio.total_minutes ?? fitness.total_minutes, 0)}분`, cardioChange)}
      ${metricCard('평균 페이스', cardio.avg_pace_min_per_km ? formatPace(cardio.avg_pace_min_per_km) : '-', pace)}
      ${metricCard('평균 심박수', cardio.avg_hr ? `${formatNumber(cardio.avg_hr, 0)}bpm` : '-', heart)}
      ${metricCard('활동 칼로리', `${formatNumber(cardio.active_kcal ?? activity.active_energy_total_kcal, 0)}kcal`, kcal)}
    </div>`;
  };

  window.renderLatestAnalysis = function renderLatestAnalysisWithComparison(analysis) {
    window.__activityComparison = analysis && analysis.activity_comparison
      ? analysis.activity_comparison
      : null;
    return originalRenderLatestAnalysis(analysis);
  };
})();
