/**
 * Workout Logger - Apps Script Security Layer
 *
 * 적용 방법
 * 1) 기존 Code.gs 상단의 HEALTH_FOLDER_ID / FITNESS_FOLDER_ID / STRENGTH_FOLDER_ID 3개 const를 삭제합니다.
 * 2) 기존 Code.gs의 doPost(e), doGet(e) 함수 2개를 삭제합니다.
 * 3) 이 파일 내용을 Code.gs 맨 위에 붙여넣습니다.
 * 4) 기존 나머지 함수(saveStrengthSession_, runAiAnalysis_ 등)는 그대로 둡니다.
 * 5) 프로젝트 설정 > 스크립트 속성에 아래 값을 등록합니다.
 *    HEALTH_FOLDER_ID, FITNESS_FOLDER_ID, STRENGTH_FOLDER_ID,
 *    OPENAI_API_KEY, OPENAI_MODEL, APP_PASSWORD
 * 6) 저장 후 웹 앱을 새 버전으로 재배포합니다.
 */

const SECURITY_PROPERTIES_ = PropertiesService.getScriptProperties();

const HEALTH_FOLDER_ID = SECURITY_PROPERTIES_.getProperty('HEALTH_FOLDER_ID') || '';
const FITNESS_FOLDER_ID = SECURITY_PROPERTIES_.getProperty('FITNESS_FOLDER_ID') || '';
const STRENGTH_FOLDER_ID = SECURITY_PROPERTIES_.getProperty('STRENGTH_FOLDER_ID') || '';

const AUTH_TOKEN_TTL_SECONDS_ = 180 * 24 * 60 * 60; // 180일
const LOGIN_MAX_FAILURES_ = 5;
const LOGIN_LOCK_SECONDS_ = 10 * 60; // 10분
const ANALYSIS_MIN_INTERVAL_SECONDS_ = 60;
const ANALYSIS_DAILY_LIMIT_ = 10;

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('전송된 데이터가 없습니다.');
    }

    const data = JSON.parse(e.postData.contents);
    const action = String(data && data.action || '');

    if (action === 'login') {
      return jsonResponse(login_(String(data.password || '')));
    }

    const auth = verifyAuthToken_(data && data.auth_token);
    if (!auth.ok) return jsonResponse(auth);

    if (action === 'auth_check') {
      return jsonResponse({
        ok: true,
        authenticated: true,
        expires_at: auth.expires_at
      });
    }

    if (action === 'list') {
      return jsonResponse(listStrengthSessions_());
    }

    if (action === 'latest_analysis') {
      return jsonResponse(getLatestAnalysisResponse_());
    }

    if (action === 'analyze') {
      const limit = consumeAnalysisQuota_();
      if (!limit.ok) return jsonResponse(limit);

      return jsonResponse(
        runAiAnalysis_(
          data.additional_request || '',
          data.force === true,
          data.analysis_from || '',
          data.analysis_from_manual === true
        )
      );
    }

    if (action === 'delete_strength') {
      return jsonResponse(deleteStrengthFile_(data.file_id));
    }

    // 기존 근력운동 저장 payload는 action 없이 exercises 배열을 전송합니다.
    if (data && Array.isArray(data.exercises)) {
      return jsonResponse(saveStrengthSession_(data));
    }

    return jsonResponse({
      ok: false,
      error_code: 'BAD_REQUEST',
      error: '지원하지 않는 요청입니다.'
    });

  } catch (error) {
    return jsonResponse({
      ok: false,
      error_code: 'SERVER_ERROR',
      error: String(error && error.message ? error.message : error)
    });
  }
}

/**
 * 민감 데이터는 GET으로 반환하지 않습니다.
 * 상태 확인만 허용합니다.
 */
function doGet(e) {
  return jsonResponse({
    ok: true,
    message: 'Workout Logger API is running.',
    authentication_required: true
  });
}

function login_(password) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    const props = PropertiesService.getScriptProperties();
    const configuredPassword = String(props.getProperty('APP_PASSWORD') || '').trim();

    if (!/^\d{6,12}$/.test(configuredPassword)) {
      return {
        ok: false,
        error_code: 'AUTH_NOT_CONFIGURED',
        error: 'APP_PASSWORD가 설정되지 않았거나 숫자 6~12자리 형식이 아닙니다.'
      };
    }

    const now = Date.now();
    const lockedUntil = Number(props.getProperty('AUTH_LOCKED_UNTIL') || 0);

    if (lockedUntil > now) {
      return {
        ok: false,
        error_code: 'LOGIN_LOCKED',
        error: '로그인 시도가 잠겨 있습니다.',
        retry_after_seconds: Math.ceil((lockedUntil - now) / 1000)
      };
    }

    if (!constantTimeEqual_(password, configuredPassword)) {
      const failures = Number(props.getProperty('AUTH_FAILURE_COUNT') || 0) + 1;

      if (failures >= LOGIN_MAX_FAILURES_) {
        props.setProperties({
          AUTH_FAILURE_COUNT: '0',
          AUTH_LOCKED_UNTIL: String(now + LOGIN_LOCK_SECONDS_ * 1000)
        }, false);

        return {
          ok: false,
          error_code: 'LOGIN_LOCKED',
          error: '비밀번호를 5회 잘못 입력하여 10분 동안 로그인이 잠겼습니다.',
          retry_after_seconds: LOGIN_LOCK_SECONDS_
        };
      }

      props.setProperty('AUTH_FAILURE_COUNT', String(failures));

      return {
        ok: false,
        error_code: 'INVALID_PASSWORD',
        error: '비밀번호가 올바르지 않습니다.',
        remaining_attempts: LOGIN_MAX_FAILURES_ - failures
      };
    }

    props.deleteProperty('AUTH_FAILURE_COUNT');
    props.deleteProperty('AUTH_LOCKED_UNTIL');

    const token = createAuthToken_();
    return {
      ok: true,
      auth_token: token.token,
      expires_at: new Date(token.expiresAt).toISOString()
    };

  } finally {
    lock.releaseLock();
  }
}

function createAuthToken_() {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const expiresAt = now + AUTH_TOKEN_TTL_SECONDS_ * 1000;

  const tokenId = Utilities.getUuid().replace(/-/g, '');
  const randomPart = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + '|' + now + '|' + Math.random()
    )
  ).replace(/=+$/g, '');

  const token = tokenId + '.' + randomPart;
  const tokenHash = sha256Hex_(token);

  cleanupExpiredTokens_();

  props.setProperty(
    'AUTH_TOKEN_' + tokenId,
    JSON.stringify({
      hash: tokenHash,
      created_at: now,
      expires_at: expiresAt
    })
  );

  return { token: token, expiresAt: expiresAt };
}

function verifyAuthToken_(token) {
  const raw = String(token || '').trim();

  if (!raw || raw.indexOf('.') < 1) {
    return unauthorized_('인증 토큰이 없습니다.');
  }

  const tokenId = raw.split('.')[0];
  if (!/^[a-fA-F0-9]{32}$/.test(tokenId)) {
    return unauthorized_('인증 토큰 형식이 올바르지 않습니다.');
  }

  const props = PropertiesService.getScriptProperties();
  const key = 'AUTH_TOKEN_' + tokenId;
  const storedRaw = props.getProperty(key);

  if (!storedRaw) {
    return unauthorized_('유효하지 않은 인증 토큰입니다.');
  }

  let stored;
  try {
    stored = JSON.parse(storedRaw);
  } catch (_) {
    props.deleteProperty(key);
    return unauthorized_('손상된 인증 토큰입니다.');
  }

  const now = Date.now();
  if (!stored.expires_at || Number(stored.expires_at) <= now) {
    props.deleteProperty(key);
    return unauthorized_('인증 토큰이 만료되었습니다.');
  }

  if (!constantTimeEqual_(sha256Hex_(raw), String(stored.hash || ''))) {
    return unauthorized_('유효하지 않은 인증 토큰입니다.');
  }

  return {
    ok: true,
    authenticated: true,
    expires_at: new Date(Number(stored.expires_at)).toISOString()
  };
}

function unauthorized_(message) {
  return {
    ok: false,
    error_code: 'UNAUTHORIZED',
    error: 'UNAUTHORIZED',
    message: message || '인증이 필요합니다.'
  };
}

function cleanupExpiredTokens_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();

  Object.keys(all).forEach(function(key) {
    if (key.indexOf('AUTH_TOKEN_') !== 0) return;

    try {
      const item = JSON.parse(all[key]);
      if (!item.expires_at || Number(item.expires_at) <= now) {
        props.deleteProperty(key);
      }
    } catch (_) {
      props.deleteProperty(key);
    }
  });
}

