/** Workout Logger - Apps Script entrypoint/config. All five files belong in one Apps Script project. */
// Deployment rollback trigger only; no runtime logic change.

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

const TIME_ZONE = 'Asia/Seoul';
const INITIAL_LOOKBACK_DAYS = 28;
const OVERLAP_DAYS = 1;
const ANALYSIS_FOLDER_NAME = 'Analysis';
const BASELINE_FOLDER_NAME = 'Baseline';
const STRENGTH_INDEX_FILE_NAME_ = 'recent-strength-index.json';
const STRENGTH_INDEX_SCHEMA_VERSION_ = 1;
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const requestId=Utilities.getUuid().slice(0,8);
  const requestStarted=Date.now();
  let requestAction='unknown';
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('전송된 데이터가 없습니다.');
    }

    const data = JSON.parse(e.postData.contents);
    const action = String(data && data.action || '');
    requestAction=action||'save_strength';

    if (action === 'login') {
      return jsonResponse(login_(String(data.password || '')));
    }

    const auth = verifyAuthToken_(data && data.auth_token);
    if (!auth.ok){
      console.warn(JSON.stringify({event:'auth_denied',request_id:requestId,action:requestAction,reason:auth.error_code}));
      return jsonResponse(auth);
    }

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

    // 사용자가 Drive에 직접 추가한 strength-*.json까지 원본 기준으로 다시 색인합니다.
    // 일반 list는 빠른 인덱스 조회를 유지하고, 사용자가 명시적으로 Drive 새로고침을
    // 실행했을 때만 전체 스캔이 발생하도록 별도 action으로 분리합니다.
    if (action === 'rebuild_strength_index') {
      const index = rebuildStrengthIndex_();
      return jsonResponse({
        ok: true,
        count: Number(index && index.session_count || 0),
        index_updated_at: index && index.updated_at || null
      });
    }

    if (action === 'latest_analysis') {
      return jsonResponse(getLatestAnalysisResponse_());
    }

    // Chunked client-driven job: avoids six-minute synchronous doPost execution.
    if (action === 'analyze_start') {
      return jsonResponse(startAiJob_(data.additional_request||'',data.force===true,data.analysis_from||'',data.analysis_from_manual===true));
    }
    if (action === 'analysis_status') return jsonResponse(listAiJobStatus_(data.job_id||''));
    if (action === 'analysis_step') return jsonResponse(stepAiJob_(data.job_id||''));

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
    console.error(JSON.stringify({event:'post_error',request_id:requestId,action:requestAction,elapsed_ms:Date.now()-requestStarted,error:String(error&&error.message||error).slice(0,180)}));
    return jsonResponse({
      ok: false,
      error_code: 'SERVER_ERROR',
      request_id:requestId,
      error: String(error && error.message ? error.message : error)
    });
  }
}

function doGet(e) {
  return jsonResponse({
    ok: true,
    message: 'Workout Logger API is running.',
    authentication_required: true
  });
}
