/**
 * Workout Logger - Apps Script Security Layer
 *
 * 적용 방법
 * 1) 기존 Code.gs 상단의 HEALTH_FOLDER_ID / FITNESS_FOLDER_ID / STRENGTH_FOLDER_ID 3개 const를 삭제합니다.
 * 2) 기존 Code.gs의 doPost(e), doGet(e) 함수 2개를 삭제합니다.
 * 3) 이 파일 내용을 Code.gs 맨 위에 붙여넣습니다.
 * 4) 기존 나머지 함수(saveStrengthSession_, runAiAnalysis_ 등)는 그대로 둡니다.
 * 5) 프로젝트 설정 > 스크립트 속성에 아래 값을 등록합니다.
 *    HEALTH_FOLDER_ID, FITNESS_FOLDER_ID, STRENGTH_FOLDER_ID, NUTRITION_FOLDER_ID,
 *    OPENAI_API_KEY, OPENAI_MODEL, APP_PASSWORD
 * 6) 저장 후 웹 앱을 새 버전으로 재배포합니다.
 */

const SECURITY_PROPERTIES_ = PropertiesService.getScriptProperties();

const HEALTH_FOLDER_ID = SECURITY_PROPERTIES_.getProperty('HEALTH_FOLDER_ID') || '';
const FITNESS_FOLDER_ID = SECURITY_PROPERTIES_.getProperty('FITNESS_FOLDER_ID') || '';
const STRENGTH_FOLDER_ID = SECURITY_PROPERTIES_.getProperty('STRENGTH_FOLDER_ID') || '';
const NUTRITION_FOLDER_ID = SECURITY_PROPERTIES_.getProperty('NUTRITION_FOLDER_ID') || '';

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

// PWA 최근 기록 조회용 단일 집계 파일.
// 개별 strength-*.json이 원본이며, 이 파일은 조회 성능을 위한 파생 인덱스입니다.
const STRENGTH_INDEX_FILE_NAME_ = 'recent-strength-index.json';
const STRENGTH_INDEX_SCHEMA_VERSION_ = 1;

function saveStrengthSession_(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
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

    // 인증/요청 제어용 필드는 운동 원본 JSON에 저장하지 않습니다.
    const persistedData = JSON.parse(JSON.stringify(data || {}));
    delete persistedData.auth_token;
    delete persistedData.action;
    delete persistedData.password;

    const file = monthFolder.createFile(
      fileName,
      JSON.stringify(persistedData,null,2),
      MimeType.PLAIN_TEXT
    );

    // 원본 파일 저장이 성공한 뒤에만 조회용 인덱스를 갱신합니다.
    const indexedSession = attachStrengthDriveMeta_(persistedData, file);
    upsertStrengthIndexByFileId_(folder, indexedSession);

    return {
      ok:true,
      fileName:fileName,
      file_id:file.getId()
    };
  } finally {
    lock.releaseLock();
  }
}

function listStrengthSessions_() {
  const root = DriveApp.getFolderById(STRENGTH_FOLDER_ID);
  let index = readStrengthIndex_(root);

  // 최초 적용, 인덱스 유실/손상 시에만 원본 JSON 전체를 읽어 복구합니다.
  if (!index) {
    index = rebuildStrengthIndexInternal_(root);
  }

  const sessions = Array.isArray(index.sessions)
    ? index.sessions.slice()
    : [];

  sessions.sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b));

  // 기존 PWA 응답 형식을 그대로 유지합니다.
  return {
    ok:true,
    count:sessions.length,
    sessions:sessions.slice(-300),
    source:'strength_index',
    index_updated_at:index.updated_at || null
  };
}

/**
 * Apps Script 편집기에서 필요할 때 수동 실행하는 복구/초기화 함수입니다.
 * 모든 원본 strength-*.json을 다시 읽어 recent-strength-index.json을 재생성합니다.
 */
function rebuildStrengthIndex_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const root = DriveApp.getFolderById(STRENGTH_FOLDER_ID);
    const index = rebuildStrengthIndexInternal_(root);
    console.log(
      'Strength index 재생성 완료: ' +
      String(index.session_count || 0) +
      ' sessions'
    );
    return index;
  } finally {
    lock.releaseLock();
  }
}

function rebuildStrengthIndexInternal_(root) {
  const sessions = [];
  collectStrengthRecords_(root, sessions);
  sessions.sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b));

  const index = {
    schema_version: STRENGTH_INDEX_SCHEMA_VERSION_,
    type: 'strength_recent_index',
    generated_from: 'individual_strength_json_files',
    updated_at: formatIso_(new Date()),
    session_count: sessions.length,
    sessions: sessions
  };

  writeStrengthIndex_(root, index);
  return index;
}

function readStrengthIndex_(root) {
  const files = root.getFilesByName(STRENGTH_INDEX_FILE_NAME_);
  if (!files.hasNext()) return null;

  const file = files.next();

  try {
    const index = JSON.parse(file.getBlob().getDataAsString('UTF-8'));

    if (
      !index ||
      Number(index.schema_version) !== STRENGTH_INDEX_SCHEMA_VERSION_ ||
      !Array.isArray(index.sessions)
    ) {
      console.log('Strength index 형식이 올바르지 않아 재생성이 필요합니다.');
      return null;
    }

    return index;
  } catch (e) {
    console.log('Strength index 읽기 실패: ' + e);
    return null;
  }
}

function writeStrengthIndex_(root, index) {
  const payload = Object.assign({}, index, {
    schema_version: STRENGTH_INDEX_SCHEMA_VERSION_,
    type: 'strength_recent_index',
    updated_at: formatIso_(new Date()),
    session_count: Array.isArray(index.sessions) ? index.sessions.length : 0
  });

  const content = JSON.stringify(payload, null, 2);
  const files = root.getFilesByName(STRENGTH_INDEX_FILE_NAME_);

  if (files.hasNext()) {
    const file = files.next();
    file.setContent(content);

    // 같은 이름의 중복 인덱스가 생겼다면 첫 파일만 유지합니다.
    while (files.hasNext()) {
      try {
        files.next().setTrashed(true);
      } catch (_) {}
    }
  } else {
    root.createFile(
      STRENGTH_INDEX_FILE_NAME_,
      content,
      MimeType.PLAIN_TEXT
    );
  }

  return payload;
}

function attachStrengthDriveMeta_(data, file) {
  const session = JSON.parse(JSON.stringify(data || {}));
  session.drive_file_id = file.getId();
  session.drive_file_name = file.getName();
  session.drive_file_updated_at = formatIso_(file.getLastUpdated());
  return session;
}

/**
 * 인덱스의 기본 식별자는 Drive 원본 파일 ID입니다.
 * 같은 날짜에 여러 운동 파일이 있어도 각각 독립된 항목으로 유지됩니다.
 * session_id는 원본 데이터의 논리 ID로 그대로 보존하지만,
 * 인덱스 항목을 날짜 또는 session_id만으로 합치지 않습니다.
 */
function upsertStrengthIndexByFileId_(root, session) {
  let index = readStrengthIndex_(root);

  // 인덱스가 없거나 손상된 상태에서 저장이 들어오면 원본에서 먼저 복구합니다.
  if (!index) {
    index = rebuildStrengthIndexInternal_(root);
    return index;
  }

  const sessions = index.sessions.slice();
  const fileId = String(session && session.drive_file_id || '');

  if (!fileId) {
    throw new Error('Strength index 갱신에 필요한 Drive 파일 ID가 없습니다.');
  }

  const pos = sessions.findIndex(function(item) {
    return String(item && item.drive_file_id || '') === fileId;
  });

  if (pos >= 0) {
    sessions[pos] = session;
  } else {
    sessions.push(session);
  }

  sessions.sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b));

  index.sessions = sessions;
  return writeStrengthIndex_(root, index);
}