function consumeAnalysisQuota_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  try {
    const props = PropertiesService.getScriptProperties();
    const now = Date.now();
    const last = Number(props.getProperty('AI_LAST_REQUEST_AT') || 0);

    if (last && now - last < ANALYSIS_MIN_INTERVAL_SECONDS_ * 1000) {
      return {
        ok: false,
        error_code: 'AI_RATE_LIMIT',
        error: 'AI 분석은 최소 60초 간격으로 실행할 수 있습니다.',
        retry_after_seconds: Math.ceil(
          (ANALYSIS_MIN_INTERVAL_SECONDS_ * 1000 - (now - last)) / 1000
        )
      };
    }

    const day = Utilities.formatDate(new Date(now), 'Asia/Seoul', 'yyyy-MM-dd');
    const savedDay = props.getProperty('AI_DAILY_LIMIT_DATE') || '';
    let count = savedDay === day
      ? Number(props.getProperty('AI_DAILY_COUNT') || 0)
      : 0;

    if (count >= ANALYSIS_DAILY_LIMIT_) {
      return {
        ok: false,
        error_code: 'AI_DAILY_LIMIT',
        error: '오늘의 AI 분석 허용 횟수(10회)를 모두 사용했습니다.'
      };
    }

    count += 1;
    props.setProperties({
      AI_LAST_REQUEST_AT: String(now),
      AI_DAILY_LIMIT_DATE: day,
      AI_DAILY_COUNT: String(count)
    }, false);

    return {
      ok: true,
      daily_count: count,
      daily_remaining: ANALYSIS_DAILY_LIMIT_ - count
    };

  } finally {
    lock.releaseLock();
  }
}

function sha256Hex_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value || ''),
    Utilities.Charset.UTF_8
  );

  return bytes.map(function(b) {
    const v = (b + 256) % 256;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function constantTimeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');

  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);

  for (let i = 0; i < max; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }

  return diff === 0;
}

/**
 * 필요할 때 Apps Script 편집기에서 직접 실행하면
 * 현재 발급된 모든 기기 인증 토큰을 즉시 무효화합니다.
 */
function revokeAllAuthTokens() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  Object.keys(all).forEach(function(key) {
    if (key.indexOf('AUTH_TOKEN_') === 0) {
      props.deleteProperty(key);
    }
  });

  console.log('모든 Workout Logger 인증 토큰을 무효화했습니다.');
}

const TIME_ZONE = 'Asia/Seoul';
const INITIAL_LOOKBACK_DAYS = 28;
const OVERLAP_DAYS = 1;
const ANALYSIS_FOLDER_NAME = 'Analysis';
const BASELINE_FOLDER_NAME = 'Baseline';

function saveStrengthSession_(data) {
  const folder = DriveApp.getFolderById(STRENGTH_FOLDER_ID);
  const now = new Date();
  const workoutDate = parseDate_(data.finished_at || data.started_at || data.workout_date || now);
  const safeDate = workoutDate.getTime() > 0 ? workoutDate : now;
  const yearMonth = Utilities.formatDate(safeDate,TIME_ZONE,'yyyy-MM');
  const timestamp = Utilities.formatDate(safeDate,TIME_ZONE,'yyyy-MM-dd_HHmmss');
  const monthFolder = getOrCreateFolder_(folder,yearMonth);
  let suffix = '';
  if (data.session_id) {
    const safe = String(data.session_id).replace(/[^a-zA-Z0-9_-]/g,'').substring(0,12);
    if (safe) suffix = '-' + safe;
  }
  const fileName = `strength-${timestamp}${suffix}.json`;
  monthFolder.createFile(fileName,JSON.stringify(data,null,2),MimeType.PLAIN_TEXT);
  return {ok:true,fileName:fileName};
}

function listStrengthSessions_() {
  const sessions=[];
  collectStrengthRecords_(DriveApp.getFolderById(STRENGTH_FOLDER_ID),sessions);
  sessions.sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b));
  return {ok:true,count:sessions.length,sessions:sessions.slice(-300)};
}

function runAiAnalysis_(additionalRequest, force, analysisFromInput, analysisFromManual) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('다른 AI 분석이 진행 중입니다. 잠시 후 다시 시도하세요.');
  try {
    const now = new Date();
    const latest = findLatestAnalysis_();
    const recentSevenDayFrom = startOfDay_(addDays_(now,-6));
    const previousAnalysisTime = latest
      ? parseDate_(latest.period && latest.period.to || latest.created_at)
      : recentSevenDayFrom;
    const incrementalReadFrom = latest
      ? addDays_(previousAnalysisTime,-OVERLAP_DAYS)
      : addDays_(now,-INITIAL_LOOKBACK_DAYS);
    const defaultPeriodFrom = latest ? startOfDay_(addDays_(previousAnalysisTime,-OVERLAP_DAYS)) : recentSevenDayFrom;
    const requestedPeriodFrom = normalizeAnalysisFrom_(analysisFromInput, defaultPeriodFrom, now);
    const periodFrom = requestedPeriodFrom;
    const analysisFrom = requestedPeriodFrom < incrementalReadFrom ? requestedPeriodFrom : incrementalReadFrom;

    const health = collectJsonFiles_(DriveApp.getFolderById(HEALTH_FOLDER_ID), analysisFrom, now, 'health');
    const fitness = collectJsonFiles_(DriveApp.getFolderById(FITNESS_FOLDER_ID), analysisFrom, now, 'fitness');
    const strength = collectJsonFiles_(DriveApp.getFolderById(STRENGTH_FOLDER_ID), analysisFrom, now, 'strength');

    const newestDataTime = newestTimestamp_(health.concat(fitness).concat(strength));
    if (!force && !analysisFromManual && latest && newestDataTime && newestDataTime <= parseDate_(latest.period && latest.period.to || latest.created_at).getTime() && !String(additionalRequest||'').trim()) {
      return {ok:true,unchanged:true,message:'마지막 분석 이후 새로운 기록이 없습니다.',analysis:latest};
    }

    const stats = buildStatistics_(health,fitness,strength,periodFrom,now);
    const activityComparison = buildActivityComparison_(stats, latest);
    const previousPlan = latest ? (latest.next_plan || null) : null;
    const baseline = getBaselineSummary_();
    const ai = callOpenAI_(stats,latest,previousPlan,String(additionalRequest||'').trim(),baseline);

    const createdAt = formatIso_(now);
    const analysis = {
      schema_version:1,
      analysis_id:'analysis-' + Utilities.formatDate(now,TIME_ZONE,'yyyy-MM-dd_HHmmss'),
      created_at:createdAt,
      analysis_mode:latest?'incremental':'initial',
      previous_analysis_id:latest ? latest.analysis_id || null : null,
      user_goal:'weight_loss',
      additional_request:String(additionalRequest||'').trim(),
      period:{from:formatIso_(periodFrom),to:createdAt,data_read_from:formatIso_(analysisFrom),requested_from:String(analysisFromInput||'').trim()||null},
      data_sources:{health_files:health.length,fitness_files:fitness.length,strength_files:strength.length},
      statistics:stats,
      activity_comparison:activityComparison,
      baseline:baseline,
      previous_plan_review:ai.previous_plan_review,
      ai_analysis:ai.ai_analysis,
      weight_loss_analysis:ai.weight_loss_analysis,
      next_plan:ai.next_plan,
      warnings:ai.warnings,
      model:getOpenAiModel_(),
      prompt_version:'2.1'
    };
    saveAnalysis_(analysis);
    return {ok:true,unchanged:false,analysis:analysis};
  } finally {
    lock.releaseLock();
  }
}

