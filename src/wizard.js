'use strict';

// Native generation wizard: project → local Figma (optional) → generate → download.
// Everything talks to the Think A.M. API from the main process — the site is
// never embedded.

const api = window.thinkam;
const el = (id) => document.getElementById(id);

const ui = {
  back: el('back-btn'),
  acctLine: el('acct-line'),
  gate: el('gate'),
  gateTitle: el('gate-title'),
  gateMsg: el('gate-msg'),
  gateCta: el('gate-cta'),
  projectCard: el('project-card'),
  projName: el('projName'),
  projDesc: el('projDesc'),
  modeTemplate: el('mode-template'),
  modeStarter: el('mode-starter'),
  modeHint: el('mode-hint'),
  figmaCard: el('figma-card'),
  nodeId: el('nodeId'),
  figmaDot: el('figma-dot'),
  figmaText: el('figma-text'),
  extractBtn: el('extract-btn'),
  routesWrap: el('routes-wrap'),
  routesList: el('routes-list'),
  aiCard: el('ai-card'),
  provider: el('provider'),
  provOpenai: el('prov-openai'),
  provAnthropic: el('prov-anthropic'),
  provBedrock: el('prov-bedrock'),
  runCard: el('run-card'),
  generateBtn: el('generate-btn'),
  progress: el('progress'),
  genDot: el('gen-dot'),
  genText: el('gen-text'),
  result: el('result'),
  downloadBtn: el('download-btn'),
  resultHint: el('result-hint'),
  runError: el('run-error'),
  version: el('version'),
  siteLink: el('site-link'),
};

let outputMode = 'template';
let routeCandidates = []; // { id, name, route, included }
let jobTimer = null;
let lastDownloadUrl = null;

const setDot = (dot, state) => { dot.className = 'dot' + (state ? ' ' + state : ''); };

