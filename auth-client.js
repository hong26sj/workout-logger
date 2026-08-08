(() => {
  const TOKEN_KEY = 'workoutLoggerAuthToken';
  const TOKEN_EXPIRES_KEY = 'workoutLoggerAuthExpiresAt';

  function gasUrl() {
    try {
      if (typeof getGasUrl === 'function') return getGasUrl();
    } catch (_) {}
    try {
      return localStorage.getItem('gasUrl') || (typeof DEFAULT_GAS_URL !== 'undefined' ? DEFAULT_GAS_URL : '');
    } catch (_) { return ''; }
  }

  function token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXPIRES_KEY);
  }

  async function post(payload, includeAuth = true) {
    const url = gasUrl();
    if (!url) throw new Error('Google Apps Script URL이 설정되지 않았습니다.');
    const body = Object.assign({}, payload || {});
    if (includeAuth && token()) body.auth_token = token();
    const response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'text/plain;charset=utf-8'},
      body: JSON.stringify(body),
      redirect: 'follow'
    });
    const result = await response.json();
    if (result && (result.error_code === 'UNAUTHORIZED' || result.error === 'UNAUTHORIZED')) {
      clearAuth();
      showLogin();
      throw new Error('인증이 만료되었습니다. 비밀번호를 다시 입력하세요.');
    }
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

  function showLogin(message) {
    const gate = document.getElementById('authGate');
    const app = document.getElementById('appRoot');
    if (gate) gate.classList.remove('hidden');
    if (app) app.classList.add('auth-hidden');
    const status = document.getElementById('authStatus');
    if (status) status.textContent = message || '';
    setTimeout(() => document.getElementById('authPin')?.focus(), 50);
  }

  function showApp() {
    document.getElementById('authGate')?.classList.add('hidden');
    document.getElementById('appRoot')?.classList.remove('auth-hidden');
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
      if (!result || !result.ok || !result.auth_token) throw new Error(result?.error || '인증에 실패했습니다.');
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
          return originalFetch(input, options);
        }
        if (method === 'GET') {
          const parsedUrl = new URL(url, location.href);
          const action = parsedUrl.searchParams.get('action');
          if (action === 'list' || action === 'latest_analysis') {
            return originalFetch(target, {
              method:'POST',
              headers:{'Content-Type':'text/plain;charset=utf-8'},
              body:JSON.stringify({action:action, auth_token:token()}),
              redirect:'follow'
            });
          }
        }
      }
    } catch (_) {}
    return originalFetch(input, init);
  };

  window.workoutAuth = {post, token, clearAuth, showLogin, showApp};

  document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('authLoginBtn')?.addEventListener('click', login);
    document.getElementById('authPin')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); login(); }
    });
    const valid = await verify();
    if (valid) showApp(); else showLogin();
  });
})();