function buildStatistics_(healthFiles,fitnessFiles,strengthFiles,periodFrom,periodTo) {
  const metrics={};
  healthFiles.forEach(x=>{
    const arr=x.data && x.data.data && x.data.data.metrics || [];
    arr.forEach(m=>{
      const name=m.name; if(!name)return;
      if(!metrics[name]) metrics[name]=[];
      (m.data||[]).forEach(v=>{
        const t=parseDate_(v.date); if(t>=periodFrom&&t<=periodTo&&isFinite(Number(v.qty))) metrics[name].push({t:t.getTime(),qty:Number(v.qty),units:m.units||''});
      });
    });
  });

  const daily = {};
  Object.keys(metrics).forEach(name=>metrics[name].forEach(v=>{
    const day=Utilities.formatDate(new Date(v.t),TIME_ZONE,'yyyy-MM-dd');
    if(!daily[day])daily[day]={};
    if(!daily[day][name])daily[day][name]=[];
    daily[day][name].push(v.qty);
  }));
  const days=Object.keys(daily).sort();
  const sumMetric=(name)=>round_(days.reduce((s,d)=>s+sum_(daily[d][name]||[]),0),2);
  const dailySums=(name)=>days.map(d=>sum_(daily[d][name]||[]));
  const dailyAvgs=(name)=>days.map(d=>avg_(daily[d][name]||[])).filter(v=>v!==null);
  const latestMetric=(name)=>{
    const a=(metrics[name]||[]).slice().sort((a,b)=>a.t-b.t); return a.length?round_(a[a.length-1].qty,2):null;
  };
  const firstMetric=(name)=>{
    const a=(metrics[name]||[]).slice().sort((a,b)=>a.t-b.t); return a.length?round_(a[0].qty,2):null;
  };
  const metricDailyAvg=(day,name)=>round_(avg_(daily[day]&&daily[day][name]||[]),2);
  const metricDailySum=(day,name)=>round_(sum_(daily[day]&&daily[day][name]||[]),2);
  const normalizePercent=(v)=>v!==null&&v!==undefined&&isFinite(Number(v))&&Number(v)>0&&Number(v)<=1?round_(Number(v)*100,1):v;
  const median_=(values)=>{
    const a=(values||[]).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number).sort((a,b)=>a-b);
    if(!a.length)return null;
    const mid=Math.floor(a.length/2);
    return a.length%2?a[mid]:(a[mid-1]+a[mid])/2;
  };
  const effortClass_=(met)=>{
    const n=Number(met);
    if(!isFinite(n))return null;
    if(n<3)return 'light';
    if(n<6)return 'moderate';
    return 'vigorous';
  };
  const periodDays=[];
  const cursor=startOfDay_(periodFrom);
  const endDay=startOfDay_(periodTo);
  while(cursor<=endDay){
    periodDays.push(Utilities.formatDate(cursor,TIME_ZONE,'yyyy-MM-dd'));
    cursor.setDate(cursor.getDate()+1);
  }
  const weeklyBodySeries=periodDays.map(d=>({
    date:d,
    weight_kg:metricDailyAvg(d,'weight_body_mass'),
    body_fat_pct:normalizePercent(metricDailyAvg(d,'body_fat_percentage')),
    bmi:metricDailyAvg(d,'body_mass_index')
  }));
  const movingAverageSeries=(series,key,outKey,windowDays)=>series.map((row,idx)=>{
    const start=Math.max(0,idx-windowDays+1);
    const values=series.slice(start,idx+1)
      .map(x=>x[key])
      .filter(v=>v!==null&&v!==undefined&&isFinite(Number(v)))
      .map(Number);
    const out={date:row.date};
    out[outKey]=values.length?round_(avg_(values),2):null;
    out[outKey+'_sample_count']=values.length;
    return out;
  });
  const firstNonNullInSeries=(series,key)=>{
    for(let i=0;i<series.length;i++){
      const v=series[i]&&series[i][key];
      if(v!==null&&v!==undefined&&isFinite(Number(v)))return Number(v);
    }
    return null;
  };
  const lastNonNullInSeries=(series,key)=>{
    for(let i=series.length-1;i>=0;i--){
      const v=series[i]&&series[i][key];
      if(v!==null&&v!==undefined&&isFinite(Number(v)))return Number(v);
    }
    return null;
  };
  const weightMa7=movingAverageSeries(weeklyBodySeries,'weight_kg','weight_kg_ma7',7);
  const bodyFatMa7=movingAverageSeries(weeklyBodySeries,'body_fat_pct','body_fat_pct_ma7',7);
  const bmiMa7=movingAverageSeries(weeklyBodySeries,'bmi','bmi_ma7',7);
  const bodyTrendSeries=weeklyBodySeries.map((row,idx)=>Object.assign({},row,weightMa7[idx],bodyFatMa7[idx],bmiMa7[idx]));
  const weightMaFirst=firstNonNullInSeries(bodyTrendSeries,'weight_kg_ma7');
  const weightMaLatest=lastNonNullInSeries(bodyTrendSeries,'weight_kg_ma7');
  const bodyFatMaLatest=lastNonNullInSeries(bodyTrendSeries,'body_fat_pct_ma7');
  const bmiMaLatest=lastNonNullInSeries(bodyTrendSeries,'bmi_ma7');
  const weeklyWaistSeries=periodDays.map(d=>({
    date:d,
    waist_cm:metricDailyAvg(d,'waist_circumference')
  }));
  const dailyActivitySeries=periodDays.map(d=>({
    date:d,
    steps:round_(metricDailySum(d,'step_count'),0),
    walking_running_distance_km:metricDailySum(d,'walking_running_distance'),
    active_kcal:round_(metricDailySum(d,'active_energy')/4.184,1),
    exercise_minutes:metricDailySum(d,'apple_exercise_time')
  }));
  const physicalEffortSamples=(metrics.physical_effort||[]).slice().sort((a,b)=>a.t-b.t);
  const physicalEffortValues=physicalEffortSamples.map(v=>Number(v.qty)).filter(v=>isFinite(v));
  const physicalEffortDailySeries=periodDays.map(d=>{
    const values=(daily[d]&&daily[d].physical_effort||[]).filter(v=>isFinite(Number(v))).map(Number);
    return {
      date:d,
      sample_count:values.length,
      avg_met:values.length?round_(avg_(values),2):null,
      median_met:values.length?round_(median_(values),2):null,
      max_met:values.length?round_(Math.max.apply(null,values),2):null
    };
  });
  const physicalEffortSummary={
    source:'Health metric physical_effort',
    units:'kcal/hr·kg (MET-equivalent)',
    interpretation_note:'Apple Health Physical Effort is used as an estimated absolute intensity signal. Prefer within-user trend and workout-level comparison over treating a single MET value as exact.',
    sample_count:physicalEffortValues.length,
    average_met:physicalEffortValues.length?round_(avg_(physicalEffortValues),2):null,
    median_met:physicalEffortValues.length?round_(median_(physicalEffortValues),2):null,
    max_met:physicalEffortValues.length?round_(Math.max.apply(null,physicalEffortValues),2):null,
    light_sample_count:physicalEffortValues.filter(v=>v<3).length,
    moderate_sample_count:physicalEffortValues.filter(v=>v>=3&&v<6).length,
    vigorous_sample_count:physicalEffortValues.filter(v=>v>=6).length,
    daily_series:physicalEffortDailySeries
  };
  const workoutDistanceKm=(w)=>{
    const distance=w.distance||w.totalDistance||w.walkingRunningDistance||w.walkingAndRunningDistance||w.total_distance;
    const qty=distance&&isFinite(Number(distance.qty))?Number(distance.qty):0;
    if(!qty)return null;
    const unit=String(distance.units||distance.unit||'').toLowerCase();
    if(unit==='m'||unit==='meter'||unit==='meters')return qty/1000;
    return qty;
  };
  const workoutCadence=(w)=>num_(w.stepCadence&&w.stepCadence.qty||w.cadence&&w.cadence.qty||w.avgCadence&&w.avgCadence.qty);
  const workoutIntensityMet=(w)=>{
    const value=w&&w.intensity;
    if(value===null||value===undefined)return null;
    if(typeof value==='number')return isFinite(value)?round_(value,2):null;
    if(typeof value==='object'){
      const candidates=[value.qty,value.value,value.avg,value.Avg,value.average];
      for(let i=0;i<candidates.length;i++){
        const n=Number(candidates[i]);
        if(isFinite(n))return round_(n,2);
      }
    }
    const n=Number(value);
    return isFinite(n)?round_(n,2):null;
  };
  const physicalEffortInWindow=(startMs,endMs)=>{
    const values=physicalEffortSamples.filter(v=>v.t>=startMs&&v.t<=endMs).map(v=>Number(v.qty)).filter(v=>isFinite(v));
    if(!values.length)return {sample_count:0,avg_met:null,median_met:null,max_met:null,light_samples:0,moderate_samples:0,vigorous_samples:0};
    return {
      sample_count:values.length,
      avg_met:round_(avg_(values),2),
      median_met:round_(median_(values),2),
      max_met:round_(Math.max.apply(null,values),2),
      light_samples:values.filter(v=>v<3).length,
      moderate_samples:values.filter(v=>v>=3&&v<6).length,
      vigorous_samples:values.filter(v=>v>=6).length
    };
  };
  const isWalkRunWorkout=(w,distanceKm,paceMinPerKm,cadenceSpm)=>{
    const name=String(w&&w.name||'');
    if(/\uC790\uC804\uAC70|\uC0AC\uC774\uD074|bike|cycle|cycling/i.test(name))return false;
    if(/\uAC77|\uB2EC\uB9AC|\uB7EC\uB2DD|\uB7F0\uB2DD|walk|run/i.test(name))return true;
    return Number(distanceKm)>0&&Number(paceMinPerKm)>0&&Number(cadenceSpm)>0;
  };
  const routePoints=(w)=>{
    const r=w&&((Array.isArray(w.route)&&w.route)||(Array.isArray(w.routes)&&w.routes)||(Array.isArray(w.locations)&&w.locations)||(w.route&&Array.isArray(w.route.data)&&w.route.data));
    return Array.isArray(r)?r:[];
  };
  const routeCoord=(p,key1,key2)=>{
    if(!p)return null;
    const v=p[key1]!==undefined?p[key1]:(p.coordinate&&p.coordinate[key2]);
    const n=Number(v);
    return isFinite(n)?n:null;
  };
  const routeSignature=(w,distanceKm)=>{
    const points=routePoints(w).filter(p=>routeCoord(p,'latitude','latitude')!==null&&routeCoord(p,'longitude','longitude')!==null);
    if(points.length<2)return null;
    const first=points[0],last=points[points.length-1];
    const a=[routeCoord(first,'latitude','latitude').toFixed(3),routeCoord(first,'longitude','longitude').toFixed(3)].join(',');
    const b=[routeCoord(last,'latitude','latitude').toFixed(3),routeCoord(last,'longitude','longitude').toFixed(3)].join(',');
    const endpoints=[a,b].sort().join('|');
    const distanceBucket=distanceKm?Math.round(Number(distanceKm)*2)/2:0;
    return endpoints+'|'+distanceBucket;
  };

  const cardioDisplayName=(w,distanceKm,paceMinPerKm,cadenceSpm,isWalkRun)=>{
    const name=String(w&&w.name||'');
    if(!isWalkRun)return name||'\uC6B4\uB3D9';
    const genericIndoor=/^\s*(\uC2E4\uB0B4\s*\uC6B4\uB3D9|Indoor\s+Workout)\s*$/i.test(name);
    if(!genericIndoor)return name||'\uC6B4\uB3D9';
    if(Number(distanceKm)>0&&Number(paceMinPerKm)>0&&Number(cadenceSpm)>0){
      return Number(paceMinPerKm)<=10||Number(cadenceSpm)>=120?'\uC2E4\uB0B4 \uB2EC\uB9AC\uAE30':'\uC2E4\uB0B4 \uAC77\uAE30';
    }
    return name||'\uC6B4\uB3D9';
  };

  const metricSeries=(box)=>{
    const raw=Array.isArray(box)?box:(box&&Array.isArray(box.data)?box.data:[]);
    return raw.map(v=>{
      const t=parseDate_(v.date);
      const qty=Number(v.qty);
      return {t:t.getTime(),qty:qty,units:String(v.units||v.unit||box&&box.units||box&&box.unit||'')};
    }).filter(v=>v.t>0&&isFinite(v.qty)).sort((a,b)=>a.t-b.t);
  };
  const workoutSeries=(w,keys)=>{
    for(let i=0;i<keys.length;i++){
      const s=metricSeries(w&&w[keys[i]]);
      if(s.length)return s;
    }
    return [];
  };
  const seriesQtyAsKm=(v)=>{
    if(!v||!isFinite(Number(v.qty)))return 0;
    const unit=String(v.units||'').toLowerCase();
    if(unit==='m'||unit==='meter'||unit==='meters')return Number(v.qty)/1000;
    return Number(v.qty);
  };
  const avgSeriesInWindow=(series,startMs,endMs)=>{
    const values=series.filter(v=>v.t>=startMs&&v.t<=endMs).map(v=>Number(v.qty)).filter(v=>isFinite(v));
    return values.length?round_(avg_(values),1):null;
  };
  const zoneForHr=(hr)=>{
    if(!isFinite(Number(hr)))return null;
    const n=Number(hr);
    if(n<137)return 'zone1';
    if(n<=147)return 'zone2';
    if(n<=158)return 'zone3';
    if(n<=169)return 'zone4';
    return 'zone5';
  };
  const buildHeartRateZones=(hrSeries,startMs,endMs)=>{
    const zones={zone1_seconds:0,zone2_seconds:0,zone3_seconds:0,zone4_seconds:0,zone5_seconds:0};
    if(!hrSeries.length)return zones;
    for(let i=0;i<hrSeries.length;i++){
      const current=hrSeries[i];
      if(current.t<startMs||current.t>endMs)continue;
      const next=hrSeries[i+1];
      const nextT=next?Math.min(next.t,endMs):Math.min(current.t+60000,endMs);
      const seconds=Math.max(0,(nextT-current.t)/1000);
      const zone=zoneForHr(current.qty);
      if(zone)zones[zone+'_seconds']+=seconds;
    }
    Object.keys(zones).forEach(k=>zones[k]=round_(zones[k],0));
    return zones;
  };
  const buildHeartRateRecovery=(series)=>{
    if(!series.length)return null;
    const first=series[0];
    const nearest=(targetMs)=>{
      let best=null;
      series.forEach(v=>{
        if(!best||Math.abs(v.t-targetMs)<Math.abs(best.t-targetMs))best=v;
      });
      return best&&Math.abs(best.t-targetMs)<=45000?round_(best.qty,0):null;
    };
    const one=nearest(first.t+60000);
    const two=nearest(first.t+120000);
    return {
      start_hr:round_(first.qty,0),
      one_min_hr:one,
      two_min_hr:two,
      one_min_drop:one!==null?round_(first.qty-one,0):null,
      two_min_drop:two!==null?round_(first.qty-two,0):null
    };
  };
  const buildSplitSummary=(distanceSeries,hrSeries,cadenceSeries,startMs,durationMin,totalDistanceKm)=>{
    if(!distanceSeries.length||!Number(totalDistanceKm))return [];
    const splits=[];
    let acc=0;
    let splitStartMs=startMs;
    let target=1;
    distanceSeries.forEach(v=>{
      const km=seriesQtyAsKm(v);
      if(km<=0)return;
      const before=acc;
      acc+=km;
      while(target<=acc&&splits.length<8){
        const ratio=km>0?(target-before)/km:1;
        const splitEndMs=v.t;
        const seconds=Math.max(0,(splitEndMs-splitStartMs)/1000);
        const avgHr=avgSeriesInWindow(hrSeries,splitStartMs,splitEndMs);
        const avgCadence=avgSeriesInWindow(cadenceSeries,splitStartMs,splitEndMs);
        splits.push({
          km:target,
          duration_seconds:round_(seconds,0),
          pace_min_per_km:seconds>0?round_(seconds/60,2):null,
          avg_hr:avgHr,
          avg_cadence_spm:avgCadence,
          confidence:ratio>=0&&ratio<=1?'minute_estimate':'low'
        });
        splitStartMs=splitEndMs;
        target++;
      }
    });
    const remaining=round_(Number(totalDistanceKm||0)-Math.floor(Number(totalDistanceKm||0)),2);
    if(remaining>=0.2&&splits.length<8){
      const endMs=startMs+Number(durationMin||0)*60000;
      const seconds=Math.max(0,(endMs-splitStartMs)/1000);
      splits.push({
        km:round_(Math.floor(Number(totalDistanceKm))+remaining,2),
        duration_seconds:round_(seconds,0),
        pace_min_per_km:seconds>0?round_((seconds/60)/remaining,2):null,
        avg_hr:avgSeriesInWindow(hrSeries,splitStartMs,endMs),
        avg_cadence_spm:avgSeriesInWindow(cadenceSeries,splitStartMs,endMs),
        confidence:'partial_minute_estimate'
      });
    }
    return splits;
  };
  const buildCardioQualityDetail=(w,start,durationMin,distanceKm)=>{
    const startMs=start.getTime();
    const endMs=startMs+Number(durationMin||0)*60000;
    const hrSeries=workoutSeries(w,['heartRateData','heart_rate_data','heartRate']);
    const cadenceSeries=workoutSeries(w,['stepCadence','cadence','avgCadence']);
    const distanceSeries=workoutSeries(w,['walkingAndRunningDistance','walkingRunningDistance','distance']);
    const recoverySeries=workoutSeries(w,['heartRateRecovery','heart_rate_recovery']);
    const splits=buildSplitSummary(distanceSeries,hrSeries,cadenceSeries,startMs,durationMin,distanceKm);
    const firstHr=hrSeries.length?hrSeries[0].t:null;
    return {
      granularity:'minute_level_estimate',
      note:'Derived from Health Auto Export workout metric series. Values can differ from Apple Fitness second-level calculations.',
      heart_rate_data_starts_after_seconds:firstHr?round_((firstHr-startMs)/1000,0):null,
      splits_1km:splits,
      heart_rate_zones:buildHeartRateZones(hrSeries,startMs,endMs),
      heart_rate_recovery:buildHeartRateRecovery(recoverySeries),
      available_series:{
        distance_points:distanceSeries.length,
        heart_rate_points:hrSeries.length,
        cadence_points:cadenceSeries.length,
        recovery_points:recoverySeries.length
      }
    };
  };

  const workouts=[];
  const workoutIds={};
  fitnessFiles.forEach(x=>((x.data&&x.data.data&&x.data.data.workouts)||[]).forEach(w=>{
    const start=parseDate_(w.start); if(start<periodFrom||start>periodTo)return;
    const key=w.id||[w.start,w.end,w.name].join('|'); if(workoutIds[key])return; workoutIds[key]=true;
    const durationMin=Number(w.duration||0)/60;
    const activeKj=Number(w.activeEnergyBurned&&w.activeEnergyBurned.qty||0);
    const distanceKm=workoutDistanceKm(w);
    const paceMinPerKm=distanceKm?round_(durationMin/distanceKm,2):null;
    const cadenceSpm=workoutCadence(w);
    const isWalkRun=isWalkRunWorkout(w,distanceKm,paceMinPerKm,cadenceSpm);
    const gpsRouteSignature=routeSignature(w,distanceKm);
    const cardioQuality=isWalkRun?buildCardioQualityDetail(w,start,durationMin,distanceKm):null;
    const intensityMet=workoutIntensityMet(w);
    const effortWindow=physicalEffortInWindow(start.getTime(),start.getTime()+durationMin*60000);
    workouts.push({
      name:cardioDisplayName(w,distanceKm,paceMinPerKm,cadenceSpm,isWalkRun),
      original_name:w.name||'\uC6B4\uB3D9',
      start:formatIso_(start),
      duration_min:round_(durationMin,1),
      active_kcal:round_(activeKj/4.184,1),
      avg_hr:num_(w.avgHeartRate&&w.avgHeartRate.qty||w.heartRate&&w.heartRate.avg&&w.heartRate.avg.qty),
      max_hr:num_(w.maxHeartRate&&w.maxHeartRate.qty||w.heartRate&&w.heartRate.max&&w.heartRate.max.qty),
      distance_km:round_(distanceKm,2),
      pace_min_per_km:paceMinPerKm,
      cadence_spm:cadenceSpm,
      intensity_met:intensityMet,
      intensity_class:effortClass_(intensityMet),
      physical_effort:effortWindow,
      has_gps_route:!!gpsRouteSignature,
      route_signature:gpsRouteSignature,
      is_walk_run:isWalkRun,
      cardio_quality_detail:cardioQuality
    });
  }));
  const routeCounts={};
  workouts.forEach(w=>{if(w.is_walk_run&&w.route_signature)routeCounts[w.route_signature]=(routeCounts[w.route_signature]||0)+1;});
  workouts.forEach(w=>{
    w.is_commute_like=!!(w.route_signature&&routeCounts[w.route_signature]>1);
    w.is_slow_outdoor_walk=!!(w.has_gps_route&&Number(w.pace_min_per_km)>=15);
    w.cardio_exclusion_reason=w.is_commute_like?'repeated_gps_route':(w.is_slow_outdoor_walk?'slow_outdoor_walk':null);
  });
  const cardioWorkouts=workouts.filter(w=>w.is_walk_run&&!w.cardio_exclusion_reason);
  const recentCardioWorkouts=cardioWorkouts.slice()
    .sort((a,b)=>parseDate_(a.start).getTime()-parseDate_(b.start).getTime())
    .slice(-5);
  const cardioDistance=sum_(cardioWorkouts.map(w=>w.distance_km||0));
  const cardioMinutes=sum_(cardioWorkouts.map(w=>w.duration_min||0));
  const cardioKcal=sum_(cardioWorkouts.map(w=>w.active_kcal||0));
  const cardioHrWeighted=sum_(cardioWorkouts.map(w=>(w.avg_hr||0)*(w.duration_min||0)));
  const cardioIntensityValues=cardioWorkouts.map(w=>w.intensity_met).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number);
  const cardioEffortAvgValues=cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.avg_met).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number);
  const cardioSummary={
    session_count:cardioWorkouts.length,
    total_minutes:round_(cardioMinutes,1),
    distance_km:round_(cardioDistance,2),
    avg_pace_min_per_km:cardioDistance?round_(cardioMinutes/cardioDistance,2):null,
    avg_hr:cardioMinutes?round_(cardioHrWeighted/cardioMinutes,1):null,
    active_kcal:round_(cardioKcal,1),
    avg_workout_intensity_met:cardioIntensityValues.length?round_(avg_(cardioIntensityValues),2):null,
    max_workout_intensity_met:cardioIntensityValues.length?round_(Math.max.apply(null,cardioIntensityValues),2):null,
    avg_physical_effort_met:cardioEffortAvgValues.length?round_(avg_(cardioEffortAvgValues),2):null,
    quality_detail_note:'Cardio sessions in the selected analysis period include minute-level estimated splits, heart-rate zones, cadence, recovery, workout intensity MET, and Health Physical Effort when available.',
    quality_sessions:cardioWorkouts.map(w=>({
      name:w.name,
      start:w.start,
      distance_km:w.distance_km,
      pace_min_per_km:w.pace_min_per_km,
      avg_hr:w.avg_hr,
      cadence_spm:w.cadence_spm,
      active_kcal:w.active_kcal,
      intensity_met:w.intensity_met,
      intensity_class:w.intensity_class,
      physical_effort:w.physical_effort,
      cardio_quality_detail:w.cardio_quality_detail
    }))
  };
  const excludedCardioWorkouts=workouts
    .filter(w=>w.is_walk_run&&w.cardio_exclusion_reason)
    .map(w=>({
      name:w.name,
      start:w.start,
      distance_km:w.distance_km,
      pace_min_per_km:w.pace_min_per_km,
      reason:w.cardio_exclusion_reason
    }));

  const strengthSessions=[];
  const strengthSeen={};
  strengthFiles.forEach(x=>{
    const s=x.data; if(!s||!Array.isArray(s.exercises))return;
    const t=parseDate_(s.finished_at||s.started_at||x.modified_at); if(t<periodFrom||t>periodTo)return;
    const key=s.session_id||[s.started_at,s.finished_at,JSON.stringify(s.exercises)].join('|'); if(strengthSeen[key])return; strengthSeen[key]=true;
    strengthSessions.push(s);
  });
  const byExercise={}; const pain=[]; let totalSets=0,totalReps=0,totalVolume=0,totalTimedSeconds=0;
  strengthSessions.forEach(s=>(s.exercises||[]).forEach(ex=>{
    const name=String(ex.exercise||'unknown');
    if(!byExercise[name])byExercise[name]={sessions:0,sets:0,reps:0,volume_kg:0,timed_seconds:0,last_weight_kg:null,last_recorded_at:null,rpe_values:[]};
    const a=byExercise[name]; a.sessions++; a.sets+=Number(ex.sets||0); a.reps+=Number(ex.reps||0)*Number(ex.sets||0); a.volume_kg+=Number(ex.weight_kg||0)*Number(ex.reps||0)*Number(ex.sets||0); a.timed_seconds+=Number(ex.seconds||0)*Number(ex.sets||0);
    if(Number(ex.weight_kg||0)>0)a.last_weight_kg=Number(ex.weight_kg); a.last_recorded_at=ex.recorded_at||s.finished_at||s.started_at;
    if(ex.rpe!==null&&ex.rpe!==undefined&&isFinite(Number(ex.rpe)))a.rpe_values.push(Number(ex.rpe));
    totalSets+=Number(ex.sets||0); totalReps+=Number(ex.reps||0)*Number(ex.sets||0); totalVolume+=Number(ex.weight_kg||0)*Number(ex.reps||0)*Number(ex.sets||0); totalTimedSeconds+=Number(ex.seconds||0)*Number(ex.sets||0);
    if(Number(ex.pain_level||0)>0)pain.push({date:ex.recorded_at||s.finished_at||s.started_at,exercise:name,level:Number(ex.pain_level),area:ex.pain_area||'unknown',memo:ex.memo||''});
  }));
  Object.keys(byExercise).forEach(k=>{const a=byExercise[k];a.volume_kg=round_(a.volume_kg,1);a.avg_rpe=a.rpe_values.length?round_(avg_(a.rpe_values),1):null;delete a.rpe_values;});
  const strengthDailySessions=strengthSessions.slice()
    .sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b))
    .map(s=>{
      const t=parseDate_(s.finished_at||s.started_at||s.date||s.created_at);
      const exercises=(s.exercises||[]).map(ex=>{
        const sets=Number(ex.sets||0);
        const reps=Number(ex.reps||0);
        const weight=Number(ex.weight_kg||0);
        const seconds=Number(ex.seconds||0);
        return {
          exercise:String(ex.exercise||'unknown'),
          type:ex.record_type||ex.type||'',
          weight_kg:weight||0,
          reps:reps||0,
          sets:sets||0,
          seconds:seconds||0,
          volume_kg:round_(weight*reps*sets,1),
          total_reps:round_(reps*sets,0),
          rpe:ex.rpe!==null&&ex.rpe!==undefined&&isFinite(Number(ex.rpe))?Number(ex.rpe):null,
          pain_level:ex.pain_level!==null&&ex.pain_level!==undefined&&isFinite(Number(ex.pain_level))?Number(ex.pain_level):0,
          pain_area:ex.pain_area||'',
          memo:ex.memo||''
        };
      });
      const rpes=exercises.map(ex=>ex.rpe).filter(v=>v!==null);
      return {
        date:Utilities.formatDate(t,TIME_ZONE,'yyyy-MM-dd'),
        started_at:s.started_at||null,
        finished_at:s.finished_at||null,
        exercise_count:exercises.length,
        total_sets:round_(sum_(exercises.map(ex=>ex.sets)),0),
        total_reps:round_(sum_(exercises.map(ex=>ex.total_reps)),0),
        total_volume_kg:round_(sum_(exercises.map(ex=>ex.volume_kg)),1),
        timed_seconds:round_(sum_(exercises.map(ex=>ex.seconds*ex.sets)),0),
        avg_rpe:rpes.length?round_(avg_(rpes),1):null,
        max_pain_level:exercises.length?Math.max.apply(null,exercises.map(ex=>ex.pain_level||0)):0,
        exercises:exercises
      };
    });

  const weightLatest=latestMetric('weight_body_mass');
  const weightFirst=firstMetric('weight_body_mass');
  const waistMeasurements=(metrics.waist_circumference||[]).length;
  const waistLatest=latestMetric('waist_circumference');
  const waistFirst=firstMetric('waist_circumference');
  const waistChange=waistMeasurements>=2&&waistLatest!==null&&waistFirst!==null?round_(waistLatest-waistFirst,1):null;
  const metricCount=(name)=>(metrics[name]||[]).length;
  const metricDays=(name)=>periodDays.filter(d=>daily[d]&&daily[d][name]&&daily[d][name].length).length;
  const missingOrSparse=[];
  if(metricCount('weight_body_mass')<2)missingOrSparse.push('weight_body_mass has fewer than 2 measurements in the analysis period. Weight trend confidence is low.');
  if(metricCount('body_fat_percentage')<2)missingOrSparse.push('body_fat_percentage has fewer than 2 measurements in the analysis period. Body-fat trend confidence is low.');
  if(metricCount('body_mass_index')<2)missingOrSparse.push('body_mass_index has fewer than 2 measurements in the analysis period. BMI trend confidence is low.');
  if(metricDays('resting_heart_rate')<Math.max(2,Math.floor(periodDays.length*0.3)))missingOrSparse.push('resting_heart_rate coverage is sparse. Recovery assessment should be conservative.');
  if(!metricCount('heart_rate_variability'))missingOrSparse.push('heart_rate_variability is not available, so recovery analysis cannot use HRV.');
  if(!metricCount('sleep_analysis'))missingOrSparse.push('sleep_analysis is not available, so recovery analysis cannot use sleep duration or quality.');
  if(!metricCount('dietary_energy_consumed'))missingOrSparse.push('dietary_energy_consumed is not available, so calorie deficit cannot be calculated directly.');
  if(!metricCount('physical_effort'))missingOrSparse.push('physical_effort is not available, so absolute intensity comparison cannot use Apple Health Physical Effort.');
  if(!strengthSessions.length)missingOrSparse.push('No manual strength sessions were recorded in the analysis period. Strength-volume conclusions should be cautious.');
  const dataDiagnosis={
    analysis_days:periodDays.length,
    file_counts:{health:healthFiles.length,fitness:fitnessFiles.length,strength:strengthFiles.length},
    available_metrics:Object.keys(metrics).sort(),
    measurement_counts:{
      weight:metricCount('weight_body_mass'),
      body_fat:metricCount('body_fat_percentage'),
      bmi:metricCount('body_mass_index'),
      waist:metricCount('waist_circumference'),
      resting_hr:metricCount('resting_heart_rate'),
      heart_rate:metricCount('heart_rate'),
      hrv:metricCount('heart_rate_variability'),
      sleep:metricCount('sleep_analysis'),
      dietary_energy:metricCount('dietary_energy_consumed'),
      physical_effort:metricCount('physical_effort')
    },
    days_with_metric:{
      weight:metricDays('weight_body_mass'),
      body_fat:metricDays('body_fat_percentage'),
      bmi:metricDays('body_mass_index'),
      resting_hr:metricDays('resting_heart_rate'),
      steps:metricDays('step_count'),
      active_energy:metricDays('active_energy'),
      exercise_minutes:metricDays('apple_exercise_time'),
      physical_effort:metricDays('physical_effort')
    },
    cardio:{
      included_sessions:cardioWorkouts.length,
      excluded_sessions:excludedCardioWorkouts.length,
      excluded_workouts:excludedCardioWorkouts
    },
    strength:{
      recorded_sessions:strengthSessions.length,
      manual_tracking_start_note:'Manual strength logging started on 2026-07-20; earlier gaps may reflect missing records rather than no training.'
    },
    missing_or_sparse:missingOrSparse
  };
  return {
    coverage:{from:formatIso_(periodFrom),to:formatIso_(periodTo),analysis_days:periodDays.length,days_with_health_data:days.length,file_counts:dataDiagnosis.file_counts},
    data_diagnosis:dataDiagnosis,
    body:{weight_latest_kg:weightLatest,weight_first_kg:weightFirst,weight_change_kg:weightLatest!==null&&weightFirst!==null?round_(weightLatest-weightFirst,2):null,body_fat_latest_pct:normalizePercent(latestMetric('body_fat_percentage')),lean_mass_latest_kg:latestMetric('lean_body_mass'),bmi_latest:latestMetric('body_mass_index'),weight_measurements:(metrics.weight_body_mass||[]).length,waist_latest_cm:waistLatest,waist_first_cm:waistFirst,waist_change_cm:waistChange,waist_measurements:waistMeasurements,weekly_body_series:weeklyBodySeries,weekly_waist_series:weeklyWaistSeries,body_trend:{weight_kg_ma7_latest:weightMaLatest,weight_kg_ma7_first:weightMaFirst,weight_kg_ma7_change:weightMaLatest!==null&&weightMaFirst!==null?round_(weightMaLatest-weightMaFirst,2):null,body_fat_pct_ma7_latest:bodyFatMaLatest,bmi_ma7_latest:bmiMaLatest,moving_average_series:bodyTrendSeries}},
    activity:{steps_total:round_(sumMetric('step_count'),0),steps_daily_average:round_(avg_(dailySums('step_count')),0),distance_total_km:sumMetric('walking_running_distance'),active_energy_total_kcal:round_(sumMetric('active_energy')/4.184,1),exercise_minutes_total:sumMetric('apple_exercise_time'),stand_minutes_total:sumMetric('apple_stand_time'),daily_activity_series:dailyActivitySeries,physical_effort:physicalEffortSummary,cardio_summary:cardioSummary,cardio_sessions:recentCardioWorkouts},
    heart_rate:{resting_hr_average:round_(avg_(dailyAvgs('resting_heart_rate')),1),resting_hr_latest:latestMetric('resting_heart_rate'),walking_hr_average:round_(avg_(dailyAvgs('walking_heart_rate_average')),1),heart_rate_average:round_(avg_(dailyAvgs('heart_rate')),1),oxygen_saturation_latest:latestMetric('oxygen_saturation')},
    fitness:{session_count:workouts.length,total_minutes:round_(workouts.reduce((s,w)=>s+w.duration_min,0),1),active_kcal:round_(workouts.reduce((s,w)=>s+w.active_kcal,0),1),cardio_sessions:recentCardioWorkouts,sessions:workouts.slice(-50)},
    strength:{session_count:strengthSessions.length,total_sets:totalSets,total_reps:totalReps,total_volume_kg:round_(totalVolume,1),timed_seconds:totalTimedSeconds,by_exercise:byExercise,daily_sessions:strengthDailySessions.slice(-60)},
    pain:{event_count:pain.length,max_level:pain.length?Math.max.apply(null,pain.map(x=>x.level)):0,events:pain.slice(-30)},
    weight_loss_context:{goal:'체중감량',available_energy_expenditure_kcal:round_(sumMetric('active_energy')/4.184,1),food_intake_data_available:false,note:'식사·섭취 열량 데이터가 없으므로 칼로리 적자량을 직접 계산하지 않고 체중 추세와 활동량을 중심으로 평가합니다.'}
  };
}

