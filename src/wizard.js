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
  detectHint: el('detect-hint'),
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
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents: Redefinição → Redefinicao
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

// Pulls raw text out of an MCP tool result ({ content: [{type:'text', text}] }).
function mcpResultText(result) {
  const parts = (result && result.content) || [];
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

const FRAME_TYPES = /^(frame|component|component[-_]set|instance)$/i;

// Accepts a raw node id ("48557:657" / "48557-657") or a full Figma URL with
// ?node-id=…; returns the id normalized to colon form, or '' when absent.
function normalizeNodeId(value) {
  const raw = (value || '').trim();
  if (!raw) return '';
  const urlMatch = raw.match(/node-id=([0-9]+[-:][0-9]+)/i);
  const candidate = urlMatch ? urlMatch[1] : raw;
  const idMatch = candidate.match(/^([0-9]+)[-:]([0-9]+)$/);
  return idMatch ? `${idMatch[1]}:${idMatch[2]}` : '';
}

// Walks a parsed JSON node tree collecting top-level screen frames
// (frames whose ancestors contain no other frame).
function collectScreensFromJson(node, insideFrame, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectScreensFromJson(item, insideFrame, out);
    return;
  }
  const type = String(node.type || '');
  const isFrame = FRAME_TYPES.test(type);
  if (isFrame && !insideFrame && node.name) {
    out.push({ id: node.id || null, name: String(node.name) });
  }
  const children = node.children || node.nodes || null;
  if (children) collectScreensFromJson(children, insideFrame || isFrame, out);
}

