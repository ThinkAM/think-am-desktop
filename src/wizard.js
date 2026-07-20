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
  clearBtn: el('clear-btn'),
  detectHint: el('detect-hint'),
  aiCard: el('ai-card'),
  provider: el('provider'),
  provOpenai: el('prov-openai'),
  provAnthropic: el('prov-anthropic'),
  provBedrock: el('prov-bedrock'),
  runCard: el('run-card'),
  planBtn: el('plan-btn'),
  plan: el('plan'),
  planBody: el('plan-body'),
  confirmBtn: el('confirm-btn'),
  adjustBtn: el('adjust-btn'),
  progress: el('progress'),
  genDot: el('gen-dot'),
  genText: el('gen-text'),
  result: el('result'),
  files: el('files'),
  saveBtn: el('save-btn'),
  resultHint: el('result-hint'),
  runError: el('run-error'),
  reuseBtn: el('reuse-btn'),
  deepContext: el('deepContext'),
  version: el('version'),
  siteLink: el('site-link'),
};

let outputMode = 'template';
let routeCandidates = []; // { id, name, route, included }
let jobTimer = null;
let pendingRequest = null; // request shown in the plan preview; generation uses exactly this
const contextCache = new Map(); // figma nodeId → design-context snippet

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

// Strips MCP boilerplate that pollutes generation prompts: the selection
// preamble and the agent-facing "call get_design_context" instruction.
function cleanMcpText(text) {
  return String(text || '')
    .replace(/^Currently selected nodes:[\s\S]*?(?=<)/, '')
    .replace(/IMPORTANT: After you call this tool[\s\S]*$/i, '')
    .trim();
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

    // Merge into the existing list instead of replacing it: repeated scans
    // (another Section, another page…) accumulate, and entries the user
    // already reviewed keep their checkbox state and edited slugs.
    const existingIds = new Set(routeCandidates.map((c) => c.id));
    const seenRoutes = new Set(routeCandidates.map((c) => c.route));
    const additions = [];
    parsed.screens.forEach((s, i) => {
      const id = s.id || `screen-${Date.now()}-${i}`;
      if (existingIds.has(id)) return;
      const route = slugify(s.name) || `tela-${routeCandidates.length + additions.length + 1}`;
      // Design files repeat screens as interaction states (Hover, filled
      // variants…): duplicates of an already-listed route start unchecked.
      const isDuplicate = seenRoutes.has(route);
      additions.push({ id, name: s.name, route, included: !isDuplicate });
      seenRoutes.add(route);
    });
    routeCandidates = routeCandidates.concat(additions);
    renderRoutes();

    setDot(ui.figmaDot, additions.length ? 'ok' : 'warn');
    ui.figmaText.textContent = additions.length
      ? `${additions.length} tela(s) adicionada(s) — ${routeCandidates.length} na lista.`
      : `Nenhuma tela nova — as ${parsed.screens.length} encontradas já estavam na lista.`;
    if (additions.length === 1 && routeCandidates.length === 1 && !explicitNode && parsed.rootTag !== 'canvas') {
      ui.detectHint.hidden = false;
      ui.detectHint.textContent = 'Só 1 tela? Provavelmente há um frame selecionado no Figma restringindo a varredura. Pressione Esc lá para desmarcar e detecte novamente.';
    }
  } finally {
    ui.extractBtn.disabled = false;
  }
}

function clearScreens() {
  routeCandidates = [];
  renderRoutes();
  setDot(ui.figmaDot, null);
  ui.figmaText.textContent = 'Lista limpa — detecte novamente quando quiser.';
  ui.detectHint.hidden = true;
}

// --- provider (BYOK) ----------------------------------------------------------

function syncProviderFields() {
  const p = ui.provider.value;
  ui.provOpenai.classList.toggle('hidden', p !== 'openai-compatible');
  ui.provAnthropic.classList.toggle('hidden', p !== 'anthropic');
  ui.provBedrock.classList.toggle('hidden', p !== 'bedrock');
}