function removeStrengthIndexByFileId_(root, fileId) {
  let index = readStrengthIndex_(root);

  // 삭제 대상 원본은 이미 휴지통으로 이동된 뒤이므로,
  // 인덱스가 없으면 현재 남아 있는 원본 파일 기준으로 재생성하면 됩니다.
  if (!index) {
    return rebuildStrengthIndexInternal_(root);
  }

  const target = String(fileId || '');
  index.sessions = index.sessions.filter(function(item) {
    return String(item && item.drive_file_id || '') !== target;
  });

  return writeStrengthIndex_(root, index);
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

    // 회복 baseline(최근 3/7일 + 이전 7일)을 계산할 수 있도록 Health는 최대 28일 회고 구간을 확보합니다.
    const healthReadFrom = addDays_(periodFrom,-27);
    const effectiveHealthReadFrom = healthReadFrom < analysisFrom ? healthReadFrom : analysisFrom;
    const health = dedupeCollectedFiles_(collectJsonFiles_(DriveApp.getFolderById(HEALTH_FOLDER_ID), effectiveHealthReadFrom, now, 'health'));
    const fitness = dedupeCollectedFiles_(collectJsonFiles_(DriveApp.getFolderById(FITNESS_FOLDER_ID), analysisFrom, now, 'fitness'));
    const strength = dedupeCollectedFiles_(collectJsonFiles_(DriveApp.getFolderById(STRENGTH_FOLDER_ID), analysisFrom, now, 'strength'));

    // 불완전 식단의 누락 끼니 추정을 위해 분석 시작일보다 최대 14일 앞까지 읽습니다.
    // 이 추가 구간은 추정 후보로만 쓰고, nutrition.daily_series에는 분석기간 데이터만 남깁니다.
    const nutritionReadFrom = addDays_(periodFrom,-14);
    const nutrition = NUTRITION_FOLDER_ID
      ? dedupeCollectedFiles_(collectJsonFiles_(DriveApp.getFolderById(NUTRITION_FOLDER_ID), nutritionReadFrom, now, 'nutrition'))
      : [];

    const newestDataTime = newestTimestamp_(health.concat(fitness).concat(strength).concat(nutrition));
    if (!force && !analysisFromManual && latest && newestDataTime && newestDataTime <= parseDate_(latest.period && latest.period.to || latest.created_at).getTime() && !String(additionalRequest||'').trim()) {
      return {ok:true,unchanged:true,message:'마지막 분석 이후 새로운 기록이 없습니다.',analysis:latest};
    }

    const stats = buildStatistics_(health,fitness,strength,nutrition,periodFrom,now);
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
      data_sources:{health_files:health.length,fitness_files:fitness.length,strength_files:strength.length,nutrition_files:nutrition.length},
      statistics:stats,
      activity_comparison:activityComparison,
      baseline:baseline,
      previous_plan_review:ai.previous_plan_review,
      overall_assessment:ai.overall_assessment,
      recovery_analysis:ai.recovery_analysis,
      nutrition_analysis:ai.nutrition_analysis,
      ai_analysis:ai.ai_analysis,
      weight_loss_analysis:ai.weight_loss_analysis,
      next_plan:ai.next_plan,
      warnings:ai.warnings,
      model:getOpenAiModel_(),
      prompt_version:'3.0'
    };
    saveAnalysis_(analysis);
    return {ok:true,unchanged:false,analysis:analysis};
  } finally {
    lock.releaseLock();
  }
}