function hasNumber_(value) {
  return value !== null && value !== undefined && value !== '' && isFinite(Number(value));
}

function periodDaysFromStats_(stats) {
  const coverage = stats && stats.coverage || {};
  const from = parseDate_(coverage.from);
  const to = parseDate_(coverage.to);

  if (from.getTime() > 0 && to.getTime() >= from.getTime()) {
    return Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000));
  }

  const recordedDays = Number(coverage.days_with_health_data);
  return isFinite(recordedDays) && recordedDays > 0 ? recordedDays : 1;
}

function normalizeRate_(value, periodDays, targetDays) {
  if (!hasNumber_(value) || !hasNumber_(periodDays) || Number(periodDays) <= 0) {
    return null;
  }
  return round_(Number(value) / Number(periodDays) * Number(targetDays || 1), 2);
}

function buildMetricComparison_(current, previous, lowerIsBetter, basis) {
  if (!hasNumber_(current) || !hasNumber_(previous)) {
    return null;
  }

  const currentNum = Number(current);
  const previousNum = Number(previous);
  const change = round_(currentNum - previousNum, 2);
  const changePct = previousNum !== 0
    ? round_((change / Math.abs(previousNum)) * 100, 1)
    : null;

  let direction = 'same';
  if (change > 0) direction = 'up';
  if (change < 0) direction = 'down';

  let improved = null;
  if (change !== 0 && lowerIsBetter !== null && lowerIsBetter !== undefined) {
    improved = lowerIsBetter ? change < 0 : change > 0;
  }

  return {
    current: round_(currentNum, 2),
    previous: round_(previousNum, 2),
    change: change,
    change_pct: changePct,
    direction: direction,
    improved: improved,
    basis: basis || 'direct'
  };
}