// --- generation ---------------------------------------------------------------

// The LLM inference (including Anthropic/Bedrock BYOK) only engages when
// screens carry a figmaPrompt — a null prompt means pure template output.
// Build one per selected screen, optionally enriched with the real design
// context pulled from the local Figma MCP.
async function buildScreenPrompt(candidate, progress) {
  let prompt = `Implementar a tela "${candidate.name}" do Figma como rota '/${candidate.route}'.`;
  if (!ui.deepContext.checked || !/^\d+:\d+$/.test(candidate.id)) return prompt;

  if (!contextCache.has(candidate.id)) {
    if (progress) progress();
    // Best source: full design context. Falls back to the node's structural
    // metadata when the MCP blocks context extraction (e.g. write-to-disk
    // mode enabled without an allowed assets directory).
    let text = '';
    const context = await api.figmaExtract('get_design_context', { nodeId: candidate.id });
    if (context.ok) {
      text = cleanMcpText(mcpResultText(context.result)).slice(0, 3500);
    } else {
      const metadata = await api.figmaExtract('get_metadata', { nodeId: candidate.id });
      if (metadata.ok) {
        text = 'Estrutura da tela (nomes e hierarquia dos elementos):\n' + cleanMcpText(mcpResultText(metadata.result)).slice(0, 3000);
      }
    }
    contextCache.set(candidate.id, text);
  }
  const snippet = contextCache.get(candidate.id);
  if (snippet) {
    prompt += `\n\nContexto do design (extraído do Figma local via MCP):\n${snippet}`;
  }
  return prompt;
}