function buildStatistics_(healthFiles,fitnessFiles,strengthFiles,nutritionFiles,periodFrom,periodTo) {
  healthFiles=dedupeCollectedFiles_(healthFiles||[]);
  fitnessFiles=dedupeCollectedFiles_(fitnessFiles||[]);
  strengthFiles=dedupeCollectedFiles_(strengthFiles||[]);
  nutritionFiles=dedupeCollectedFiles_(nutritionFiles||[]);

  const metrics={};
  const recoveryMetrics={};
  const heartRateSamples=[];
  const sleepRecords=[];
  const recoveryHistoryFrom=addDays_(periodTo,-27);
  const recoveryQtyNames={
    heart_rate_variability:true,
    resting_heart_rate:true,
    blood_oxygen_saturation:true,
    respiratory_rate:true,
    walking_heart_rate_average:true,
    vo2_max:true
  };

  healthFiles.forEach(x=>{
    const arr=x.data && x.data.data && x.data.data.metrics || [];
    arr.forEach(m=>{
      const name=m.name; if(!name)return;
      if(!metrics[name]) metrics[name]=[];
      if(recoveryQtyNames[name]&&!recoveryMetrics[name])recoveryMetrics[name]=[];

      (m.data||[]).forEach(v=>{
        const t=parseDate_(v.date);
        if(!(t<=periodTo))return;

        // 일반 심박은 qty가 아니라 Avg/Min/Max 구조입니다.
        if(name==='heart_rate'){
          if(t>=recoveryHistoryFrom){
            const avg=isFinite(Number(v.Avg))?Number(v.Avg):null;
            const min=isFinite(Number(v.Min))?Number(v.Min):avg;
            const max=isFinite(Number(v.Max))?Number(v.Max):avg;
            if(avg!==null)heartRateSamples.push({t:t.getTime(),avg:avg,min:min,max:max,units:m.units||''});
          }
          return;
        }

        // 수면은 qty가 아니라 totalSleep/deep/core/rem/awake 등의 구조입니다.
        if(name==='sleep_analysis'){
          if(t>=recoveryHistoryFrom){
            const totalSleep=isFinite(Number(v.totalSleep))?Number(v.totalSleep):null;
            if(totalSleep!==null){
              sleepRecords.push({
                t:t.getTime(),
                date:v.date||null,
                sleepStart:v.sleepStart||v.inBedStart||null,
                sleepEnd:v.sleepEnd||v.inBedEnd||null,
                totalSleep:totalSleep,
                deep:isFinite(Number(v.deep))?Number(v.deep):null,
                core:isFinite(Number(v.core))?Number(v.core):null,
                rem:isFinite(Number(v.rem))?Number(v.rem):null,
                awake:isFinite(Number(v.awake))?Number(v.awake):null,
                inBed:isFinite(Number(v.inBed))?Number(v.inBed):null,
                source:v.source||null
              });
            }
          }
          return;
        }

        if(isFinite(Number(v.qty))){
          const point={t:t.getTime(),qty:Number(v.qty),units:m.units||''};
          if(t>=periodFrom)metrics[name].push(point);
          if(recoveryQtyNames[name]&&t>=recoveryHistoryFrom)recoveryMetrics[name].push(point);
        }
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
  const intensityCategory_=(met)=>{
    if(met===null||met===undefined||!isFinite(Number(met)))return null;
    const n=Number(met);
    if(n<3)return 'low';
    if(n<6)return 'moderate';
    return 'vigorous';
  };
  const summarizePhysicalEffort_=(series,startMs,endMs)=>{
    const points=(series||[])
      .filter(v=>v.t>=startMs&&v.t<=endMs&&isFinite(Number(v.qty)))
      .sort((a,b)=>a.t-b.t);
    if(!points.length){
      return {
        sample_count:0,
        avg_met:null,
        median_met:null,
        max_met:null,
        low_minutes_est:null,
        moderate_minutes_est:null,
        vigorous_minutes_est:null,
        coverage_minutes_est:null,
        granularity:'health_physical_effort_samples'
      };
    }
    const values=points.map(v=>Number(v.qty));
    const minutes={low:0,moderate:0,vigorous:0};
    let coverageSeconds=0;
    points.forEach((v,i)=>{
      const next=points[i+1];
      // Physical Effort export is sampled, not a continuous second-level stream.
      // Count at most 90 seconds per sample so long gaps are not falsely treated as continuous effort.
      let seconds=60;
      if(next){
        const gap=(next.t-v.t)/1000;
        if(gap>0)seconds=Math.min(90,gap);
      }
      if(v.t+seconds*1000>endMs)seconds=Math.max(0,(endMs-v.t)/1000);
      const category=intensityCategory_(v.qty);
      if(category)minutes[category]+=seconds/60;
      coverageSeconds+=seconds;
    });
    return {
      sample_count:points.length,
      avg_met:round_(avg_(values),2),
      median_met:round_(median_(values),2),
      max_met:round_(Math.max.apply(null,values),2),
      low_minutes_est:round_(minutes.low,1),
      moderate_minutes_est:round_(minutes.moderate,1),
      vigorous_minutes_est:round_(minutes.vigorous,1),
      coverage_minutes_est:round_(coverageSeconds/60,1),
      granularity:'health_physical_effort_samples',
      note:'Estimated from Health Auto Export physical_effort samples; durations are capped per sample to avoid filling long sampling gaps.'
    };
  };
  const physicalEffortSeries=(metrics.physical_effort||[]).slice().sort((a,b)=>a.t-b.t);
  const physicalEffortPeriod=summarizePhysicalEffort_(physicalEffortSeries,periodFrom.getTime(),periodTo.getTime());
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
    const raw=w&&w.intensity;
    const value=raw&&typeof raw==='object'?raw.qty:raw;
    const n=Number(value);
    return isFinite(n)&&n>0?round_(n,2):null;
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
      physical_effort:summarizePhysicalEffort_(physicalEffortSeries,startMs,endMs),
      available_series:{
        distance_points:distanceSeries.length,
        heart_rate_points:hrSeries.length,
        cadence_points:cadenceSeries.length,
        recovery_points:recoverySeries.length,
        physical_effort_points:physicalEffortSeries.filter(v=>v.t>=startMs&&v.t<=endMs).length
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
    const fitnessIntensityMet=workoutIntensityMet(w);
    const physicalEffortSummary=summarizePhysicalEffort_(physicalEffortSeries,start.getTime(),start.getTime()+durationMin*60000);
    const representativeIntensityMet=fitnessIntensityMet!==null?fitnessIntensityMet:physicalEffortSummary.avg_met;
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
      intensity_met:representativeIntensityMet,
      intensity_category:intensityCategory_(representativeIntensityMet),
      intensity_source:fitnessIntensityMet!==null?'fitness_workout_intensity':(physicalEffortSummary.avg_met!==null?'health_physical_effort_avg':'unavailable'),
      fitness_intensity_met:fitnessIntensityMet,
      physical_effort:physicalEffortSummary,
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
  const cardioIntensityMinutes=cardioWorkouts.filter(w=>w.intensity_met!==null).reduce((s,w)=>s+Number(w.duration_min||0),0);
  const cardioIntensityWeighted=cardioWorkouts.filter(w=>w.intensity_met!==null).reduce((s,w)=>s+Number(w.intensity_met)*Number(w.duration_min||0),0);
  const cardioIntensityValues=cardioWorkouts.map(w=>w.intensity_met).filter(v=>v!==null&&isFinite(Number(v))).map(Number);
  const cardioPhysicalEffort={
    sample_count:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.sample_count||0)),0),
    low_minutes_est:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.low_minutes_est||0)),1),
    moderate_minutes_est:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.moderate_minutes_est||0)),1),
    vigorous_minutes_est:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.vigorous_minutes_est||0)),1),
    coverage_minutes_est:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.coverage_minutes_est||0)),1)
  };
  const cardioSummary={
    session_count:cardioWorkouts.length,
    total_minutes:round_(cardioMinutes,1),
    distance_km:round_(cardioDistance,2),
    avg_pace_min_per_km:cardioDistance?round_(cardioMinutes/cardioDistance,2):null,
    avg_hr:cardioMinutes?round_(cardioHrWeighted/cardioMinutes,1):null,
    active_kcal:round_(cardioKcal,1),
    avg_intensity_met:cardioIntensityMinutes?round_(cardioIntensityWeighted/cardioIntensityMinutes,2):null,
    max_intensity_met:cardioIntensityValues.length?round_(Math.max.apply(null,cardioIntensityValues),2):null,
    intensity_source_priority:'Fitness workout intensity first; Health physical_effort average is fallback.',
    physical_effort_distribution:cardioPhysicalEffort,
    quality_detail_note:'Cardio sessions in the selected analysis period include minute-level estimated splits, heart-rate zones, cadence, recovery, Fitness intensity (MET-equivalent), and Health physical_effort when available.',
    quality_sessions:cardioWorkouts.map(w=>({
      name:w.name,
      start:w.start,
      distance_km:w.distance_km,
      pace_min_per_km:w.pace_min_per_km,
      avg_hr:w.avg_hr,
      cadence_spm:w.cadence_spm,
      active_kcal:w.active_kcal,
      intensity_met:w.intensity_met,
      intensity_category:w.intensity_category,
      intensity_source:w.intensity_source,
      fitness_intensity_met:w.fitness_intensity_met,
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
  const recoveryStats=buildRecoveryStatistics_(recoveryMetrics,heartRateSamples,sleepRecords,periodTo);
  const nutritionStats=buildNutritionStatistics_(nutritionFiles,periodFrom,periodTo);
  const missingOrSparse=[];
  if(metricCount('weight_body_mass')<2)missingOrSparse.push('weight_body_mass has fewer than 2 measurements in the analysis period. Weight trend confidence is low.');
  if(metricCount('body_fat_percentage')<2)missingOrSparse.push('body_fat_percentage has fewer than 2 measurements in the analysis period. Body-fat trend confidence is low.');
  if(metricCount('body_mass_index')<2)missingOrSparse.push('body_mass_index has fewer than 2 measurements in the analysis period. BMI trend confidence is low.');
  if((recoveryStats.resting_heart_rate&&recoveryStats.resting_heart_rate.days_7d||0)<3)missingOrSparse.push('resting_heart_rate coverage is sparse in the recent 7-day window. Recovery assessment should be conservative.');
  if(!(recoveryMetrics.heart_rate_variability||[]).length)missingOrSparse.push('heart_rate_variability is not available in the recovery lookback window, so recovery analysis cannot use HRV.');
  if(!sleepRecords.length)missingOrSparse.push('sleep_analysis is not available in the recovery lookback window, so sleep-based recovery confidence is limited.');
  if(!nutritionStats.days_recorded)missingOrSparse.push('Nutrition source records are not available in the analysis period, so calorie intake and energy balance cannot be evaluated.');
  if(!metricCount('physical_effort'))missingOrSparse.push('physical_effort is not available in Health exports. Absolute-intensity analysis will rely on Fitness workout intensity when present.');
  if(!workouts.some(w=>w.fitness_intensity_met!==null))missingOrSparse.push('Fitness workout intensity is not available in the selected workouts. Absolute-intensity analysis will use Health physical_effort when available.');
  if(!strengthSessions.length)missingOrSparse.push('No manual strength sessions were recorded in the analysis period. Strength-volume conclusions should be cautious.');
  const dataDiagnosis={
    analysis_days:periodDays.length,
    file_counts:{health:healthFiles.length,fitness:fitnessFiles.length,strength:strengthFiles.length,nutrition:nutritionFiles.length},
    available_metrics:Object.keys(metrics).sort(),
    measurement_counts:{
      weight:metricCount('weight_body_mass'),
      body_fat:metricCount('body_fat_percentage'),
      bmi:metricCount('body_mass_index'),
      waist:metricCount('waist_circumference'),
      resting_hr:metricCount('resting_heart_rate'),
      heart_rate:heartRateSamples.length,
      hrv:(recoveryMetrics.heart_rate_variability||[]).length,
      sleep:sleepRecords.length,
      blood_oxygen:(recoveryMetrics.blood_oxygen_saturation||[]).length,
      respiratory_rate:(recoveryMetrics.respiratory_rate||[]).length,
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
    activity:{steps_total:round_(sumMetric('step_count'),0),steps_daily_average:round_(avg_(dailySums('step_count')),0),distance_total_km:sumMetric('walking_running_distance'),active_energy_total_kcal:round_(sumMetric('active_energy')/4.184,1),basal_energy_total_kcal:round_(sumMetric('basal_energy_burned')/4.184,1),exercise_minutes_total:sumMetric('apple_exercise_time'),stand_minutes_total:sumMetric('apple_stand_time'),daily_activity_series:dailyActivitySeries,physical_effort:physicalEffortPeriod,cardio_summary:cardioSummary,cardio_sessions:recentCardioWorkouts},
    heart_rate:{resting_hr_average:round_(avg_(dailyAvgs('resting_heart_rate')),1),resting_hr_latest:latestMetric('resting_heart_rate'),walking_hr_average:round_(avg_(dailyAvgs('walking_heart_rate_average')),1),heart_rate_average:recoveryStats.heart_rate&&recoveryStats.heart_rate.avg_7d_bpm||null,oxygen_saturation_latest:recoveryStats.blood_oxygen&&recoveryStats.blood_oxygen.latest_pct||null},
    fitness:{session_count:workouts.length,total_minutes:round_(workouts.reduce((s,w)=>s+w.duration_min,0),1),active_kcal:round_(workouts.reduce((s,w)=>s+w.active_kcal,0),1),cardio_sessions:recentCardioWorkouts,sessions:workouts.slice(-50)},
    strength:{session_count:strengthSessions.length,total_sets:totalSets,total_reps:totalReps,total_volume_kg:round_(totalVolume,1),timed_seconds:totalTimedSeconds,by_exercise:byExercise,daily_sessions:strengthDailySessions.slice(-60)},
    pain:{event_count:pain.length,max_level:pain.length?Math.max.apply(null,pain.map(x=>x.level)):0,events:pain.slice(-30)},
    recovery:recoveryStats,
    nutrition:nutritionStats,
    weight_loss_context:{
      goal:'체중감량',
      active_energy_expenditure_kcal:round_(sumMetric('active_energy')/4.184,1),
      basal_energy_expenditure_kcal:round_(sumMetric('basal_energy_burned')/4.184,1),
      food_intake_data_available:nutritionStats.days_recorded>0,
      complete_nutrition_days:nutritionStats.complete_days,
      incomplete_nutrition_days:nutritionStats.incomplete_days,
      complete_day_average_calories_kcal:nutritionStats.complete_day_average?nutritionStats.complete_day_average.calories_kcal:null,
      estimated_complete_day_average_calories_kcal:nutritionStats.estimated_complete_day_average?nutritionStats.estimated_complete_day_average.calories_kcal:null,
      note:nutritionStats.days_recorded
        ? '완전 기록일의 실제 섭취량을 우선 사용합니다. 불완전 기록일의 recorded_total은 최소 기록 섭취량으로만 취급하고, 누락 끼니 보정치는 estimated_complete_total로 분리합니다.'
        : '식단 원본 기록이 없으므로 칼로리 섭취량과 에너지 균형을 평가하지 않습니다.'
    }
  };
}


function buildRecoveryStatistics_(recoveryMetrics,heartRateSamples,sleepRecords,periodTo) {
  recoveryMetrics=recoveryMetrics||{};
  heartRateSamples=(heartRateSamples||[]).slice().sort((a,b)=>a.t-b.t);
  sleepRecords=(sleepRecords||[]).slice().sort((a,b)=>a.t-b.t);
  const end=startOfDay_(periodTo).getTime()+86400000-1;
  const dayKey_=(t)=>Utilities.formatDate(new Date(t),TIME_ZONE,'yyyy-MM-dd');
  const avgFinite_=(arr)=>{
    const a=(arr||[]).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number);
    return a.length?round_(a.reduce((s,v)=>s+v,0)/a.length,2):null;
  };
  const minFinite_=(arr)=>{
    const a=(arr||[]).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number);
    return a.length?round_(Math.min.apply(null,a),2):null;
  };
  const maxFinite_=(arr)=>{
    const a=(arr||[]).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number);
    return a.length?round_(Math.max.apply(null,a),2):null;
  };
  const dailyMetric_=(name)=>{
    const by={};
    (recoveryMetrics[name]||[]).forEach(p=>{
      const d=dayKey_(p.t);
      if(!by[d])by[d]=[];
      by[d].push(Number(p.qty));
    });
    return Object.keys(by).sort().map(d=>({date:d,avg:avgFinite_(by[d]),min:minFinite_(by[d]),max:maxFinite_(by[d]),samples:by[d].length}));
  };
  const inWindow_=(series,fromMs,toMs)=>series.filter(x=>{
    const t=parseDate_(x.date+'T12:00:00+09:00').getTime();
    return t>=fromMs&&t<=toMs;
  });
  const summarizeMetric_=(name,unitKey)=>{
    const series=dailyMetric_(name);
    const latest=series.length?series[series.length-1]:null;
    const d3=inWindow_(series,end-2*86400000,end);
    const d7=inWindow_(series,end-6*86400000,end);
    const prev7=inWindow_(series,end-13*86400000,end-7*86400000);
    const avg3=avgFinite_(d3.map(x=>x.avg));
    const avg7=avgFinite_(d7.map(x=>x.avg));
    const prev=avgFinite_(prev7.map(x=>x.avg));
    const out={
      latest_date:latest?latest.date:null,
      latest:latest?latest.avg:null,
      avg_3d:avg3,
      avg_7d:avg7,
      previous_7d_avg:prev,
      change_vs_7d_pct:latest&&avg7?round_((latest.avg-avg7)/Math.abs(avg7)*100,1):null,
      change_7d_vs_previous_7d_pct:avg7&&prev?round_((avg7-prev)/Math.abs(prev)*100,1):null,
      days_7d:d7.length,
      daily_series:series.slice(-28)
    };
    if(unitKey)out.unit=unitKey;
    return out;
  };

  const hrv=summarizeMetric_('heart_rate_variability','ms');
  const resting=summarizeMetric_('resting_heart_rate','bpm');
  const spo2=summarizeMetric_('blood_oxygen_saturation','%');
  const respiratory=summarizeMetric_('respiratory_rate','count/min');
  const walkingHr=summarizeMetric_('walking_heart_rate_average','bpm');
  const vo2=summarizeMetric_('vo2_max','mL/kg/min');

  const hrByDay={};
  heartRateSamples.forEach(p=>{
    const d=dayKey_(p.t);
    if(!hrByDay[d])hrByDay[d]=[];
    hrByDay[d].push(p);
  });
  const hrDaily=Object.keys(hrByDay).sort().map(d=>{
    const a=hrByDay[d];
    return {date:d,avg_bpm:avgFinite_(a.map(x=>x.avg)),min_bpm:minFinite_(a.map(x=>x.min)),max_bpm:maxFinite_(a.map(x=>x.max)),samples:a.length};
  });
  const hr7=inWindow_(hrDaily.map(x=>({date:x.date,avg:x.avg_bpm,min:x.min_bpm,max:x.max_bpm,samples:x.samples})),end-6*86400000,end);

  const sleepSeries=sleepRecords.map(s=>{
    const start=parseDate_(s.sleepStart);
    const finish=parseDate_(s.sleepEnd);
    const sleepHr=heartRateSamples.filter(h=>start.getTime()>0&&finish.getTime()>0&&h.t>=start.getTime()&&h.t<=finish.getTime());
    return {
      date:dayKey_(s.t),
      sleep_start:s.sleepStart,
      sleep_end:s.sleepEnd,
      total_sleep_hours:round_(s.totalSleep,2),
      deep_hours:s.deep!==null?round_(s.deep,2):null,
      core_hours:s.core!==null?round_(s.core,2):null,
      rem_hours:s.rem!==null?round_(s.rem,2):null,
      awake_hours:s.awake!==null?round_(s.awake,2):null,
      sleep_hr_avg_bpm:avgFinite_(sleepHr.map(x=>x.avg)),
      sleep_hr_min_bpm:minFinite_(sleepHr.map(x=>x.min)),
      sleep_hr_max_bpm:maxFinite_(sleepHr.map(x=>x.max)),
      sleep_hr_samples:sleepHr.length
    };
  });
  const recentSleep=sleepSeries.filter(x=>parseDate_(x.date+'T12:00:00+09:00').getTime()>=end-6*86400000);
  const lastSleep=sleepSeries.length?sleepSeries[sleepSeries.length-1]:null;

  return {
    hrv:{latest_ms:hrv.latest,latest_date:hrv.latest_date,avg_3d_ms:hrv.avg_3d,avg_7d_ms:hrv.avg_7d,previous_7d_avg_ms:hrv.previous_7d_avg,change_vs_7d_pct:hrv.change_vs_7d_pct,change_7d_vs_previous_7d_pct:hrv.change_7d_vs_previous_7d_pct,days_7d:hrv.days_7d,daily_series:hrv.daily_series},
    resting_heart_rate:{latest_bpm:resting.latest,latest_date:resting.latest_date,avg_3d_bpm:resting.avg_3d,avg_7d_bpm:resting.avg_7d,previous_7d_avg_bpm:resting.previous_7d_avg,change_vs_7d_pct:resting.change_vs_7d_pct,change_7d_vs_previous_7d_pct:resting.change_7d_vs_previous_7d_pct,days_7d:resting.days_7d,daily_series:resting.daily_series},
    sleep:{last_sleep:lastSleep,avg_7d_hours:avgFinite_(recentSleep.map(x=>x.total_sleep_hours)),days_7d:recentSleep.length,daily_series:sleepSeries.slice(-28)},
    heart_rate:{avg_7d_bpm:avgFinite_(hr7.map(x=>x.avg)),min_7d_bpm:minFinite_(hr7.map(x=>x.min)),max_7d_bpm:maxFinite_(hr7.map(x=>x.max)),daily_series:hrDaily.slice(-28)},
    blood_oxygen:{latest_pct:spo2.latest,avg_7d_pct:spo2.avg_7d,previous_7d_avg_pct:spo2.previous_7d_avg,days_7d:spo2.days_7d,daily_series:spo2.daily_series},
    respiratory_rate:{latest_count_min:respiratory.latest,avg_7d_count_min:respiratory.avg_7d,previous_7d_avg_count_min:respiratory.previous_7d_avg,days_7d:respiratory.days_7d,daily_series:respiratory.daily_series},
    walking_heart_rate:{latest_bpm:walkingHr.latest,avg_7d_bpm:walkingHr.avg_7d,previous_7d_avg_bpm:walkingHr.previous_7d_avg,daily_series:walkingHr.daily_series},
    vo2_max:{latest:vo2.latest,latest_date:vo2.latest_date,avg_7d:vo2.avg_7d,previous_7d_avg:vo2.previous_7d_avg,daily_series:vo2.daily_series},
    data_quality:{
      hrv_days_7d:hrv.days_7d,
      resting_hr_days_7d:resting.days_7d,
      sleep_days_7d:recentSleep.length,
      blood_oxygen_days_7d:spo2.days_7d,
      respiratory_rate_days_7d:respiratory.days_7d,
      note:'회복 평가는 HRV·안정시 심박·수면·수면중 심박을 우선하고, SpO2·호흡수는 보조 지표로 사용합니다. 수면/호흡 데이터가 희소하면 강한 결론을 피합니다.'
    }
  };
}

function buildNutritionStatistics_(nutritionFiles,periodFrom,periodTo) {
  const mainMeals=['breakfast','lunch','dinner'];
  const nutrientKeys=['calories_kcal','protein_g','carbs_g','fat_g'];
  const zeroNutrients_=()=>({calories_kcal:0,protein_g:0,carbs_g:0,fat_g:0});
  const addNutrients_=(a,b)=>{
    const out={};
    nutrientKeys.forEach(k=>out[k]=round_(Number(a&&a[k]||0)+Number(b&&b[k]||0),1));
    return out;
  };
  const avgNutrients_=(arr)=>{
    if(!arr.length)return null;
    const out={};
    nutrientKeys.forEach(k=>out[k]=round_(arr.reduce((s,x)=>s+Number(x&&x[k]||0),0)/arr.length,1));
    return out;
  };
  const median_=(arr)=>{
    const a=(arr||[]).filter(v=>isFinite(Number(v))).map(Number).sort((x,y)=>x-y);
    if(!a.length)return null;
    const m=Math.floor(a.length/2);
    return round_(a.length%2?a[m]:(a[m-1]+a[m])/2,1);
  };
  const mealTotal_=(meal)=>{
    if(meal&&meal.total&&isFinite(Number(meal.total.calories_kcal)))return nutrientKeys.reduce((o,k)=>(o[k]=round_(Number(meal.total[k]||0),1),o),{});
    const foods=(meal&&meal.foods)||(meal&&meal.items)||[];
    return foods.reduce((sum,f)=>addNutrients_(sum,nutrientKeys.reduce((o,k)=>(o[k]=Number(f&&f[k]||0),o),{})),zeroNutrients_());
  };
  const dailyTotal_=(record,meals)=>{
    if(record&&record.daily_total&&isFinite(Number(record.daily_total.calories_kcal)))return nutrientKeys.reduce((o,k)=>(o[k]=round_(Number(record.daily_total[k]||0),1),o),{});
    return meals.reduce((sum,m)=>addNutrients_(sum,m.total),zeroNutrients_());
  };

  const allRecords=[];
  (nutritionFiles||[]).forEach(f=>{
    const r=f&&f.data||{};
    const date=String(r.date||'').slice(0,10)||((f.name||'').match(/20\d{2}-\d{2}-\d{2}/)||[])[0];
    if(!date)return;
    const meals=(Array.isArray(r.meals)?r.meals:[]).map(m=>{
      const foods=(m.foods||m.items||[]).map(food=>({
        name:food.name||food.food_name||'',
        nutrition_source:food.nutrition_source||null,
        confidence:food.confidence||null
      })).filter(x=>x.name);
      return {time:m.time||null,meal_type:m.meal_type||'other',total:mealTotal_(m),foods:foods};
    });
    const present=[...new Set(meals.map(m=>m.meal_type).filter(x=>mainMeals.indexOf(x)>=0))];
    const missing=mainMeals.filter(x=>present.indexOf(x)<0);
    const coverage=r.record_coverage||{};
    const status=String(coverage.coverage_status||'').toLowerCase()==='complete'||missing.length===0?'complete':'incomplete';
    allRecords.push({
      date:date,
      recorded_total:dailyTotal_(r,meals),
      coverage_status:status,
      main_meals_present:present,
      main_meals_missing:Array.isArray(coverage.main_meals_missing)?coverage.main_meals_missing:missing,
      meals:meals,
      daily_total_scope:r.daily_total_scope||'recorded_items_only'
    });
  });
  allRecords.sort((a,b)=>a.date.localeCompare(b.date));

  const mealObservations=[];
  allRecords.forEach(r=>r.meals.forEach(m=>{
    if(mainMeals.indexOf(m.meal_type)<0)return;
    mealObservations.push({date:r.date,meal_type:m.meal_type,total:m.total});
  }));

  const imputeMeal_=(targetDate,mealType)=>{
    const target=parseDate_(targetDate+'T12:00:00+09:00').getTime();
    const windows=[3,7,14];
    for(let wi=0;wi<windows.length;wi++){
      const w=windows[wi];
      const c=mealObservations.filter(o=>o.meal_type===mealType&&Math.abs(parseDate_(o.date+'T12:00:00+09:00').getTime()-target)<=w*86400000);
      if(c.length){
        const total={};
        nutrientKeys.forEach(k=>total[k]=median_(c.map(x=>x.total[k]))||0);
        return {meal_type:mealType,estimated_total:total,method:'same_meal_nearby_median',window_days:w,source_count:c.length,source_dates:c.map(x=>x.date)};
      }
    }
    return null;
  };

  const periodStart=startOfDay_(periodFrom).getTime();
  const periodEnd=startOfDay_(periodTo).getTime()+86400000-1;
  const periodRecords=allRecords.filter(r=>{
    const t=parseDate_(r.date+'T12:00:00+09:00').getTime();
    return t>=periodStart&&t<=periodEnd;
  }).map(r=>{
    const out=JSON.parse(JSON.stringify(r));
    out.recorded_total_is_lower_bound=out.coverage_status!=='complete';
    out.imputed_meals=[];
    out.estimated_complete_total=out.coverage_status==='complete'?out.recorded_total:null;
    if(out.coverage_status!=='complete'){
      const missing=mainMeals.filter(x=>(out.main_meals_missing||[]).indexOf(x)>=0);
      let estimated=JSON.parse(JSON.stringify(out.recorded_total));
      let allEstimated=missing.length>0;
      missing.forEach(mt=>{
        const imp=imputeMeal_(out.date,mt);
        if(imp){out.imputed_meals.push(imp);estimated=addNutrients_(estimated,imp.estimated_total);}else{allEstimated=false;}
      });
      out.estimated_complete_total=allEstimated?estimated:null;
    }
    return out;
  });

  const complete=periodRecords.filter(r=>r.coverage_status==='complete');
  const incomplete=periodRecords.filter(r=>r.coverage_status!=='complete');
  const estimatedEligible=periodRecords.filter(r=>r.estimated_complete_total!==null);
  const recordedAvg=avgNutrients_(periodRecords.map(r=>r.recorded_total));
  const completeAvg=avgNutrients_(complete.map(r=>r.recorded_total));
  const estimatedAvg=avgNutrients_(estimatedEligible.map(r=>r.estimated_complete_total));
  const imputedDays=incomplete.filter(r=>r.estimated_complete_total!==null).length;

  return {
    days_recorded:periodRecords.length,
    complete_days:complete.length,
    incomplete_days:incomplete.length,
    imputed_complete_days:imputedDays,
    complete_day_average:completeAvg,
    recorded_all_days_average:recordedAvg,
    estimated_complete_day_average:estimatedAvg,
    daily_series:periodRecords,
    interpretation_rule:{
      priority:['complete recorded total','estimated complete total','incomplete recorded total as lower bound only'],
      incomplete_recorded_total_is_daily_intake:false,
      incomplete_recorded_total_meaning:'minimum_recorded_intake',
      imputation_is_source_data:false,
      imputation_method:'missing main meal -> same meal median within ±3 days, then ±7 days, then ±14 days',
      source_json_modified:false
    },
    data_quality:{
      complete_ratio:periodRecords.length?round_(complete.length/periodRecords.length,3):null,
      estimated_coverage_ratio:periodRecords.length?round_(estimatedEligible.length/periodRecords.length,3):null,
      note:'불완전 기록일의 recorded_total은 실제 하루 총섭취량으로 간주하지 않으며 complete-day 평균 계산에서 제외합니다. 추정치는 별도 estimated_complete_total로만 제공합니다.'
    }
  };
}

function dedupeCollectedFiles_(files) {
  const out=[];
  const seen={};
  (files||[]).forEach(x=>{
    // 같은 파일명·내부 최신시각·바이트 크기가 같은 재업로드본은 동일 raw로 간주합니다.
    const key=[x&&x.name||'',x&&x.timestamp||0,x&&x.size_bytes||0].join('|');
    if(seen[key])return;
    seen[key]=true;
    out.push(x);
  });
  return out;
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
    )
  };
}

