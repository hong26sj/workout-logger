/** Workout Logger - authentication, token, and AI quota controls. */

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
