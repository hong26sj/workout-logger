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

  const sectionStatusHtml = value => `<div class="section-status">
    <span>현재 단계</span>${statusLabel(value)}
  </div>`;

  const shortSummary = (value, maxSentences = 2, maxChars = 190) => {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (!text) return '';
    const parts = text.match(/[^.!?。！？]+[.!?。！？]?/g) || [text];
    let out = parts.slice(0, maxSentences).join(' ').trim();
    if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trim()}…`;
    return out;
  };

  const parseDateValue = value => {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  };

  const recentSevenStart = endValue => {
    const end = parseDateValue(endValue) || new Date();
    const start = new Date(end);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    return start;
  };

  const isRecentSeven = (value, endValue) => {
    const d = parseDateValue(value);
    if (!d) return false;
    const start = recentSevenStart(endValue);
    const end = parseDateValue(endValue) || new Date();
    end.setHours(23, 59, 59, 999);
    return d >= start && d <= end;
  };

  const recommendationHtml = recommendations => {
    const items = Array.isArray(recommendations) ? recommendations.slice(0, 3) : [];
    if (!items.length) return '';
    return `<h3>추천 식단</h3>
      <div class="food-recommendations">
        ${items.map(item => `<div class="food-rec">
          <div class="food-rec-head">
            <strong>${escapeHtml(item.nutrient || '영양 보완')}</strong>
            <span>${escapeHtml(item.priority || '보통')}</span>
          </div>
          ${item.reason ? `<p class="food-reason">${escapeHtml(shortSummary(item.reason, 1, 90))}</p>` : ''}
          <div class="food-chips">${(item.foods || []).slice(0, 4).map(food => `<span class="food-chip">${escapeHtml(food)}</span>`).join('')}</div>
        </div>`).join('')}
      </div>`;
  };

  const trainingVisualHtml = (stats, periodTo) => {
    const strength = stats.strength || {};
    const activity = stats.activity || {};
    const fitness = stats.fitness || {};

    const strengthSessions = (strength.daily_sessions || []).filter(x => isRecentSeven(x.date || x.finished_at || x.started_at, periodTo));
    const cardioSource = activity.cardio_sessions || fitness.cardio_sessions || [];
    const cardioSessions = cardioSource.filter(x => isRecentSeven(x.start || x.date, periodTo));

    const strengthCount = strengthSessions.length;
    const cardioCount = cardioSessions.length;
    const maxCount = Math.max(strengthCount, cardioCount, 1);

    const distribution = cardioSessions.reduce((acc, session) => {
      const pe = session.physical_effort || {};
      const low = Number(pe.low_minutes_est || 0);
      const moderate = Number(pe.moderate_minutes_est || 0);
      const vigorous = Number(pe.vigorous_minutes_est || 0);
      if (low + moderate + vigorous > 0) {
        acc.low += low;
        acc.moderate += moderate;
        acc.vigorous += vigorous;
      } else {
        const minutes = Number(session.duration_min || 0);
        if (session.intensity_category === 'low') acc.low += minutes;
        else if (session.intensity_category === 'moderate') acc.moderate += minutes;
        else if (session.intensity_category === 'vigorous') acc.vigorous += minutes;
      }
      return acc;
    }, {low:0, moderate:0, vigorous:0});

    const distTotal = distribution.low + distribution.moderate + distribution.vigorous;
    const distPct = key => distTotal > 0 ? Math.round(distribution[key] / distTotal * 100) : 0;

    const end = parseDateValue(periodTo) || new Date();
    const dayKeys = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      dayKeys.push({key, label:i === 0 ? '오늘' : `${d.getMonth()+1}/${d.getDate()}`});
    }
    const minutesByDay = Object.fromEntries(dayKeys.map(x => [x.key, 0]));
    cardioSessions.forEach(session => {
      const d = parseDateValue(session.start || session.date);
      if (!d) return;
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (Object.prototype.hasOwnProperty.call(minutesByDay, key)) minutesByDay[key] += Number(session.duration_min || 0);
    });
    const values = dayKeys.map(x => minutesByDay[x.key]);
    const maxMinutes = Math.max(...values, 1);
    const points = values.map((v, i) => {
      const x = 12 + i * 48;
      const y = 62 - (v / maxMinutes) * 46;
      return `${x},${y.toFixed(1)}`;
    }).join(' ');
    const circles = values.map((v, i) => {
      const x = 12 + i * 48;
      const y = 62 - (v / maxMinutes) * 46;
      return `<circle cx="${x}" cy="${y.toFixed(1)}" r="3"></circle>`;
    }).join('');
    const labels = dayKeys.map((x, i) => `<text x="${12 + i * 48}" y="78" text-anchor="${i === 0 ? 'start' : i === 6 ? 'end' : 'middle'}">${escapeHtml(x.label)}</text>`).join('');

    return `<div class="training-viz">
      <div class="viz-card">
        <div class="viz-title">최근 7일 운동 구성</div>
        <div class="freq-grid">
          <div class="freq-box"><span>근력</span><strong>${strengthCount}회</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.round(strengthCount/maxCount*100)}%"></div></div></div>
          <div class="freq-box"><span>유산소</span><strong>${cardioCount}회</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.round(cardioCount/maxCount*100)}%"></div></div></div>
        </div>
      </div>
      <div class="viz-card">
        <div class="viz-title">유산소 강도 분포</div>
        ${distTotal > 0 ? `
          <div class="intensity-row"><span>저강도</span><div class="bar-track"><div class="bar-fill" style="width:${distPct('low')}%"></div></div><strong>${distPct('low')}%</strong></div>
          <div class="intensity-row"><span>중강도</span><div class="bar-track"><div class="bar-fill" style="width:${distPct('moderate')}%"></div></div><strong>${distPct('moderate')}%</strong></div>
          <div class="intensity-row"><span>고강도</span><div class="bar-track"><div class="bar-fill" style="width:${distPct('vigorous')}%"></div></div><strong>${distPct('vigorous')}%</strong></div>
        ` : '<p class="viz-empty">최근 7일 강도 데이터가 없습니다.</p>'}
        <p class="viz-note">Fitness intensity(MET-equivalent)를 우선하고 Health physical_effort를 보조값으로 사용합니다.</p>
      </div>
      <div class="viz-card">
        <div class="viz-title">최근 유산소 운동시간 추세</div>
        <svg class="training-spark" viewBox="0 0 312 82" role="img" aria-label="최근 7일 유산소 운동시간 추세">
          <line class="spark-axis" x1="8" y1="62" x2="304" y2="62"></line>
          <polyline class="spark-line" points="${points}"></polyline>
          <g class="spark-points">${circles}</g>
          <g class="spark-labels">${labels}</g>
        </svg>
      </div>
    </div>`;
  };

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

    return `${sectionStatusHtml(ai.status)}${cards}${stages}
      <div class="analysis-copy"><p><strong>평가:</strong> ${escapeHtml(shortSummary(ai.summary || '회복 평가 자료가 충분하지 않습니다.', 2, 190))}</p></div>
      ${ai.evidence && ai.evidence.length ? `<h3>근거</h3>${compactList(ai.evidence.slice(0, 4))}` : ''}
      ${ai.limitations && ai.limitations.length ? `<h3>데이터 제한</h3>${compactList(ai.limitations.slice(0, 3))}` : ''}
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

    return `${sectionStatusHtml(ai.status)}
    <div class="nutrition-summary-head">
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
    <div class="analysis-copy"><p><strong>평가:</strong> ${escapeHtml(shortSummary(ai.summary || '영양 평가 자료가 충분하지 않습니다.', 2, 190))}</p></div>
    ${recommendationHtml(ai.nutrient_recommendations)}
    ${ai.evidence && ai.evidence.length ? `<h3>근거</h3>${compactList(ai.evidence.slice(0, 3))}` : ''}
    ${ai.limitations && ai.limitations.length ? `<h3>데이터 제한</h3>${compactList(ai.limitations.slice(0, 2))}` : ''}
    <p class="data-quality-note">불완전 기록일은 실제 하루 총섭취량으로 간주하지 않고 완전 기록일을 우선해 평가합니다. 보정치는 원본과 분리된 추정값입니다.</p>`;
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

    const trainingItems = (a.progress || []).concat(a.concerns || []).slice(0, 5);
    const trainingBody = `${trainingVisualHtml(stats, analysis.period?.to || analysis.created_at)}
      <div class="analysis-copy"><p><strong>평가:</strong> ${escapeHtml(shortSummary(a.summary || '', 2, 200))}</p></div>
      ${trainingItems.length ? `<h3>핵심 포인트</h3>${compactList(trainingItems)}` : ''}
      <p><strong>운동 균형:</strong> ${escapeHtml(shortSummary(a.training_balance || '자료 없음', 2, 170))}</p>`;

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