function callOpenAI_(stats,latest,previousPlan,additionalRequest,baseline) {
  const key=getOpenAiKey_(); if(!key)throw new Error('스크립트 속성 OPENAI_API_KEY가 설정되지 않았습니다.');
  const schema={type:'object',additionalProperties:false,properties:{
    previous_plan_review:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},completion_rate:{type:['number','null']},completed:{type:'array',items:{type:'string'}},not_completed:{type:'array',items:{type:'string'}}},required:['summary','completion_rate','completed','not_completed']},
    overall_assessment:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},weight_status:{type:'string'},training_status:{type:'string'},recovery_status:{type:'string'},nutrition_status:{type:'string'},key_points:{type:'array',items:{type:'string'}}},required:['summary','weight_status','training_status','recovery_status','nutrition_status','key_points']},
    recovery_analysis:{type:'object',additionalProperties:false,properties:{status:{type:'string'},summary:{type:'string'},evidence:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}}},required:['status','summary','evidence','limitations']},
    nutrition_analysis:{type:'object',additionalProperties:false,properties:{status:{type:'string'},summary:{type:'string'},evidence:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}}},required:['status','summary','evidence','limitations']},
    ai_analysis:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},progress:{type:'array',items:{type:'string'}},concerns:{type:'array',items:{type:'string'}},recovery_status:{type:'string'},training_balance:{type:'string'}},required:['summary','progress','concerns','recovery_status','training_balance']},
    weight_loss_analysis:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},weight_trend:{type:'string'},activity_assessment:{type:'string'},weekly_targets:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}}},required:['summary','weight_trend','activity_assessment','weekly_targets','limitations']},
    next_plan:{type:'object',additionalProperties:false,properties:{period_days:{type:'integer'},weekly_goal:{type:'string'},daily_activity_target:{type:'object',additionalProperties:false,properties:{steps:{type:['integer','null']},cardio_minutes:{type:['integer','null']}},required:['steps','cardio_minutes']},sessions:{type:'array',items:{type:'object',additionalProperties:false,properties:{day_label:{type:'string'},focus:{type:'string'},exercises:{type:'array',items:{type:'object',additionalProperties:false,properties:{exercise:{type:'string'},record_type:{type:'string',enum:['weighted','bodyweight','timed']},sets:{type:'integer'},reps:{type:['integer','null']},seconds:{type:['integer','null']},suggested_weight_kg:{type:['number','null']},target_rpe:{type:['number','null']},reason:{type:'string'},pain_rule:{type:'string'}},required:['exercise','record_type','sets','reps','seconds','suggested_weight_kg','target_rpe','reason','pain_rule']}}},required:['day_label','focus','exercises']}},progression_rules:{type:'array',items:{type:'string'}},pain_rules:{type:'array',items:{type:'string'}}},required:['period_days','weekly_goal','daily_activity_target','sessions','progression_rules','pain_rules']},
    warnings:{type:'array',items:{type:'string'}}
  },required:['previous_plan_review','overall_assessment','recovery_analysis','nutrition_analysis','ai_analysis','weight_loss_analysis','next_plan','warnings']};

  const input={
    baseline:baseline||null,
    statistics:stats,
    previous_analysis:latest?{created_at:latest.created_at,overall_assessment:latest.overall_assessment||null,recovery_analysis:latest.recovery_analysis||null,nutrition_analysis:latest.nutrition_analysis||null,ai_analysis:latest.ai_analysis,weight_loss_analysis:latest.weight_loss_analysis}:null,
    previous_plan:previousPlan||null,
    additional_request:additionalRequest||'',
    required_flow:['이전 계획 이행 평가','종합 평가','현재 데이터 기반 회복 분석','영양 분석','운동 분석','체중감량 분석','다음 7일 계획']
  };
  const finalInstructions=[
    '당신은 한국어로 답하는 운동·영양·회복 통합 코치다.',
    '사용자의 목표는 체중감량을 우선하면서 근력 유지 또는 향상을 추구하는 것이다.',
    '제공된 측정값만 근거로 사용하고 의료 진단은 하지 않는다.',
    '종합 평가는 체중·운동·회복·영양을 서로 연결해서 판단하되, 근거가 부족한 영역은 제한사항을 명시한다.',
    '회복 규칙: statistics.recovery의 HRV, 안정시 심박, 수면, 수면중/일반 심박을 우선 사용하고 SpO2와 호흡수는 보조 근거로 사용한다. 단일 값보다 최근 3일·7일 및 이전 7일 비교를 우선한다. 수면 데이터가 희소하면 회복을 강하게 단정하지 않는다.',
    '영양 규칙: statistics.nutrition에서 complete 기록일의 recorded_total을 실제 하루 섭취량 근거로 최우선 사용한다. incomplete 기록일의 recorded_total은 최소 기록 섭취량(lower bound)일 뿐 실제 하루 총섭취량으로 간주하거나 complete-day 평균에 섞지 않는다.',
    '영양 추정 규칙: incomplete 기록일의 estimated_complete_total은 누락된 주식사에 대해 같은 meal_type의 근접 기록 중앙값으로 보정한 추정치다. 실제 기록과 추정치를 반드시 구분하고, 추정치를 사실처럼 표현하지 않는다. complete 실제값 > estimated_complete_total > incomplete recorded_total(lower bound) 순으로 신뢰한다.',
    '에너지 균형 규칙: Nutrition 데이터가 불완전하거나 추정 비율이 높으면 정확한 칼로리 적자량을 단정하지 않는다. 활동에너지와 기초에너지는 측정/추정 기반 참고값이며 정확한 TDEE로 단정하지 않는다.',
    '통증 기록을 최우선으로 반영한다. 허리 통증이나 악화 신호가 있으면 허리에 부담되는 동작을 제외하고 필요하면 휴식 또는 진료를 권고한다.',
    '현실적인 7일 운동 계획을 작성한다.',
    '고정 규칙: 7월 초의 실내 걷기와 최근의 실내 달리기 또는 실내 운동은 Apple Watch 운동명 선택 차이일 수 있으므로 운동명 변화 자체를 운동 방식 전환으로 해석하지 않는다. 거리, 시간, 페이스, 심박수, 케이던스, 활동칼로리 기준으로 같은 실내 유산소 흐름으로 비교한다.',
    '고정 규칙: 근력운동 수동 기록은 2026년 7월 20일부터 시작되었으므로 그 이전 근력운동 공백은 실제 운동 부재가 아니라 기록 누락 가능성으로 본다.',
    '유산소 세부 규칙: statistics.activity.cardio_summary.quality_sessions가 있으면 선택된 분석기간 전체의 분 단위 추정 스플릿, 심박수 영역, 케이던스, 운동 후 심박수 회복을 보조 근거로 사용한다.',
    '절대 운동강도 규칙: Fitness workout의 intensity_met를 세션 대표 절대강도(MET-equivalent)로 우선 사용하고, 없으면 같은 시간대 Health physical_effort 평균을 보조값으로 사용한다. 높은 MET 자체를 체력 향상으로 해석하지 않는다.',
    '체중 추세 규칙: statistics.body.body_trend의 7일 이동평균을 단일 체중값보다 우선한다.',
    '근력 세션 규칙: statistics.strength.daily_sessions의 날짜별 종목·중량·횟수·세트·RPE·통증 흐름을 다음 계획에 반영한다.',
    '데이터 품질 규칙: statistics.data_diagnosis와 각 영역 data_quality를 확인하고, 데이터가 희소하거나 누락되면 신뢰도 제한을 설명한다.',
    '허리둘레는 측정 위치·시간·자세에 따른 오차가 있으므로 단기 변화는 과도하게 해석하지 않는다.'
  ].join(' ');
  const payload={model:getOpenAiModel_(),store:false,instructions:finalInstructions,input:JSON.stringify(input),text:{format:{type:'json_schema',name:'integrated_health_analysis',strict:true,schema:schema}}};
  const response=UrlFetchApp.fetch('https://api.openai.com/v1/responses',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+key},payload:JSON.stringify(payload),muteHttpExceptions:true});
  const code=response.getResponseCode(); const body=response.getContentText();
  if(code<200||code>=300)throw new Error('OpenAI API 오류 '+code+': '+body.substring(0,500));
  const result=JSON.parse(body); const text=extractOutputText_(result); if(!text)throw new Error('OpenAI 응답에서 분석 JSON을 찾지 못했습니다.');
  return JSON.parse(text);
}