// Scans XML-ish markup with a tag tokenizer (no DOM needed), collecting
// top-level screen frames: frame-like tags with no frame-like ancestor.
function collectScreensFromMarkup(markup, out) {
  const tagRe = /<(\/?)([a-zA-Z0-9_-]+)((?:\s+[a-zA-Z0-9_-]+="[^"]*")*)\s*(\/?)>/g;
  const attrRe = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  const stack = []; // true when the open element is frame-like
  let rootTag = null;
  let match;
  while ((match = tagRe.exec(markup)) !== null) {
    const [, closing, tag, attrs, selfClosing] = match;
    if (closing) { stack.pop(); continue; }
    if (rootTag === null) rootTag = tag.toLowerCase();

    let name = null;
    let id = null;
    let type = '';
    let attrMatch;
    attrRe.lastIndex = 0;
    while ((attrMatch = attrRe.exec(attrs)) !== null) {
      if (attrMatch[1] === 'name') name = attrMatch[2];
      else if (attrMatch[1] === 'id') id = attrMatch[2];
      else if (attrMatch[1] === 'type') type = attrMatch[2];
    }

    const isFrame = FRAME_TYPES.test(tag) || FRAME_TYPES.test(type);
    const insideFrame = stack.some(Boolean);
    if (isFrame && !insideFrame && name) out.push({ id, name });
    if (!selfClosing) stack.push(isFrame);
  }
  return rootTag;
}

// Parses a get_metadata payload into { rootTag, screens }. The MCP prefixes
// the XML with a text preamble ("Currently selected nodes: …"), so the markup
// is located anywhere in the text — never assume it starts at position 0.
function parseScreens(text) {
  const raw = (text || '').trim();
  if (!raw) return { rootTag: null, screens: [] };

  const out = [];
  let rootTag = null;

  const jsonStart = raw.search(/[{[]/);
  if (jsonStart >= 0 && raw.indexOf('<') === -1) {
    try {
      collectScreensFromJson(JSON.parse(raw.slice(jsonStart)), false, out);
    } catch { /* fall through to XML */ }
  }

  const xmlStart = raw.indexOf('<');
  if (!out.length && xmlStart >= 0) {
    rootTag = collectScreensFromMarkup(raw.slice(xmlStart), out);
  }

  // Deduplicate by id/name, cap to something sane.
  const seen = new Set();
  const screens = out.filter((s) => {
    const key = s.id || s.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 60);
  return { rootTag, screens };
}

async function detectScreens() {
  showError('');
  setDot(ui.figmaDot, 'loading');
  ui.figmaText.textContent = 'Conectando ao Figma MCP local…';
  ui.extractBtn.disabled = true;
  ui.detectHint.hidden = true;
  try {
    const conn = await api.figmaConnect();
    if (!conn.ok) {
      setDot(ui.figmaDot, conn.reason === 'upgrade' ? 'warn' : 'bad');
      ui.figmaText.textContent = conn.error || 'Não foi possível conectar ao Figma MCP local.';
      return;
    }

    const toolNames = new Set((conn.tools || []).map((t) => t.name));
    if (!toolNames.has('get_metadata')) {
      setDot(ui.figmaDot, 'bad');
      ui.figmaText.textContent = 'O Figma MCP local não expõe get_metadata — atualize o Figma desktop.';
      return;
    }

    ui.figmaText.textContent = 'Varrendo o arquivo em busca de telas…';

    const explicitNode = normalizeNodeId(ui.nodeId.value);
    if (ui.nodeId.value.trim() && !explicitNode) {
      setDot(ui.figmaDot, 'bad');
      ui.figmaText.textContent = 'Node inválido. Cole a URL do Figma com ?node-id=… ou o id no formato 123:456.';
      return;
    }

    // Strategy: an explicit node scans that subtree; otherwise scan the whole
    // page via the canvas node (0:1) so an active selection in Figma does not
    // narrow the scan. Falls back to the current selection if 0:1 fails.
    let parsed = null;
    const attempts = explicitNode ? [{ nodeId: explicitNode }] : [{ nodeId: '0:1' }, {}];
    for (const args of attempts) {
      const extraction = await api.figmaExtract('get_metadata', args);
      if (!extraction.ok) continue;
      const candidate = parseScreens(mcpResultText(extraction.result));
      if (candidate.screens.length) { parsed = candidate; break; }
      if (!parsed) parsed = candidate;
    }

    if (!parsed || !parsed.screens.length) {
      setDot(ui.figmaDot, 'warn');
      ui.figmaText.textContent = 'Nenhuma tela (frame) encontrada. Abra a página do projeto no Figma desktop e tente de novo.';
      return;
    }

    routeCandidates = parsed.screens.map((s, i) => ({
      id: s.id || `screen-${i}`,
      name: s.name,
      route: slugify(s.name) || `tela-${i + 1}`,
      included: true,
    }));

    // Design files often repeat screens as interaction states (Hover, filled
    // variants…). Keep the first occurrence of each route checked and uncheck
    // the duplicates by default — the user can re-check what matters.
    const seenRoutes = new Set();
    for (const candidate of routeCandidates) {
      if (seenRoutes.has(candidate.route)) candidate.included = false;
      else seenRoutes.add(candidate.route);
    }
    renderRoutes();

    setDot(ui.figmaDot, 'ok');
    ui.figmaText.textContent = `${routeCandidates.length} tela(s) detectada(s) — revise a lista abaixo.`;
    if (routeCandidates.length === 1 && !explicitNode && parsed.rootTag !== 'canvas') {
      ui.detectHint.hidden = false;
      ui.detectHint.textContent = 'Só 1 tela? Provavelmente há um frame selecionado no Figma restringindo a varredura. Pressione Esc lá para desmarcar e detecte novamente.';
    }
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
  const selected = routeCandidates.filter((c) => c.included && c.route);
  const routes = selected.map((c) => c.route);
  return {
    projectName: ui.projName.value.trim(),
    description: ui.projDesc.value.trim() || null,
    framework: 'angular',
    components: [],
    technologies: [],
    projectType: 'web-app',
    outputMode,
    customRoutes: routes.length ? routes : null,
    figmaScreens: selected.length
      ? selected.map((c) => ({
          screenId: c.id,
          name: c.name,
          kind: 'route',
          route: c.route,
          figmaPrompt: null,
          parentRoute: null,
        }))
      : null,
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
  ui.extractBtn.addEventListener('click', detectScreens);
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