function buildActivityComparison_(currentStats, previousAnalysis) {
  const previousStats = previousAnalysis && previousAnalysis.statistics;
  if (!previousStats) return null;

  const currentActivity = currentStats.activity || {};
  const previousActivity = previousStats.activity || {};
  const currentFitness = currentStats.fitness || {};
  const previousFitness = previousStats.fitness || {};
  const currentCardio = currentActivity.cardio_summary || {};
  const previousCardio = previousActivity.cardio_summary || {};

  const currentDays = periodDaysFromStats_(currentStats);
  const previousDays = periodDaysFromStats_(previousStats);

  const currentDistanceDaily = normalizeRate_(
    currentCardio.distance_km ?? currentActivity.distance_total_km,
    currentDays,
    1
  );
  const previousDistanceDaily = normalizeRate_(
    previousCardio.distance_km ?? previousActivity.distance_total_km,
    previousDays,
    1
  );

  const currentSessionsWeekly = normalizeRate_(
    currentCardio.session_count ?? currentFitness.session_count,
    currentDays,
    7
  );
  const previousSessionsWeekly = normalizeRate_(
    previousCardio.session_count ?? previousFitness.session_count,
    previousDays,
    7
  );

  const currentMinutesWeekly = normalizeRate_(
    currentCardio.total_minutes ?? currentFitness.total_minutes,
    currentDays,
    7
  );
  const previousMinutesWeekly = normalizeRate_(
    previousCardio.total_minutes ?? previousFitness.total_minutes,
    previousDays,
    7
  );

  const currentKcalDaily = normalizeRate_(
    currentCardio.active_kcal ?? currentActivity.active_energy_total_kcal,
    currentDays,
    1
  );
  const previousKcalDaily = normalizeRate_(
    previousCardio.active_kcal ?? previousActivity.active_energy_total_kcal,
    previousDays,
    1
  );

  return {
    compared_to_analysis_id: previousAnalysis.analysis_id || null,
    compared_to_created_at: previousAnalysis.created_at || null,
    current_period_days: currentDays,
    previous_period_days: previousDays,
    steps_daily_average: buildMetricComparison_(
      currentActivity.steps_daily_average,
      previousActivity.steps_daily_average,
      false,
      'daily_average'
    ),
    distance_km: buildMetricComparison_(
      currentDistanceDaily,
      previousDistanceDaily,
      false,
      'daily_average'
    ),
    cardio_session_count: buildMetricComparison_(
      currentSessionsWeekly,
      previousSessionsWeekly,
      false,
      'weekly_equivalent'
    ),
    cardio_minutes: buildMetricComparison_(
      currentMinutesWeekly,
      previousMinutesWeekly,
      false,
      'weekly_equivalent'
    ),
    average_pace_min_per_km: buildMetricComparison_(
      currentCardio.avg_pace_min_per_km,
      previousCardio.avg_pace_min_per_km,
      true,
      'direct_average'
    ),
    average_heart_rate: buildMetricComparison_(
      currentCardio.avg_hr,
      previousCardio.avg_hr,
      null,
      'direct_average'
    ),
    active_kcal: buildMetricComparison_(
      currentKcalDaily,
      previousKcalDaily,
      false,
      'daily_average'
    ),
    workout_intensity_met: buildMetricComparison_(
      currentCardio.avg_workout_intensity_met,
      previousCardio.avg_workout_intensity_met,
      null,
      'direct_average'
    ),
    physical_effort_met: buildMetricComparison_(
      currentCardio.avg_physical_effort_met,
      previousCardio.avg_physical_effort_met,
      null,
      'direct_average'
    )
  };
}