function slugify(value) {
  return String(value || '')
    .trim()
    .replace(/^\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

function setOutputMode(mode) {
  outputMode = mode;
  ui.modeTemplate.classList.toggle('active', mode === 'template');
  ui.modeStarter.classList.toggle('active', mode === 'starter-kit');
  ui.modeHint.textContent = mode === 'template'
    ? 'Geração completa via pipeline de IA, parametrizada pelo seu design.'
    : 'Projeto Angular pré-construído com Keycloak, dashboard e CRUDs — personalizado com o nome do seu projeto.';
}

function showError(message) {
  ui.runError.hidden = !message;
  ui.runError.textContent = message || '';
}

// --- local Figma extraction ---------------------------------------------------

function renderRoutes() {
  ui.routesList.innerHTML = '';
  for (const candidate of routeCandidates) {
    const li = document.createElement('li');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = candidate.included;
    check.addEventListener('change', () => { candidate.included = check.checked; });

    const name = document.createElement('span');
    name.className = 'route-name';
    name.textContent = candidate.name;
    name.title = candidate.name;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = candidate.route;
    input.spellcheck = false;
    input.addEventListener('input', () => { candidate.route = slugify(input.value); });
    input.addEventListener('blur', () => { input.value = candidate.route; });

    li.append(check, name, input);
    ui.routesList.appendChild(li);
  }
  ui.routesWrap.hidden = routeCandidates.length === 0;
}

async function extractFromFigma() {
  showError('');
  setDot(ui.figmaDot, 'loading');
  ui.figmaText.textContent = 'Conectando ao Figma MCP local…';
  ui.extractBtn.disabled = true;
  try {
    const conn = await api.figmaConnect();
    if (!conn.ok) {
      setDot(ui.figmaDot, conn.reason === 'upgrade' ? 'warn' : 'bad');
      ui.figmaText.textContent = conn.error || 'Não foi possível conectar ao Figma MCP local.';
      return;
    }
    const tool = conn.preferred || (conn.tools && conn.tools[0] && conn.tools[0].name);
    if (!tool) {
      setDot(ui.figmaDot, 'bad');
      ui.figmaText.textContent = 'O Figma MCP local não expôs ferramentas de extração.';
      return;
    }

    ui.figmaText.textContent = 'Extraindo design context…';
    const args = {};
    const node = ui.nodeId.value.trim();
    if (node) args.nodeId = node;
    const extraction = await api.figmaExtract(tool, args);
    if (!extraction.ok) {
      setDot(ui.figmaDot, 'bad');
      ui.figmaText.textContent = 'Falha na extração: ' + (extraction.error || 'erro desconhecido');
      return;
    }

    ui.figmaText.textContent = 'Analisando rotas e componentes…';
    const analyzed = await api.genAnalyze(extraction.result, ui.projName.value.trim() || 'project');
    if (!analyzed.ok || !analyzed.analysis) {
      setDot(ui.figmaDot, 'bad');
      ui.figmaText.textContent = 'Falha na análise: ' + (analyzed.error || 'erro desconhecido');
      return;
    }

    const analysis = analyzed.analysis;
    const screens = (analysis.screens || []).filter((s) => s.kind === 'route');
    if (screens.length) {
      routeCandidates = screens.map((s, i) => ({
        id: s.id || `route-${i}`,
        name: s.name || s.route || `Tela ${i + 1}`,
        route: slugify(s.route || (analysis.routes && analysis.routes[i]) || s.name),
        included: true,
      }));
    } else {
      routeCandidates = (analysis.routes || []).map((r, i) => ({
        id: `route-${i}`,
        name: r,
        route: slugify(r),
        included: true,
      }));
    }
    renderRoutes();

    setDot(ui.figmaDot, 'ok');
    ui.figmaText.textContent = routeCandidates.length
      ? `Design extraído — ${routeCandidates.length} rota(s) inferida(s).`
      : 'Design extraído. Nenhuma rota inferida — o scaffold padrão será usado.';
  } finally {
    ui.extractBtn.disabled = false;
  }
}

// --- provider (BYOK) ----------------------------------------------------------

function syncProviderFields() {
  const p = ui.provider.value;
  ui.provOpenai.classList.toggle('hidden', p !== 'openai-compatible');
  ui.provAnthropic.classList.toggle('hidden', p !== 'anthropic');
  ui.provBedrock.classList.toggle('hidden', p !== 'bedrock');
}

// --- generation ---------------------------------------------------------------

function buildRequest() {
  const provider = ui.provider.value || null;
  const routes = routeCandidates.filter((c) => c.included && c.route).map((c) => c.route);
  return {
    projectName: ui.projName.value.trim(),
    description: ui.projDesc.value.trim() || null,
    framework: 'angular',
    components: [],
    technologies: [],
    projectType: 'web-app',
    outputMode,
    customRoutes: routes.length ? routes : null,
    llmProvider: provider,
    openaiBaseUrl: provider === 'openai-compatible' ? el('openaiBaseUrl').value.trim() || null : null,
    openaiModel: provider === 'openai-compatible' ? el('openaiModel').value.trim() || null : null,
    openaiApiKey: provider === 'openai-compatible' ? el('openaiKey').value || null : null,
    anthropicApiKey: provider === 'anthropic' ? el('anthropicKey').value || null : null,
    anthropicModel: provider === 'anthropic' ? el('anthropicModel').value : null,
    bedrockRegion: provider === 'bedrock' ? el('bedrockRegion').value.trim() || null : null,
    bedrockAccessKeyId: provider === 'bedrock' ? el('bedrockKeyId').value || null : null,
    bedrockSecretAccessKey: provider === 'bedrock' ? el('bedrockSecret').value || null : null,
    bedrockModel: provider === 'bedrock' ? el('bedrockModel').value : null,
  };
}

function stopPolling() {
  if (jobTimer) { clearInterval(jobTimer); jobTimer = null; }
}

function showResult(downloadUrl) {
  lastDownloadUrl = downloadUrl;
  setDot(ui.genDot, 'ok');
  ui.genText.textContent = 'Projeto gerado com sucesso.';
  ui.result.hidden = false;
  ui.generateBtn.disabled = false;
  ui.generateBtn.textContent = 'Gerar novamente';
}

function failGeneration(message) {
  stopPolling();
  setDot(ui.genDot, 'bad');
  ui.genText.textContent = 'Geração falhou.';
  showError(message || 'Erro desconhecido na geração.');
  ui.generateBtn.disabled = false;
  ui.generateBtn.textContent = 'Tentar novamente';
}

function pollJob(jobId) {
  stopPolling();
  jobTimer = setInterval(async () => {
    const r = await api.genJob(jobId);
    if (!r.ok) { failGeneration(r.error); return; }
    if (r.progress) ui.genText.textContent = r.progress;
    const status = String(r.status || '').toLowerCase();
    if (status === 'completed' || status === 'completed_with_warnings') {
      stopPolling();
      if (r.downloadUrl) showResult(r.downloadUrl);
      else failGeneration('Geração concluída, mas sem arquivo para download.');
    } else if (status === 'failed') {
      failGeneration(r.error || 'A geração falhou no servidor.');
    }
  }, 5000);
}

async function generate() {
  const name = ui.projName.value.trim();
  if (!name) {
    showError('Dê um nome ao projeto antes de gerar.');
    ui.projName.focus();
    return;
  }

  showError('');
  ui.result.hidden = true;
  ui.progress.hidden = false;
  setDot(ui.genDot, 'loading');
  ui.genText.textContent = 'Enviando para geração…';
  ui.generateBtn.disabled = true;
  ui.generateBtn.textContent = 'Gerando…';

  const r = await api.genGenerate(buildRequest());
  if (!r.ok) { failGeneration(r.error); return; }

  if (r.async && r.jobId) {
    ui.genText.textContent = 'Geração em andamento…';
    pollJob(r.jobId);
  } else if (r.downloadUrl) {
    showResult(r.downloadUrl);
  } else {
    failGeneration('Resposta inesperada do servidor.');
  }
}

async function download() {
  if (!lastDownloadUrl) return;
  ui.downloadBtn.disabled = true;
  ui.downloadBtn.textContent = 'Baixando…';
  try {
    const r = await api.genDownload(lastDownloadUrl);
    if (r.ok) {
      ui.resultHint.textContent = `Salvo em ${r.path}`;
    } else {
      showError(r.error || 'Falha no download.');
    }
  } finally {
    ui.downloadBtn.disabled = false;
    ui.downloadBtn.textContent = 'Baixar projeto (.zip)';
  }
}

// --- init ---------------------------------------------------------------------

async function init() {
  ui.back.addEventListener('click', () => api.navigate('launcher'));
  ui.gateCta.addEventListener('click', () => api.navigate('launcher'));
  ui.modeTemplate.addEventListener('click', () => setOutputMode('template'));
  ui.modeStarter.addEventListener('click', () => setOutputMode('starter-kit'));
  ui.extractBtn.addEventListener('click', extractFromFigma);
  ui.provider.addEventListener('change', syncProviderFields);
  ui.generateBtn.addEventListener('click', generate);
  ui.downloadBtn.addEventListener('click', download);
  ui.siteLink.addEventListener('click', (e) => { e.preventDefault(); api.openExternal('https://tbldr.com.br'); });

  try { ui.version.textContent = 'v' + (await api.getVersion()); } catch { /* keep placeholder */ }

  const auth = await api.getAuth();
  if (!auth || !auth.user) {
    ui.gate.hidden = false;
    return;
  }

  ui.acctLine.textContent = (auth.user.email || auth.user.name || 'Conta') + (auth.architect ? ' · Architect' : '');
  ui.projectCard.hidden = false;
  ui.figmaCard.hidden = false;
  ui.aiCard.hidden = false;
  ui.runCard.hidden = false;
}

init();