async function buildRequest(onProgress) {
  const provider = ui.provider.value || null;
  const selected = routeCandidates.filter((c) => c.included && c.route);
  const routes = selected.map((c) => c.route);

  const figmaScreens = [];
  for (let i = 0; i < selected.length; i++) {
    const candidate = selected[i];
    const prompt = await buildScreenPrompt(
      candidate,
      onProgress ? () => onProgress(`Extraindo contexto da tela ${i + 1}/${selected.length} (${candidate.name})…`) : null,
    );
    figmaScreens.push({
      screenId: candidate.id,
      name: candidate.name,
      kind: 'route',
      route: candidate.route,
      figmaPrompt: prompt,
      parentRoute: null,
    });
  }

  return {
    projectName: ui.projName.value.trim(),
    description: ui.projDesc.value.trim() || null,
    framework: 'angular',
    components: [],
    technologies: [],
    projectType: 'web-app',
    outputMode,
    customRoutes: routes.length ? routes : null,
    figmaScreens: figmaScreens.length ? figmaScreens : null,
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

// --- plan preview ---------------------------------------------------------------

function planSection(title, items) {
  if (!items || !items.length) return '';
  const list = items.map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  return `<h4>${escapeHtml(title)} (${items.length})</h4><ul>${list}</ul>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function renderPlan(manifest) {
  const m = manifest || {};
  const frontend = m.frontend || {};
  const backend = m.backend || {};
  const provider = ui.provider.value || 'nenhum (determinístico)';

  const screens = (frontend.screens || []).map((s) => `${s.name || s.route || '?'}${s.route ? ` → /${String(s.route).replace(/^\//, '')}` : ''}`);
  const routes = (frontend.routes || []).map((r) => `/${String(r).replace(/^\//, '')}`);
  const modules = (m.modules || backend.modules || []).map((mod) =>
    `${mod.name || mod.module || '?'}${mod.entities ? ` — entidades: ${(mod.entities || []).map((e) => e.name || e).join(', ')}` : ''}`);

  ui.planBody.innerHTML = `
    <p><strong>${escapeHtml(m.projectName || '?')}</strong> <span class="muted">(${escapeHtml(m.slug || '')})</span></p>
    <p class="muted">Stack: ${escapeHtml(backend.framework || '?')} + ${escapeHtml(backend.database || '?')} · ${escapeHtml(frontend.framework || 'angular')} · saída: ${escapeHtml(m.generationMode || outputMode)}</p>
    <p class="muted">Inferência: ${escapeHtml(provider)}</p>
    ${planSection('Telas', screens)}
    ${screens.length ? '' : planSection('Rotas', routes)}
    ${planSection('Módulos backend inferidos', modules)}
    <details class="plan-raw"><summary>Manifest completo (JSON)</summary><pre>${escapeHtml(JSON.stringify(m, null, 2))}</pre></details>
  `;
}

async function showPlan() {
  const name = ui.projName.value.trim();
  if (!name) {
    showError('Dê um nome ao projeto antes de continuar.');
    ui.projName.focus();
    return;
  }

  showError('');
  ui.plan.hidden = true;
  ui.result.hidden = true;
  ui.planBtn.disabled = true;
  ui.planBtn.textContent = 'Montando plano…';
  try {
    pendingRequest = await buildRequest((msg) => { ui.planBtn.textContent = msg; });
    ui.planBtn.textContent = 'Consultando o plano de geração…';
    const r = await api.genPreview(pendingRequest);
    if (!r.ok) {
      pendingRequest = null;
      showError(r.error || 'Falha ao montar o plano.');
      return;
    }
    renderPlan(r.manifest);
    ui.plan.hidden = false;
  } finally {
    ui.planBtn.disabled = false;
    ui.planBtn.textContent = 'Ver plano de geração';
  }
}

// --- generate + structure preview + save ---------------------------------------

function failGeneration(message) {
  stopPolling();
  setDot(ui.genDot, 'bad');
  ui.genText.textContent = 'Geração falhou.';
  showError(message || 'Erro desconhecido na geração.');
  ui.confirmBtn.disabled = false;
  ui.confirmBtn.textContent = 'Tentar novamente';
}

async function showStructure(downloadUrl) {
  setDot(ui.genDot, 'loading');
  ui.genText.textContent = 'Baixando estrutura para preview…';
  const r = await api.genFetch(downloadUrl);
  if (!r.ok) { failGeneration(r.error); return; }

  const files = (r.files || []).sort();
  const shown = files.slice(0, 500);
  ui.files.textContent = shown.join('\n') + (files.length > shown.length ? `\n… e mais ${files.length - shown.length} arquivo(s)` : '');
  ui.resultHint.textContent = `${files.length} arquivo(s) · ${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB — revise a estrutura e salve quando quiser.`;

  setDot(ui.genDot, 'ok');
  ui.genText.textContent = 'Projeto gerado com sucesso.';
  ui.result.hidden = false;
  ui.confirmBtn.disabled = false;
  ui.confirmBtn.textContent = 'Gerar novamente';
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
      if (r.downloadUrl) showStructure(r.downloadUrl);
      else failGeneration('Geração concluída, mas sem arquivo para download.');
    } else if (status === 'failed') {
      failGeneration(r.error || 'A geração falhou no servidor.');
    }
  }, 5000);
}

async function generate() {
  if (!pendingRequest) return;

  // Remember these inputs so the next run can start pre-filled.
  saveInputs();

  showError('');
  ui.result.hidden = true;
  ui.progress.hidden = false;
  setDot(ui.genDot, 'loading');
  ui.genText.textContent = 'Enviando para geração…';
  ui.confirmBtn.disabled = true;
  ui.confirmBtn.textContent = 'Gerando…';

  const r = await api.genGenerate(pendingRequest);
  if (!r.ok) { failGeneration(r.error); return; }

  if (r.async && r.jobId) {
    ui.genText.textContent = 'Geração em andamento…';
    pollJob(r.jobId);
  } else if (r.downloadUrl) {
    showStructure(r.downloadUrl);
  } else {
    failGeneration('Resposta inesperada do servidor.');
  }
}

async function saveZip() {
  ui.saveBtn.disabled = true;
  ui.saveBtn.textContent = 'Salvando…';
  try {
    const r = await api.genSave();
    if (r.ok) ui.resultHint.textContent = `Salvo em ${r.path}`;
    else showError(r.error || 'Falha ao salvar.');
  } finally {
    ui.saveBtn.disabled = false;
    ui.saveBtn.textContent = 'Salvar na pasta Downloads';
  }
}

// --- input reuse ----------------------------------------------------------------

function collectInputs() {
  return {
    projName: ui.projName.value,
    projDesc: ui.projDesc.value,
    outputMode,
    provider: ui.provider.value,
    openaiBaseUrl: el('openaiBaseUrl').value,
    openaiModel: el('openaiModel').value,
    openaiKey: el('openaiKey').value,
    anthropicKey: el('anthropicKey').value,
    anthropicModel: el('anthropicModel').value,
    bedrockRegion: el('bedrockRegion').value,
    bedrockKeyId: el('bedrockKeyId').value,
    bedrockSecret: el('bedrockSecret').value,
    bedrockModel: el('bedrockModel').value,
    deepContext: ui.deepContext.checked,
    routeCandidates,
  };
}

function saveInputs() {
  api.saveWizardInputs(collectInputs()).catch(() => { /* best-effort */ });
}

function applyInputs(saved) {
  if (!saved) return;
  ui.projName.value = saved.projName || '';
  ui.projDesc.value = saved.projDesc || '';
  setOutputMode(saved.outputMode === 'starter-kit' ? 'starter-kit' : 'template');
  ui.provider.value = saved.provider || '';
  el('openaiBaseUrl').value = saved.openaiBaseUrl || '';
  el('openaiModel').value = saved.openaiModel || '';
  el('openaiKey').value = saved.openaiKey || '';
  el('anthropicKey').value = saved.anthropicKey || '';
  if (saved.anthropicModel) el('anthropicModel').value = saved.anthropicModel;
  el('bedrockRegion').value = saved.bedrockRegion || '';
  el('bedrockKeyId').value = saved.bedrockKeyId || '';
  el('bedrockSecret').value = saved.bedrockSecret || '';
  if (saved.bedrockModel) el('bedrockModel').value = saved.bedrockModel;
  ui.deepContext.checked = saved.deepContext !== false;
  syncProviderFields();
  if (Array.isArray(saved.routeCandidates) && saved.routeCandidates.length) {
    routeCandidates = saved.routeCandidates;
    renderRoutes();
    setDot(ui.figmaDot, 'ok');
    ui.figmaText.textContent = `${routeCandidates.length} tela(s) restaurada(s) da última geração.`;
  }
}

// --- init ---------------------------------------------------------------------

async function init() {
  ui.back.addEventListener('click', () => api.navigate('launcher'));
  ui.gateCta.addEventListener('click', () => api.navigate('launcher'));
  ui.modeTemplate.addEventListener('click', () => setOutputMode('template'));
  ui.modeStarter.addEventListener('click', () => setOutputMode('starter-kit'));
  ui.extractBtn.addEventListener('click', detectScreens);
  ui.clearBtn.addEventListener('click', clearScreens);
  ui.provider.addEventListener('change', syncProviderFields);
  ui.planBtn.addEventListener('click', showPlan);
  ui.confirmBtn.addEventListener('click', generate);
  ui.adjustBtn.addEventListener('click', () => { ui.plan.hidden = true; pendingRequest = null; });
  ui.saveBtn.addEventListener('click', saveZip);
  ui.reuseBtn.addEventListener('click', async () => {
    applyInputs(await api.loadWizardInputs());
    ui.reuseBtn.hidden = true;
  });
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

  // Offer to restore the previous generation's inputs.
  try {
    const saved = await api.loadWizardInputs();
    if (saved && (saved.projName || (saved.routeCandidates || []).length)) ui.reuseBtn.hidden = false;
  } catch { /* ignore */ }
}

init();