function extractOutputText_(result) {
  if(result.output_text)return result.output_text;
  const out=result.output||[];
  for(let i=0;i<out.length;i++)for(let j=0;j<(out[i].content||[]).length;j++){const c=out[i].content[j];if(c.type==='output_text'&&c.text)return c.text;}
  return '';
}

function getBaselineSummary_(){
  const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);
  const folders=root.getFoldersByName(BASELINE_FOLDER_NAME);
  if(!folders.hasNext())return null;
  const folder=folders.next();
  const files=folder.getFiles();
  let latest=null;
  while(files.hasNext()){
    const file=files.next();
    if(!/^baseline-.*\.json$/i.test(file.getName()))continue;
    try{
      const data=JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      if(!latest || file.getLastUpdated().getTime()>latest.modified){latest={modified:file.getLastUpdated().getTime(),data:data};}
    }catch(e){console.log('Baseline 읽기 실패: '+file.getName());}
  }
  return latest?latest.data:null;
}

function getLatestAnalysisResponse_(){const a=findLatestAnalysis_();return {ok:true,analysis:a||null};}
function saveAnalysis_(analysis){const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);const af=getOrCreateFolder_(root,ANALYSIS_FOLDER_NAME);const mf=getOrCreateFolder_(af,Utilities.formatDate(new Date(),TIME_ZONE,'yyyy-MM'));af.getName();mf.createFile(analysis.analysis_id+'.json',JSON.stringify(analysis,null,2),MimeType.PLAIN_TEXT);}
function findLatestAnalysis_(){const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);const fs=root.getFoldersByName(ANALYSIS_FOLDER_NAME);if(!fs.hasNext())return null;const arr=[];collectAnalysis_(fs.next(),arr);arr.sort((a,b)=>parseDate_(a.created_at).getTime()-parseDate_(b.created_at).getTime());return arr.length?arr[arr.length-1]:null;}
function collectAnalysis_(folder,arr){const files=folder.getFiles();while(files.hasNext()){const f=files.next();if(!/^analysis-.*\.json$/i.test(f.getName()))continue;try{arr.push(JSON.parse(f.getBlob().getDataAsString('UTF-8')));}catch(e){}}const subs=folder.getFolders();while(subs.hasNext())collectAnalysis_(subs.next(),arr);}