function callOpenAI_(stats,latest,previousPlan,additionalRequest,baseline) {
  const key=getOpenAiKey_(); if(!key)throw new Error('스크립트 속성 OPENAI_API_KEY가 설정되지 않았습니다.');
  const schema={type:'object',additionalProperties:false,properties:{
    previous_plan_review:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},completion_rate:{type:['number','null']},completed:{type:'array',items:{type:'string'}},not_completed:{type:'array',items:{type:'string'}}},required:['summary','completion_rate','completed','not_completed']},
    ai_analysis:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},progress:{type:'array',items:{type:'string'}},concerns:{type:'array',items:{type:'string'}},recovery_status:{type:'string'},training_balance:{type:'string'}},required:['summary','progress','concerns','recovery_status','training_balance']},
    weight_loss_analysis:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},weight_trend:{type:'string'},activity_assessment:{type:'string'},weekly_targets:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}}},required:['summary','weight_trend','activity_assessment','weekly_targets','limitations']},
    next_plan:{type:'object',additionalProperties:false,properties:{period_days:{type:'integer'},weekly_goal:{type:'string'},daily_activity_target:{type:'object',additionalProperties:false,properties:{steps:{type:['integer','null']},cardio_minutes:{type:['integer','null']}},required:['steps','cardio_minutes']},sessions:{type:'array',items:{type:'object',additionalProperties:false,properties:{day_label:{type:'string'},focus:{type:'string'},exercises:{type:'array',items:{type:'object',additionalProperties:false,properties:{exercise:{type:'string'},record_type:{type:'string',enum:['weighted','bodyweight','timed']},sets:{type:'integer'},reps:{type:['integer','null']},seconds:{type:['integer','null']},suggested_weight_kg:{type:['number','null']},target_rpe:{type:['number','null']},reason:{type:'string'},pain_rule:{type:'string'}},required:['exercise','record_type','sets','reps','seconds','suggested_weight_kg','target_rpe','reason','pain_rule']}}},required:['day_label','focus','exercises']}},progression_rules:{type:'array',items:{type:'string'}},pain_rules:{type:'array',items:{type:'string'}}},required:['period_days','weekly_goal','daily_activity_target','sessions','progression_rules','pain_rules']},
    warnings:{type:'array',items:{type:'string'}}
  },required:['previous_plan_review','ai_analysis','weight_loss_analysis','next_plan','warnings']};

  const instructions='당신은 한국어로 답하는 운동 코치다. 목표는 체중감량과 근력 유지·향상이다. 제공된 수치만 근거로 분석하고, 식사 데이터가 없으면 칼로리 적자를 추정하지 않는다. 통증 기록을 최우선으로 반영한다. 허리 통증이 있거나 악화 신호가 있으면 허리에 부담되는 동작을 계획에서 제외하고 진료 또는 휴식을 권고한다. 의료 진단을 하지 않는다. 계획은 현실적인 7일 계획으로 작성한다.';
  const input={
    baseline:baseline||null,
    statistics:stats,
    previous_analysis:latest?{created_at:latest.created_at,ai_analysis:latest.ai_analysis,weight_loss_analysis:latest.weight_loss_analysis}:null,
    previous_plan:previousPlan||null,
    additional_request:additionalRequest||'',
    required_flow:['이전 계획 이행 평가','새 기록 분석','체중감량 분석','다음 7일 계획']
  };
  const finalInstructions=[
    '당신은 한국어로 답하는 운동 코치다. / You are a fitness coach who answers in Korean.',
    '사용자의 목표는 체중감량과 근력 유지 또는 향상이다. / The user goal is weight loss while maintaining or improving strength.',
    '제공된 측정값만 근거로 사용한다. / Use only the provided measurements as evidence.',
    '식사·섭취 열량 데이터가 없으면 칼로리 적자량을 추정하지 않는다. / If food intake data is unavailable, do not estimate calorie deficit.',
    '통증 기록을 최우선으로 반영한다. 허리 통증이나 악화 신호가 있으면 허리에 부담되는 동작을 제외하고 필요하면 휴식 또는 진료를 권고한다. / Prioritize pain records. If back pain or worsening warning signs exist, exclude back-loading movements and recommend rest or medical care as appropriate.',
    '의료 진단은 하지 않는다. / Do not provide medical diagnosis.',
    '현실적인 7일 운동 계획을 작성한다. / Create a realistic 7-day plan.',
    '고정 규칙: 7월 초의 실내 걷기와 최근의 실내 달리기 또는 실내 운동은 Apple Watch 운동명 선택 차이일 수 있으므로 운동명 변화 자체를 운동 방식 전환으로 해석하지 않는다. 거리, 시간, 페이스, 심박수, 케이던스, 활동칼로리 기준으로 같은 실내 유산소 흐름으로 비교한다. / Fixed rule: In early July, the same indoor cardio was sometimes recorded as indoor walking. Recent sessions may be recorded as indoor running or generic indoor workout. Do not interpret the workout-name change itself as a change in training style. Compare them as one indoor cardio trend using distance, duration, pace, heart rate, cadence, and active calories.',
    '고정 규칙: 근력운동 수동 기록은 2026년 7월 20일부터 시작되었으므로 그 이전 근력운동 공백은 실제 운동 부재가 아니라 기록 누락 가능성으로 본다. / Fixed rule: Manual strength logging starts on 2026-07-20. Treat missing strength records before 2026-07-20 as possible lack of logging coverage, not as definite absence of strength training.',
    '유산소 세부 규칙: statistics.activity.cardio_summary.quality_sessions가 있으면 선택된 분석기간 전체의 분 단위 추정 스플릿, 심박수 영역, 케이던스, 운동 후 심박수 회복을 페이스 안정성, 유산소 강도 분포, 피로, 회복 판단의 보조 근거로 사용한다. Apple Fitness의 초 단위 원본값처럼 과도하게 단정하지 않는다. / Cardio detail rule: When statistics.activity.cardio_summary.quality_sessions exists, use the selected analysis period, not only the recent display list. Treat minute-level estimated splits, heart-rate zones, cadence, and heart-rate recovery as supportive evidence for pace stability, cardio intensity distribution, fatigue, and recovery. Do not treat them as exact Apple Fitness second-level values.',
    '절대강도 규칙: Fitness workout의 intensity_met를 운동 세션 대표 MET로 우선 사용하고, Health의 physical_effort는 시간대별·운동구간 보조강도 자료로 사용한다. 3 MET 미만=저강도, 3~6 MET 미만=중강도, 6 MET 이상=고강도 분류는 참고용으로만 사용하며, 단일 값보다 동일 사용자 내 추세와 같은 운동에서의 페이스·심박수·케이던스 대비 변화를 우선한다. 같은 페이스에서 intensity/physical_effort와 심박수가 함께 낮아지면 효율 개선 가능성, 같은 강도에서 페이스가 향상되면 수행능력 개선 가능성으로 해석하되 과도하게 단정하지 않는다. / Absolute intensity rule: Prefer Fitness workout intensity_met as the session-level MET signal and use Health physical_effort as a time-window supportive intensity signal. Treat <3 MET as light, 3 to <6 as moderate, and >=6 as vigorous only as a reference. Prioritize within-user trends and changes relative to pace, heart rate, and cadence over a single MET value.',
    '체중 추세 규칙: statistics.body.body_trend에는 체중·체지방률·BMI의 7일 이동평균이 포함된다. 단일 측정값보다 이동평균을 우선해 체중감량 추세를 판단한다.',
    '허리둘레 규칙: statistics.body.waist_latest_cm과 waist_change_cm이 있으면 체중·체지방률과 함께 복부지방 변화의 보조 지표로 활용한다.',
    '데이터 품질 규칙: statistics.data_diagnosis.missing_or_sparse에 표시된 제한사항을 분석의 확신도에 반영하고, 없는 데이터는 추정하지 않는다.'
  ].join('\n');

  const payload={
    model:getOpenAiModel_(),
    instructions:finalInstructions,
    input:[{role:'user',content:[{type:'input_text',text:JSON.stringify(input)}]}],
    text:{
      format:{
        type:'json_schema',
        name:'workout_analysis',
        strict:true,
        schema:schema
      }
    }
  };

  const response=UrlFetchApp.fetch('https://api.openai.com/v1/responses',{
    method:'post',
    contentType:'application/json',
    headers:{Authorization:'Bearer '+key},
    payload:JSON.stringify(payload),
    muteHttpExceptions:true
  });
  const code=response.getResponseCode();
  const text=response.getContentText();
  if(code<200||code>=300)throw new Error('OpenAI API 오류 '+code+': '+text.substring(0,500));
  const parsed=JSON.parse(text);
  const outputText=extractResponseOutputText_(parsed);
  if(!outputText)throw new Error('OpenAI 응답에서 분석 결과를 찾지 못했습니다.');
  return JSON.parse(outputText);
}

