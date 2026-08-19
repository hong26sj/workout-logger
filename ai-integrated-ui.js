(() => {
  const statusLabel = value => {
    const text = String(value || '자료 없음').trim();
    const key = text.toLowerCase();
    const allowed = new Set(['양호','주의','부족','자료 없음']);

    let tone = 'neutral';
    if (/위험|악화|문제|경고|poor|risk/.test(key)) tone = 'bad';
    else if (/주의|보완|부족|낮|높|저하|관찰|caution|low|high/.test(key)) tone = 'warn';
    else if (/좋|양호|적정|안정|정상|개선|good|stable|adequate/.test(key)) tone = 'good';

    let label = text;
    if (!allowed.has(label)) {
      if (/자료\s*없|데이터\s*없|판단\s*불가|insufficient data|unavailable/.test(key)) label = '자료 없음';
      else if (/부족/.test(key)) label = '부족';
      else if (tone === 'good') label = '양호';
      else if (tone === 'warn' || tone === 'bad') label = '주의';
      else label = '상세';
    }

    return `<span class="assessment-status assessment-${tone}" title="${escapeHtml(text)}">${escapeHtml(label)}</span>`;
  };

  const compactList = items => (items && items.length)
    ? `<ul class="analysis-list">${items.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : '<p>특이사항 없음</p>';

  const metric = (label, value, sub = '') => `<div class="metric">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    ${sub ? `<small>${escapeHtml(sub)}</small>` : ''}
  </div>`;

  const nutritionValue = (obj, key, unit, digits = 0) => {
    if (!obj || obj[key] === null || obj[key] === undefined) return '-';
    return `${formatNumber(obj[key], digits)}${unit}`;
  };

  const statusOverview = overall => `<div class="assessment-grid">
    <div><span>체중감량</span>${statusLabel(overall.weight_status)}</div>
    <div><span>운동</span>${statusLabel(overall.training_status)}</div>
    <div><span>회복</span>${statusLabel(overall.recovery_status)}</div>
    <div><span>영양</span>${statusLabel(overall.nutrition_status)}</div>
  </div>`;

  const recoveryHtml = (stats, ai) => {
    const r = stats.recovery || {};
    const hrv = r.hrv || {};
    const resting = r.resting_heart_rate || {};
    const sleep = r.sleep || {};
    const lastSleep = sleep.last_sleep || {};
    const oxygen = r.blood_oxygen || {};
    const respiratory = r.respiratory_rate || {};
    const quality = r.data_quality || {};

    const cards = `<div class="metrics-2 recovery-metrics">
      ${metric('HRV', hrv.latest_ms == null ? '-' : `${formatNumber(hrv.latest_ms, 1)} ms`, hrv.avg_7d_ms == null ? '' : `7일 평균 ${formatNumber(hrv.avg_7d_ms, 1)} ms`)}
      ${metric('안정시 심박', resting.latest_bpm == null ? '-' : `${formatNumber(resting.latest_bpm, 0)} bpm`, resting.avg_7d_bpm == null ? '' : `7일 평균 ${formatNumber(resting.avg_7d_bpm, 1)} bpm`)}
      ${metric('지난 수면', lastSleep.total_sleep_hours == null ? '-' : `${formatNumber(lastSleep.total_sleep_hours, 1)}시간`, sleep.avg_7d_hours == null ? '' : `최근 7일 평균 ${formatNumber(sleep.avg_7d_hours, 1)}시간`)}
      ${metric('수면 중 심박', lastSleep.sleep_hr_avg_bpm == null ? '-' : `${formatNumber(lastSleep.sleep_hr_avg_bpm, 0)} bpm`, lastSleep.sleep_hr_min_bpm == null ? '' : `최저 ${formatNumber(lastSleep.sleep_hr_min_bpm, 0)} bpm`)}
      ${metric('산소포화도', oxygen.latest_pct == null ? '-' : `${formatNumber(oxygen.latest_pct, 0)}%`, oxygen.avg_7d_pct == null ? '' : `7일 평균 ${formatNumber(oxygen.avg_7d_pct, 1)}%`)}
      ${metric('호흡수', respiratory.latest_count_min == null ? '-' : `${formatNumber(respiratory.latest_count_min, 1)}회/분`, respiratory.avg_7d_count_min == null ? '' : `7일 평균 ${formatNumber(respiratory.avg_7d_count_min, 1)}회/분`)}
    </div>`;

    const stages = lastSleep.total_sleep_hours != null ? `<div class="recovery-stage-row">
      <span>깊은 수면 ${lastSleep.deep_hours == null ? '-' : formatNumber(lastSleep.deep_hours, 1) + 'h'}</span>
      <span>코어 ${lastSleep.core_hours == null ? '-' : formatNumber(lastSleep.core_hours, 1) + 'h'}</span>
      <span>REM ${lastSleep.rem_hours == null ? '-' : formatNumber(lastSleep.rem_hours, 1) + 'h'}</span>
      <span>깨어있음 ${lastSleep.awake_hours == null ? '-' : formatNumber(lastSleep.awake_hours, 1) + 'h'}</span>
    </div>` : '';

    return `${cards}${stages}
      <div class="analysis-copy"><p><strong>평가:</strong> ${escapeHtml(ai.summary || '회복 평가 자료가 충분하지 않습니다.')}</p></div>
      ${ai.evidence && ai.evidence.length ? `<h3>근거</h3>${compactList(ai.evidence)}` : ''}
      ${ai.limitations && ai.limitations.length ? `<h3>데이터 제한</h3>${compactList(ai.limitations)}` : ''}
      <p class="data-quality-note">최근 7일 데이터: HRV ${quality.hrv_days_7d ?? 0}일 · 안정시 심박 ${quality.resting_hr_days_7d ?? 0}일 · 수면 ${quality.sleep_days_7d ?? 0}일 · SpO₂ ${quality.blood_oxygen_days_7d ?? 0}일</p>`;
  };

  const nutritionHtml = (stats, ai) => {
    const n = stats.nutrition || {};
    const complete = n.complete_day_average || null;
    const estimated = n.estimated_complete_day_average || null;
    const recorded = n.recorded_all_days_average || null;
    const completeRatio = n.data_quality && n.data_quality.complete_ratio != null
      ? `${formatNumber(Number(n.data_quality.complete_ratio) * 100, 0)}%`
      : '-';

    const primary = complete || estimated || recorded;
    const primaryLabel = complete ? '완전 기록일 평균' : (estimated ? '보정 추정 평균' : '기록량 평균');

    return `<div class="nutrition-summary-head">
      <strong>${escapeHtml(primaryLabel)}</strong>
      <span>기록 ${n.days_recorded ?? 0}일 · 완전 ${n.complete_days ?? 0}일 · 불완전 ${n.incomplete_days ?? 0}일</span>
    </div>
    <div class="metrics-2 nutrition-metrics">
      ${metric('열량', nutritionValue(primary, 'calories_kcal', ' kcal', 0))}
      ${metric('단백질', nutritionValue(primary, 'protein_g', ' g', 1))}
      ${metric('탄수화물', nutritionValue(primary, 'carbs_g', ' g', 1))}
      ${metric('지방', nutritionValue(primary, 'fat_g', ' g', 1))}
    </div>
    <div class="nutrition-quality-row">
      <span>완전 기록 비율 <strong>${completeRatio}</strong></span>
      <span>보정 가능 불완전일 <strong>${n.imputed_complete_days ?? 0}일</strong></span>
    </div>
    <p class="data-quality-note">불완전 기록일의 recorded_total은 실제 하루 총섭취량이 아니라 최소 기록 섭취량으로만 취급합니다. 누락 끼니 보정치는 원본과 분리된 estimated_complete_total입니다.</p>
    <div class="analysis-copy"><p><strong>평가:</strong> ${escapeHtml(ai.summary || '영양 평가 자료가 충분하지 않습니다.')}</p></div>
    ${ai.evidence && ai.evidence.length ? `<h3>근거</h3>${compactList(ai.evidence)}` : ''}
    ${ai.limitations && ai.limitations.length ? `<h3>데이터 제한</h3>${compactList(ai.limitations)}` : ''}`;
  };

  window.renderLatestAnalysis = function renderIntegratedAnalysis(analysis) {
    analysisState.latest = analysis || null;
    if (!analysis) {
      $('analysisBadge').textContent = '분석 없음';
      $('analysisResult').innerHTML = '<div class="empty">저장된 AI 분석이 없습니다.</div>';
      return;
    }

    const overall = analysis.overall_assessment || {};
    const recoveryAi = analysis.recovery_analysis || {};
    const nutritionAi = analysis.nutrition_analysis || {};
    const a = analysis.ai_analysis || {};
    const w = analysis.weight_loss_analysis || {};
    const p = analysis.next_plan || {};
    const stats = analysis.statistics || {};
    const body = stats.body || {};
    const activity = stats.activity || {};

    window.__activityComparison = analysis.activity_comparison || null;
    $('analysisBadge').textContent = new Date(analysis.created_at).toLocaleDateString('ko-KR');

    const bodyFat = normalizePercent(body.body_fat_latest_pct);
    const series = body.weekly_body_series || [];
    const firstWeight = (series.find(x => x.weight_kg !== null && x.weight_kg !== undefined) || {}).weight_kg ?? body.weight_first_kg ?? null;
    const firstFat = normalizePercent((series.find(x => x.body_fat_pct !== null && x.body_fat_pct !== undefined) || {}).body_fat_pct);
    const firstBmi = (series.find(x => x.bmi !== null && x.bmi !== undefined) || {}).bmi ?? null;

    const overallBody = `${statusOverview(overall)}
      <p class="overall-summary">${escapeHtml(overall.summary || a.summary || '종합 평가가 없습니다.')}</p>
      ${overall.key_points && overall.key_points.length ? compactList(overall.key_points) : ''}`;

    const currentMetrics = `<div class="analysis-body metrics-3">
      ${metric('체중', body.weight_latest_kg == null ? '자료 없음' : `${formatNumber(body.weight_latest_kg, 1)}kg`)}
      ${metric('체지방률', bodyFat == null ? '자료 없음' : `${formatNumber(bodyFat, 1)}%`)}
      ${metric('BMI', body.bmi_latest == null ? '자료 없음' : formatNumber(body.bmi_latest, 1))}
    </div>`;

    const trainingItems = (a.progress || []).concat(a.concerns || []).slice(0, 8);
    const trainingBody = `<p>${escapeHtml(a.summary || '')}</p>${compactList(trainingItems)}<p><strong>운동 균형:</strong> ${escapeHtml(a.training_balance || '자료 없음')}</p>`;

    const weightLossBody = `<p>${escapeHtml(w.summary || '')}</p>
      <div class="trend-grid">
        ${trendCard('체중', body.weight_latest_kg, body.weight_latest_kg !== null && firstWeight !== null ? body.weight_latest_kg - firstWeight : null, series, 'weight_kg', '#111827', 'kg', 1)}
        ${trendCard('체지방률', bodyFat, bodyFat !== null && firstFat !== null ? bodyFat - firstFat : null, (series || []).map(x => ({...x, body_fat_pct: normalizePercent(x.body_fat_pct)})), 'body_fat_pct', '#2563eb', '%', 1)}
        ${trendCard('BMI', body.bmi_latest, body.bmi_latest !== null && firstBmi !== null ? body.bmi_latest - firstBmi : null, series, 'bmi', '#16a34a', '', 1)}
      </div>
      <div class="chart-card"><div class="chart-title">활동량 종합 <span>분석 기간</span></div>${activitySummaryHtml(activity, stats.fitness || {})}</div>
      <div class="chart-card"><div class="chart-title">유산소 세션 <span>걷기·달리기</span></div>${cardioSessionsHtml(activity, stats.fitness || {})}</div>
      <p class="chart-note">${escapeHtml(w.activity_assessment || '')}</p>
      ${w.weekly_targets && w.weekly_targets.length ? `<h3>주간 목표</h3>${compactList(w.weekly_targets)}` : ''}
      ${w.limitations && w.limitations.length ? `<h3>해석 제한</h3>${compactList(w.limitations)}` : ''}`;

    const nextPlanBody = `<p>${escapeHtml(p.weekly_goal || '')}</p>${planSessionsHtml(p)}
      ${p.progression_rules && p.progression_rules.length ? `<h3>진행 규칙</h3>${compactList(p.progression_rules)}` : ''}
      ${p.pain_rules && p.pain_rules.length ? `<h3>통증 규칙</h3>${compactList(p.pain_rules)}` : ''}`;

    $('analysisResult').innerHTML = `
      <div class="analysis-meta">분석기간: ${escapeHtml(analysis.period?.from || '')} ~ ${escapeHtml(analysis.period?.to || '')}<br>추가 요청: ${escapeHtml(analysis.additional_request || '없음')}</div>
      ${analysisSection('종합 평가', overallBody, true)}
      ${analysisSection('현재 수치', currentMetrics, true)}
      ${analysisSection('회복 상태', recoveryHtml(stats, recoveryAi), false)}
      ${analysisSection('영양 상태', nutritionHtml(stats, nutritionAi), false)}
      ${analysisSection('운동 분석', trainingBody, false)}
      ${analysisSection('체중감량 분석', weightLossBody, false)}
      ${analysisSection('다음 운동 계획', nextPlanBody, false)}
      ${analysisSection('주의사항', compactList(analysis.warnings || []), false)}`;
  };

  const confirm = document.getElementById('confirmAnalysisBtn');
  if (confirm) {
    confirm.addEventListener('click', () => {
      setTimeout(() => {
        const status = document.getElementById('analysisStatus');
        if (status && status.classList.contains('status-loading')) {
          status.textContent = 'Health·Fitness·근력운동·영양 데이터를 집계하고 회복 상태까지 포함해 OpenAI가 통합 분석 중입니다. 최대 1~2분 걸릴 수 있습니다.';
        }
      }, 0);
    });
  }
})();
