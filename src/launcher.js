'use strict';

const api = window.thinkam;

const el = (id) => document.getElementById(id);
const els = {
  envProd: el('env-prod'),
  envCustom: el('env-custom'),
  customFields: el('custom-fields'),
  apiUrl: el('apiUrl'),
  appUrl: el('appUrl'),
  apiDot: el('api-dot'),
  apiText: el('api-text'),
  figmaDot: el('figma-dot'),
  figmaText: el('figma-text'),
  testBtn: el('test-btn'),
  figmaBtn: el('figma-btn'),
  openBtn: el('open-btn'),
  bridgeBtn: el('bridge-btn'),
  version: el('version'),
  siteLink: el('site-link'),
  // account
  loggedOut: el('logged-out'),
  loggedIn: el('logged-in'),
  email: el('email'),
  password: el('password'),
  loginBtn: el('login-btn'),
  loginMsg: el('login-msg'),
  logoutBtn: el('logout-btn'),
  acctEmail: el('acct-email'),
  acctPlan: el('acct-plan'),
  planHint: el('plan-hint'),
};

const PROD = { apiUrl: 'https://api.tbldr.com.br', appUrl: 'https://tbldr.com.br' };
let custom = false;

function setDot(dot, state) {
  dot.className = 'dot' + (state ? ' ' + state : '');
}

function currentUrls() {
  if (custom) {
    return {
      apiUrl: (els.apiUrl.value || PROD.apiUrl).trim(),
      appUrl: (els.appUrl.value || PROD.appUrl).trim(),
    };
  }
  return { ...PROD };
}

function setMode(isCustom) {
  custom = isCustom;
  els.envProd.classList.toggle('active', !isCustom);
  els.envCustom.classList.toggle('active', isCustom);
  els.customFields.classList.toggle('hidden', !isCustom);
}

async function testApi() {
  const { apiUrl } = currentUrls();
  setDot(els.apiDot, 'loading');
  els.apiText.textContent = 'API: verificando…';
  els.testBtn.disabled = true;
  try {
    const r = await api.checkApi(apiUrl);
    if (r.ok) {
      setDot(els.apiDot, 'ok');
      els.apiText.textContent = `API online (${r.ms} ms)`;
    } else {
      setDot(els.apiDot, 'bad');
      els.apiText.textContent = `API indisponível${r.status ? ' (HTTP ' + r.status + ')' : ''}`;
    }
  } catch {
    setDot(els.apiDot, 'bad');
    els.apiText.textContent = 'API indisponível';
  } finally {
    els.testBtn.disabled = false;
  }
}

async function checkFigma() {
  setDot(els.figmaDot, 'loading');
  els.figmaText.textContent = 'Ponte Figma local: verificando…';
  els.figmaBtn.disabled = true;
  try {
    const r = await api.checkFigmaBridge();
    if (r.reachable) {
      setDot(els.figmaDot, 'ok');
      els.figmaText.textContent = `Figma desktop detectado (porta ${r.port})`;
    } else {
      setDot(els.figmaDot, 'warn');
      els.figmaText.textContent = `Figma desktop não detectado (porta ${r.port})`;
    }
  } finally {
    els.figmaBtn.disabled = false;
  }
}

async function openApp() {
  const urls = currentUrls();
  await api.setConfig(urls);
  els.openBtn.disabled = true;
  els.openBtn.textContent = 'Abrindo…';
  await api.openApp(urls.appUrl);
}

function renderAuth(auth) {
  const loggedIn = !!(auth && auth.user);
  els.loggedOut.hidden = loggedIn;
  els.loggedIn.hidden = !loggedIn;
  if (!loggedIn) return;
  const u = auth.user;
  els.acctEmail.textContent = u.email || u.name || 'Conta';
  if (auth.architect) {
    els.acctPlan.textContent = 'Architect';
    els.acctPlan.className = 'badge badge--architect';
    els.planHint.textContent = 'Plano Architect ativo — ponte Figma local liberada.';
  } else {
    els.acctPlan.textContent = 'Free';
    els.acctPlan.className = 'badge badge--free';
    els.planHint.textContent = 'A ponte Figma local é exclusiva do plano Architect. Faça upgrade para usar.';
  }
}

async function login() {
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email || !password) return;
  els.loginBtn.disabled = true;
  els.loginBtn.textContent = 'Entrando…';
  els.loginMsg.textContent = '';
  try {
    const r = await api.login(email, password);
    if (r.ok) {
      els.password.value = '';
      renderAuth(r);
    } else {
      els.loginMsg.textContent = r.error || 'Falha no login.';
    }
  } finally {
    els.loginBtn.disabled = false;
    els.loginBtn.textContent = 'Entrar';
  }
}

async function logout() {
  await api.logout();
  renderAuth(null);
}

async function init() {
  const cfg = await api.getConfig();
  els.apiUrl.value = cfg.apiUrl || PROD.apiUrl;
  els.appUrl.value = cfg.appUrl || PROD.appUrl;
  const isCustom = cfg.apiUrl !== PROD.apiUrl || cfg.appUrl !== PROD.appUrl;
  setMode(isCustom);

  els.envProd.addEventListener('click', () => setMode(false));
  els.envCustom.addEventListener('click', () => setMode(true));
  els.testBtn.addEventListener('click', testApi);
  els.figmaBtn.addEventListener('click', checkFigma);
  els.openBtn.addEventListener('click', openApp);
  els.bridgeBtn.addEventListener('click', () => api.navigate('bridge'));
  els.loginBtn.addEventListener('click', login);
  els.logoutBtn.addEventListener('click', logout);
  els.password.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  els.siteLink.addEventListener('click', (e) => {
    e.preventDefault();
    api.openExternal('https://tbldr.com.br');
  });

  // Reflect stored login state.
  renderAuth(await api.getAuth());

  // Auto-probe on load so the user sees status immediately.
  testApi();
}

init();