function extractResponseOutputText_(response) {
  if (!response) return '';
  if (response.output_text) return response.output_text;
  const output = response.output || [];
  for (let i=0;i<output.length;i++) {
    const content = output[i] && output[i].content || [];
    for (let j=0;j<content.length;j++) {
      if (content[j] && content[j].type === 'output_text' && content[j].text) return content[j].text;
    }
  }
  return '';
}

function getLatestAnalysisResponse_() {
  return {ok:true,analysis:findLatestAnalysis_()};
}

function getOpenAiKey_() {
  return PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY') || '';
}

function getOpenAiModel_() {
  return PropertiesService.getScriptProperties().getProperty('OPENAI_MODEL') || 'gpt-5-mini';
}

function getOrCreateFolder_(parent,name) {
  const it=parent.getFoldersByName(name);
  return it.hasNext()?it.next():parent.createFolder(name);
}

function saveAnalysis_(analysis) {
  const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);
  const folder=getOrCreateFolder_(root,ANALYSIS_FOLDER_NAME);
  const name=analysis.analysis_id+'.json';
  folder.createFile(name,JSON.stringify(analysis,null,2),MimeType.PLAIN_TEXT);
}

function findLatestAnalysis_() {
  const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);
  const it=root.getFoldersByName(ANALYSIS_FOLDER_NAME);
  if(!it.hasNext())return null;
  const folder=it.next();
  const files=folder.getFiles();
  let latest=null; let latestTime=0;
  while(files.hasNext()){
    const f=files.next();
    if(!/\.json$/i.test(f.getName()))continue;
    try{
      const obj=JSON.parse(f.getBlob().getDataAsString('UTF-8'));
      const t=parseDate_(obj.created_at||f.getLastUpdated()).getTime();
      if(t>latestTime){latest=obj;latestTime=t;}
    }catch(e){}
  }
  return latest;
}