function collectJsonFiles_(folder,from,to,type){const arr=[];collectJsonFilesRecursive_(folder,from,to,type,arr);return arr;}
function collectJsonFilesRecursive_(folder,from,to,type,arr){const files=folder.getFiles();while(files.hasNext()){const f=files.next();if(!/\.json$/i.test(f.getName()))continue;if(type==='strength'&&!/^strength-.*\.json$/i.test(f.getName()))continue;if(type==='nutrition'&&!/^nutrition-.*\.json$/i.test(f.getName()))continue;try{const blob=f.getBlob();const data=JSON.parse(blob.getDataAsString('UTF-8'));const t=inferJsonTimestamp_(data,f);if(t>=from&&t<=to)arr.push({file_id:f.getId(),name:f.getName(),size_bytes:blob.getBytes().length,modified_at:formatIso_(f.getLastUpdated()),timestamp:t.getTime(),data:data});}catch(e){console.log('JSON 읽기 실패 '+f.getName()+': '+e);}}const subs=folder.getFolders();while(subs.hasNext()){const sf=subs.next();if(type==='strength'&&(sf.getName()===ANALYSIS_FOLDER_NAME||sf.getName()===BASELINE_FOLDER_NAME))continue;collectJsonFilesRecursive_(sf,from,to,type,arr);}}
function inferJsonTimestamp_(data,file){if(data&&data.date&&Array.isArray(data.meals))return parseDate_(String(data.date).slice(0,10)+'T23:59:59+09:00');if(data&&Array.isArray(data.exercises))return parseDate_(data.finished_at||data.started_at||file.getLastUpdated());const w=data&&data.data&&data.data.workouts;if(w&&w.length)return parseDate_(w[w.length-1].end||w[w.length-1].start||file.getLastUpdated());const m=data&&data.data&&data.data.metrics;if(m){let latest=0;m.forEach(x=>(x.data||[]).forEach(v=>{const t=parseDate_(v.date).getTime();if(t>latest)latest=t;}));if(latest)return new Date(latest);}const match=file.getName().match(/(20\d{2})-(\d{2})-(\d{2})/);if(match)return new Date(match[1]+'-'+match[2]+'-'+match[3]+'T23:59:59+09:00');return file.getLastUpdated();}
function newestTimestamp_(arr){return arr.length?Math.max.apply(null,arr.map(x=>x.timestamp||0)):0;}
function collectStrengthRecords_(folder,sessions) {
  const files = folder.getFiles();

  while (files.hasNext()) {
    const f = files.next();
    if (!/^strength-.*\.json$/i.test(f.getName())) continue;

    try {
      const d = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
      if (d && Array.isArray(d.exercises)) {
        d.drive_file_id = f.getId();
        d.drive_file_name = f.getName();
        d.drive_file_updated_at = formatIso_(f.getLastUpdated());
        sessions.push(d);
      }
    } catch (e) {
      console.log('근력운동 기록 읽기 실패 ' + f.getName() + ': ' + e);
    }
  }

  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sf = subs.next();
    if (
      sf.getName() !== ANALYSIS_FOLDER_NAME &&
      sf.getName() !== BASELINE_FOLDER_NAME
    ) {
      collectStrengthRecords_(sf, sessions);
    }
  }
}

