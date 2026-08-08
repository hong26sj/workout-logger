(() => {
  const TOKEN_KEY = 'workoutLoggerAuthToken';
  const TOKEN_EXPIRES_KEY = 'workoutLoggerAuthExpiresAt';

  function gasUrl() {
    try {
      if (typeof getGasUrl === 'function') return getGasUrl();
    } catch (_) {}
    try {
      return (localStorage.getItem('gasUrl') || '').trim();
    } catch (_) { return ''; }
  }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; }
    catch (_) { return ''; }
  }

  function clearAuth() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_EXPIRES_KEY);
    } catch (_) {}
  }

  function showLogin(message) {
    document.getElementById('authGate')?.classList.remove('hidden');
    document.getElementById('appRoot')?.classList.add('auth-hidden');
    const status = document.getElementById('authStatus');
    if (status) status.textContent = message || '';
    setTimeout(() => document.getElementById('authPin')?.focus(), 50);
  }

  function showApp() {
    document.getElementById('authGate')?.classList.add('hidden');
    document.getElementById('appRoot')?.classList.remove('auth-hidden');
  }

  async function readJsonResponse(response) {
    const result = await response.clone().json().catch(() => null);
    if (result && (result.error_code === 'UNAUTHORIZED' || result.error === 'UNAUTHORIZED')) {
      clearAuth();
      showLogin('인증이 만료되었습니다. 숫자 비밀번호를 다시 입력하세요.');
    }
    return result;
  }

  async function post(payload, includeAuth = true) {
    const url = gasUrl();
    if (!url) throw new Error('Google Apps Script URL이 설정되지 않았습니다.');
    const body = Object.assign({}, payload || {});
    if (includeAuth && token()) body.auth_token = token();
    const response = await originalFetch(url, {
      method: 'POST',
      headers: {'Content-Type':'text/plain;charset=utf-8'},
      body: JSON.stringify(body),
      redirect: 'follow'
    });
    const result = await readJsonResponse(response);
    if (!result) throw new Error('서버 응답을 확인할 수 없습니다.');
    return result;
  }

  async function verify() {
    if (!token()) return false;
    try {
      const result = await post({action:'auth_check'});
      return !!(result && result.ok);
    } catch (_) {
      return false;
    }
  }

  async function login() {
    const pinInput = document.getElementById('authPin');
    const button = document.getElementById('authLoginBtn');
    const status = document.getElementById('authStatus');
    const pin = String(pinInput?.value || '').trim();

    if (!/^\d{6,12}$/.test(pin)) {
      if (status) status.textContent = '비밀번호는 숫자 6~12자리로 입력하세요.';
      return;
    }

    button.disabled = true;
    if (status) status.textContent = '인증 중…';
    try {
      const result = await post({action:'login', password:pin}, false);
      if (!result || !result.ok || !result.auth_token) {
        const remain = result && Number.isFinite(Number(result.retry_after_seconds))
          ? ` (${Math.ceil(Number(result.retry_after_seconds) / 60)}분 후 재시도)`
          : '';
        throw new Error((result?.error || '인증에 실패했습니다.') + remain);
      }
      localStorage.setItem(TOKEN_KEY, result.auth_token);
      localStorage.setItem(TOKEN_EXPIRES_KEY, result.expires_at || '');
      pinInput.value = '';
      showApp();
      location.reload();
    } catch (error) {
      if (status) status.textContent = error.message || String(error);
    } finally {
      button.disabled = false;
    }
  }

  function logout() {
    clearAuth();
    showLogin('이 기기의 인증을 해제했습니다.');
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function(input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const target = gasUrl();
      if (target && url && String(url).startsWith(target)) {
        const options = Object.assign({}, init || {});
        const method = String(options.method || 'GET').toUpperCase();

        if (method === 'POST' && options.body) {
          try {
            const parsed = JSON.parse(options.body);
            if (parsed.action !== 'login' && token()) parsed.auth_token = token();
            options.body = JSON.stringify(parsed);
          } catch (_) {}
          const response = await originalFetch(input, options);
          await readJsonResponse(response);
          return response;
        }

        if (method === 'GET') {
          const parsedUrl = new URL(url, location.href);
          const action = parsedUrl.searchParams.get('action');
          if (action === 'list' || action === 'latest_analysis') {
            const response = await originalFetch(target, {
              method:'POST',
              headers:{'Content-Type':'text/plain;charset=utf-8'},
              body:JSON.stringify({action:action, auth_token:token()}),
              redirect:'follow'
            });
            await readJsonResponse(response);
            return response;
          }
        }
      }
    } catch (_) {}
    return originalFetch(input, init);
  };

  window.workoutAuth = {post, token, clearAuth, showLogin, showApp, logout};

  document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('authLoginBtn')?.addEventListener('click', login);
    document.getElementById('authPin')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        login();
      }
    });
    document.getElementById('authLogoutBtn')?.addEventListener('click', event => {
      event.preventDefault();
      logout();
    });

    const valid = await verify();
    if (valid) showApp();
    else showLogin();
  });
})();