function collectJsonFiles_(folder,from,to,type) {
  const out=[];
  collectFolderJson_(folder,from,to,type,out);
  return out;
}

function collectFolderJson_(folder,from,to,type,out) {
  const files=folder.getFiles();
  while(files.hasNext()){
    const f=files.next();
    if(!/\.json$/i.test(f.getName()))continue;
    if(type==='strength' && !/^strength-/i.test(f.getName()))continue;
    const updated=f.getLastUpdated();
    if(updated<from||updated>addDays_(to,1))continue;
    try{
      const obj=JSON.parse(f.getBlob().getDataAsString('UTF-8'));
      out.push({name:f.getName(),modified_at:formatIso_(updated),data:obj});
    }catch(e){}
  }
  const folders=folder.getFolders();
  while(folders.hasNext()){
    const child=folders.next();
    if(type==='strength' && (child.getName()===ANALYSIS_FOLDER_NAME||child.getName()===BASELINE_FOLDER_NAME))continue;
    collectFolderJson_(child,from,to,type,out);
  }
}

function collectStrengthRecords_(folder,out) {
  const files=folder.getFiles();
  while(files.hasNext()){
    const f=files.next();
    if(!/^strength-.*\.json$/i.test(f.getName()))continue;
    try{
      const obj=JSON.parse(f.getBlob().getDataAsString('UTF-8'));
      obj.drive_file_id=f.getId();
      obj._drive_file_id=f.getId();
      obj.file_id=f.getId();
      out.push(obj);
    }catch(e){}
  }
  const folders=folder.getFolders();
  while(folders.hasNext()){
    const child=folders.next();
    if(child.getName()===ANALYSIS_FOLDER_NAME||child.getName()===BASELINE_FOLDER_NAME)continue;
    collectStrengthRecords_(child,out);
  }
}

function deleteStrengthFile_(fileId) {
  const id=String(fileId||'').trim();
  if(!id)throw new Error('삭제할 파일 ID가 없습니다.');
  const file=DriveApp.getFileById(id);
  if(!/^strength-.*\.json$/i.test(file.getName()))throw new Error('삭제 가능한 근력운동 기록 파일이 아닙니다.');
  if(!isFileUnderFolder_(file,DriveApp.getFolderById(STRENGTH_FOLDER_ID)))throw new Error('Strength 폴더 밖의 파일은 삭제할 수 없습니다.');
  file.setTrashed(true);
  return {ok:true,deleted:true,file_id:id};
}

function isFileUnderFolder_(file,rootFolder) {
  const target=rootFolder.getId();
  const parents=file.getParents();
  const visited={};
  while(parents.hasNext()){
    const p=parents.next();
    if(p.getId()===target)return true;
    if(isFolderUnderFolder_(p,target,visited))return true;
  }
  return false;
}

function isFolderUnderFolder_(folder,targetId,visited) {
  if(!folder)return false;
  const id=folder.getId();
  if(id===targetId)return true;
  if(visited[id])return false;
  visited[id]=true;
  const parents=folder.getParents();
  while(parents.hasNext()){
    if(isFolderUnderFolder_(parents.next(),targetId,visited))return true;
  }
  return false;
}

function newestTimestamp_(items) {
  let newest=0;
  (items||[]).forEach(x=>{
    const values=[
      x&&x.modified_at,
      x&&x.data&&x.data.date,
      x&&x.data&&x.data.started_at,
      x&&x.data&&x.data.finished_at
    ];
    values.forEach(v=>{
      const t=parseDate_(v).getTime();
      if(t>newest)newest=t;
    });
  });
  return newest;
}

function getSessionTimestamp_(s) {
  return parseDate_(s&&s.finished_at||s&&s.started_at||s&&s.workout_date||0).getTime();
}

function getBaselineSummary_() {
  try{
    const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);
    const it=root.getFoldersByName(BASELINE_FOLDER_NAME);
    if(!it.hasNext())return null;
    const folder=it.next();
    const files=folder.getFiles();
    let latest=null; let time=0;
    while(files.hasNext()){
      const f=files.next();
      if(!/\.json$/i.test(f.getName()))continue;
      try{
        const obj=JSON.parse(f.getBlob().getDataAsString('UTF-8'));
        const t=f.getLastUpdated().getTime();
        if(t>time){latest=obj;time=t;}
      }catch(e){}
    }
    return latest;
  }catch(e){return null;}
}

function normalizeAnalysisFrom_(input,defaultDate,now) {
  const raw=String(input||'').trim();
  if(!raw)return defaultDate;
  const d=parseDate_(raw.length===10?raw+' 00:00:00 +0900':raw);
  if(!d||isNaN(d.getTime()))return defaultDate;
  if(d>now)return defaultDate;
  return startOfDay_(d);
}

function parseDate_(value) {
  if(value instanceof Date)return value;
  if(value===null||value===undefined||value==='')return new Date(0);
  if(typeof value==='number')return new Date(value);
  const s=String(value);
  let d=new Date(s);
  if(!isNaN(d.getTime()))return d;
  d=new Date(s.replace(' ','T'));
  if(!isNaN(d.getTime()))return d;
  return new Date(0);
}

function formatIso_(date) {
  return Utilities.formatDate(date,TIME_ZONE,"yyyy-MM-dd'T'HH:mm:ssXXX");
}

function startOfDay_(d) {
  return new Date(Utilities.formatDate(d,TIME_ZONE,'yyyy/MM/dd 00:00:00')+' +0900');
}

function addDays_(d,n) {
  return new Date(d.getTime()+n*86400000);
}

function sum_(arr) {
  return (arr||[]).reduce((s,v)=>s+(isFinite(Number(v))?Number(v):0),0);
}

function avg_(arr) {
  const a=(arr||[]).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number);
  return a.length?sum_(a)/a.length:null;
}

function round_(v,digits) {
  if(v===null||v===undefined||!isFinite(Number(v)))return null;
  const p=Math.pow(10,digits||0);
  return Math.round(Number(v)*p)/p;
}

function num_(v) {
  if(v===null||v===undefined||v==='')return null;
  const n=Number(v);
  return isFinite(n)?round_(n,2):null;
}

function debugOpenAiAuthorization_() {
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/models', {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + (getOpenAiKey_() || 'missing-key')
    },
    muteHttpExceptions: true
  });

  console.log('OpenAI authorization check HTTP ' + response.getResponseCode());
  return response.getResponseCode();
}