function deleteStrengthFile_(fileId) {
  if (!fileId) {
    throw new Error('삭제할 Drive 파일 ID가 없습니다.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const root = DriveApp.getFolderById(STRENGTH_FOLDER_ID);
    const file = findStrengthFileById_(root, String(fileId));

    if (!file) {
      throw new Error('근력운동 폴더에서 해당 파일을 찾을 수 없습니다.');
    }

    if (!/^strength-.*\.json$/i.test(file.getName())) {
      throw new Error('근력운동 기록 JSON 파일만 삭제할 수 있습니다.');
    }

    const deletedFileName = file.getName();

    // 원본 삭제가 성공한 뒤에만 조회용 인덱스에서 해당 Drive 파일 ID를 제거합니다.
    file.setTrashed(true);
    removeStrengthIndexByFileId_(root, String(fileId));

    return {
      ok: true,
      file_id: String(fileId),
      file_name: deletedFileName
    };
  } finally {
    lock.releaseLock();
  }
}

function findStrengthFileById_(folder, targetFileId) {
  const files = folder.getFiles();

  while (files.hasNext()) {
    const file = files.next();
    if (file.getId() === targetFileId) {
      return file;
    }
  }

  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();

    if (
      sub.getName() === ANALYSIS_FOLDER_NAME ||
      sub.getName() === BASELINE_FOLDER_NAME
    ) {
      continue;
    }

    const found = findStrengthFileById_(sub, targetFileId);
    if (found) return found;
  }

  return null;
}
function getSessionTimestamp_(s){return parseDate_(s.finished_at||s.started_at||s.created_at||s.date||0).getTime();}
function getOrCreateFolder_(parent,name){const f=parent.getFoldersByName(name);return f.hasNext()?f.next():parent.createFolder(name);}
function getOpenAiKey_(){return PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY')||'';}
function getOpenAiModel_(){return PropertiesService.getScriptProperties().getProperty('OPENAI_MODEL')||'gpt-5-mini';}
function parseDate_(v){if(v instanceof Date)return v;let s=String(v||'');if(!s)return new Date(0);s=s.replace(/ (\+\d{4})$/,' $1').replace(/ ([+-]\d{2})(\d{2})$/,' $1:$2');const d=new Date(s);return isNaN(d.getTime())?new Date(0):d;}
function normalizeAnalysisFrom_(value, fallback, now){const raw=String(value||'').trim();const parsed=raw?parseDate_(raw+(raw.length===10?'T00:00:00+09:00':'')):parseDate_(fallback);let d=startOfDay_(parsed.getTime()>0?parsed:fallback);const today=startOfDay_(now);if(d>today)d=today;return d;}
function formatIso_(d){return Utilities.formatDate(parseDate_(d),TIME_ZONE,"yyyy-MM-dd'T'HH:mm:ssXXX");}
function startOfDay_(d){const x=new Date(parseDate_(d).getTime());x.setHours(0,0,0,0);return x;}
function addDays_(d,n){const x=new Date(parseDate_(d).getTime());x.setDate(x.getDate()+n);return x;}
function sum_(a){return (a||[]).reduce((s,v)=>s+(isFinite(Number(v))?Number(v):0),0);}
function avg_(a){const b=(a||[]).filter(v=>isFinite(Number(v))).map(Number);return b.length?sum_(b)/b.length:null;}
function round_(v,n){if(v===null||v===undefined||!isFinite(Number(v)))return null;const p=Math.pow(10,n||0);return Math.round(Number(v)*p)/p;}
function num_(v){return isFinite(Number(v))?round_(Number(v),1):null;}

/**
 * 최초 1회 Apps Script 편집기에서 직접 실행해 외부 API 호출 권한을 승인합니다.
 * 실행 후 권한 승인 창에서 허용하고 웹 앱을 새 버전으로 재배포하세요.
 */
function authorizeOpenAIConnection() {
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
