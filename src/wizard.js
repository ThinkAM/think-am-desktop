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
  stepper: el('stepper'),
  stepperFill: el('stepper-fill'),
  stepperPlane: el('stepper-plane'),
  chooseFolderBtn: el('choose-folder-btn'),
  folderDot: el('folder-dot'),
  folderText: el('folder-text'),
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
  runBackNav: el('run-back-nav'),
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
  retryLocalBtn: el('retry-local-btn'),
  resultHint: el('result-hint'),
  installStatus: el('install-status'),
  runError: el('run-error'),
  reuseBtn: el('reuse-btn'),
  deepContext: el('deepContext'),
  version: el('version'),
  siteLink: el('site-link'),
};

// --- horizontal stepper: project → figma → IA → gerar --------------------------

const STEP_SECTIONS = [ui.projectCard, ui.figmaCard, ui.aiCard, ui.runCard];
let currentStep = 1;

function updateStepper() {
  document.querySelectorAll('.stepper__item').forEach((item) => {
    const n = Number(item.dataset.step);
    item.classList.toggle('active', n === currentStep);
    item.classList.toggle('done', n < currentStep);
  });
  const pct = ((currentStep - 1) / (STEP_SECTIONS.length - 1)) * 100;
  ui.stepperFill.style.width = pct + '%';
  ui.stepperPlane.style.left = pct + '%';

  // Takeoff-and-land hop, replayed on every step change. CSS animations
  // don't restart just because the class is still there, so force it:
  // remove, reflow, re-add.
  ui.stepperPlane.classList.remove('hopping');
  void ui.stepperPlane.offsetWidth;
  ui.stepperPlane.classList.add('hopping');
}

function goToStep(n) {
  if (n < 1 || n > STEP_SECTIONS.length) return;
  currentStep = n;
  STEP_SECTIONS.forEach((section, i) => { section.hidden = i + 1 !== n; });
  updateStepper();
  ui.projectCard.closest('main').scrollTo({ top: 0, behavior: 'smooth' });
}

let outputMode = 'template';
let routeCandidates = []; // { id, name, route, included }
let jobTimer = null;
let pendingRequest = null; // request shown in the plan preview; generation uses exactly this
let lastSaveDir = null; // remembered across saves within this session, pre-fills the folder picker
const contextCache = new Map(); // figma nodeId → { figmaPrompt, designCode }
let availableToolNames = new Set(); // tool names exposed by the connected Figma MCP

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
    availableToolNames = toolNames;
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

// --- dynamic model listing (BYOK) ---------------------------------------------

function modelListRequest(provider) {
  if (provider === 'anthropic') {
    return { llmProvider: 'anthropic', anthropicApiKey: el('anthropicKey').value || null };
  }
  if (provider === 'bedrock') {
    return {
      llmProvider: 'bedrock',
      bedrockRegion: el('bedrockRegion').value.trim() || null,
      bedrockAccessKeyId: el('bedrockKeyId').value || null,
      bedrockSecretAccessKey: el('bedrockSecret').value || null,
    };
  }
  return {
    llmProvider: 'openai-compatible',
    openaiBaseUrl: el('openaiBaseUrl').value.trim() || null,
    openaiApiKey: el('openaiKey').value || null,
  };
}

// Sets a select's value, adding the option first when it isn't in the list
// (e.g. a previously fetched model id restored from the last generation).
function setSelectValue(select, value) {
  if (![...select.options].some((o) => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
  select.value = value;
}

// Rebuilds a <select> with the fetched models, keeping the current selection.
function populateModelSelect(select, models) {
  const current = select.value;
  select.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id;
    select.appendChild(opt);
  }
  if (current && models.some((m) => m.id === current)) select.value = current;
}

async function fetchModels(provider, button, statusEl) {
  button.disabled = true;
  button.textContent = 'Consultando o provider…';
  statusEl.hidden = true;
  try {
    const r = await api.listLlmModels(modelListRequest(provider));
    statusEl.hidden = false;
    if (!r.ok) {
      statusEl.textContent = '⚠ ' + (r.error || 'Falha ao listar modelos.');
      statusEl.classList.add('models-status--error');
      return;
    }
    statusEl.classList.remove('models-status--error');
    if (provider === 'openai-compatible') {
      const list = el('openaiModelsList');
      list.innerHTML = '';
      for (const m of r.models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        list.appendChild(opt);
      }
      statusEl.textContent = `${r.models.length} modelo(s) disponível(is) — digite ou escolha na lista.`;
    } else {
      populateModelSelect(el(provider === 'anthropic' ? 'anthropicModel' : 'bedrockModel'), r.models);
      statusEl.textContent = `${r.models.length} modelo(s) disponível(is) com estas credenciais.`;
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Buscar modelos disponíveis';
  }
}

// --- generation ---------------------------------------------------------------

// The LLM inference (including Anthropic/Bedrock BYOK) only engages when
// screens carry a figmaPrompt — a null prompt means pure template output.
//
// Fidelity source (why this exists): the server's `designCode` path PORTS the
// real HTML/CSS the Figma Dev Mode MCP produces (`get_code`) instead of asking
// the LLM to imagine a screen from a text description — the description path
// drifts into "what the AI thought the Figma meant" and doesn't match the
// design. So per selected frame we pull `get_code` (HTML/CSS) and carry it as
// `designCode`; `figmaPrompt` stays a short instruction that also drives
// backend module inference. Returns { figmaPrompt, designCode }.
async function buildScreenPrompt(candidate, progress) {
  const figmaPrompt = `Implementar a tela "${candidate.name}" do Figma como rota '/${candidate.route}'.`;
  if (!ui.deepContext.checked || !/^\d+:\d+$/.test(candidate.id)) {
    return { figmaPrompt, designCode: '' };
  }

  if (!contextCache.has(candidate.id)) {
    if (progress) progress();
    let designCode = '';
    let promptExtra = '';
    let extractError = '';

    // Faithful-port source, best-first. get_code returns markup/styles when
    // present; get_design_context is the Dev Mode MCP's design-to-code tool
    // (it returns reference code too) and is what most local servers expose —
    // route ITS output to designCode as well so it goes through the faithful
    // port path, not the weak "implement this description" fallback. The
    // main-process handler injects the asset-write dir these tools need.
    for (const toolName of ['get_code', 'get_design_context']) {
      if (designCode || !availableToolNames.has(toolName)) continue;
      const r = await api.figmaExtract(toolName, { nodeId: candidate.id });
      if (r.ok) {
        const text = cleanMcpText(mcpResultText(r.result)).slice(0, 24000);
        if (text) designCode = text;
      } else if (r.error) {
        extractError = r.error;
      }
    }

    // Last resort only if no design code came back: structural metadata as a
    // weak textual hint in figmaPrompt.
    if (!designCode) {
      const metadata = await api.figmaExtract('get_metadata', { nodeId: candidate.id });
      if (metadata.ok) {
        promptExtra = 'Estrutura da tela (nomes e hierarquia dos elementos):\n'
          + cleanMcpText(mcpResultText(metadata.result)).slice(0, 3000);
      }
    }
    contextCache.set(candidate.id, { designCode, promptExtra, extractError });
  }

  const cached = contextCache.get(candidate.id) || { designCode: '', promptExtra: '' };
  const prompt = cached.promptExtra
    ? `${figmaPrompt}\n\nContexto do design (extraído do Figma local via MCP):\n${cached.promptExtra}`
    : figmaPrompt;
  return { figmaPrompt: prompt, designCode: cached.designCode || '' };
}

async function buildRequest(onProgress) {
  const provider = ui.provider.value || null;
  const selected = routeCandidates.filter((c) => c.included && c.route);
  const routes = selected.map((c) => c.route);

  const figmaScreens = [];
  let withDesign = 0;
  let firstError = '';
  for (let i = 0; i < selected.length; i++) {
    const candidate = selected[i];
    const { figmaPrompt, designCode } = await buildScreenPrompt(
      candidate,
      onProgress ? () => onProgress(`Extraindo design da tela ${i + 1}/${selected.length} (${candidate.name})…`) : null,
    );
    if (designCode) withDesign += 1;
    else if (!firstError) firstError = (contextCache.get(candidate.id) || {}).extractError || '';
    figmaScreens.push({
      screenId: candidate.id,
      name: candidate.name,
      kind: 'route',
      route: candidate.route,
      figmaPrompt,
      designCode,
      parentRoute: null,
    });
  }

  // Surface extraction reality so a silent empty design (e.g. the Figma MCP
  // "write to disk" arg error) is visible instead of quietly degrading to
  // imagined screens. Shown in the Figma status line after building the plan.
  if (selected.length && ui.deepContext.checked) {
    if (withDesign === 0) {
      setDot(ui.figmaDot, 'warn');
      ui.figmaText.textContent = firstError
        ? `Nenhuma tela trouxe design do Figma. Erro do MCP: ${firstError}`
        : 'Nenhuma tela trouxe design do Figma (extração vazia) — as telas serão imaginadas, não portadas.';
    } else {
      setDot(ui.figmaDot, withDesign === selected.length ? 'ok' : 'warn');
      ui.figmaText.textContent = `Design extraído de ${withDesign}/${selected.length} tela(s) — essas serão portadas fielmente.`;
    }
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
  return `<div class="plan-section"><h4>${escapeHtml(title)} (${items.length})</h4><ul>${list}</ul></div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function renderPlan(manifest) {
  const m = manifest || {};
  const frontend = m.frontend || {};
  const backend = m.backend || {};
  const providerChoice = ui.provider.value || null;

  // Inference status straight from the server — never assume the LLM ran.
  const inference = m.inference || null;
  let inferenceHtml;
  if (!providerChoice) {
    inferenceHtml = '<p class="muted">Inferência: nenhuma (geração determinística por templates)</p>';
  } else if (inference && inference.engaged) {
    inferenceHtml = `<p class="plan-ok">✓ Inferência ativa: ${escapeHtml(inference.provider)} — o plano abaixo foi produzido pela IA.</p>`;
  } else {
    const err = inference && inference.error ? inference.error : 'o servidor não reportou o status da inferência';
    inferenceHtml = `<p class="plan-bad">⚠ Inferência ${escapeHtml(providerChoice)} FALHOU: ${escapeHtml(err)}<br>Se confirmar, a geração será interrompida com este erro — corrija as credenciais/modelo antes.</p>`;
  }

  const screens = (frontend.screens || []).map((s) => `${s.name || s.route || '?'}${s.route ? ` → /${String(s.route).replace(/^\//, '')}` : ''}`);
  const routes = (frontend.routes || []).map((r) => `/${String(r).replace(/^\//, '')}`);
  const modules = (m.modules || backend.modules || []).map((mod) =>
    `${mod.name || mod.module || '?'}${mod.entities ? ` — entidades: ${(mod.entities || []).map((e) => e.name || e).join(', ')}` : ''}`);

  ui.planBody.innerHTML = `
    <p><strong>${escapeHtml(m.projectName || '?')}</strong> <span class="muted">(${escapeHtml(m.slug || '')})</span></p>
    <p class="muted">Stack: ${escapeHtml(backend.framework || '?')} + ${escapeHtml(backend.database || '?')} · ${escapeHtml(frontend.framework || 'angular')} · saída: ${escapeHtml(m.generationMode || outputMode)}</p>
    ${inferenceHtml}
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
  ui.runBackNav.hidden = false;
}

async function showStructure(downloadUrl) {
  setDot(ui.genDot, 'loading');
  ui.genText.textContent = 'Baixando estrutura para preview…';
  const r = await api.genFetch(downloadUrl);
  if (!r.ok) { failGeneration(r.error); return; }

  const files = (r.files || []).sort();
  const shown = files.slice(0, 500);
  ui.files.textContent = shown.join('\n') + (files.length > shown.length ? `\n… e mais ${files.length - shown.length} arquivo(s)` : '');
  ui.resultHint.textContent = `${files.length} arquivo(s) · ${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB gerados no servidor.`;
  ui.result.hidden = false;

  // The server job is only stage 1 — do NOT say "sucesso" yet, that reads as
  // "everything is done" when extraction + local npm install (the part most
  // likely to fail: disk space, missing npm) haven't run yet. Chain straight
  // into them using the folder chosen up front in Step 1.
  setDot(ui.genDot, 'ok');
  ui.genText.textContent = 'Gerado no servidor — extraindo e instalando localmente…';
  await deliverLocally();

  ui.confirmBtn.disabled = false;
  ui.confirmBtn.textContent = 'Gerar novamente';
  ui.runBackNav.hidden = false;
}

function setChosenFolder(folderPath) {
  lastSaveDir = folderPath;
  ui.folderText.textContent = folderPath;
  setDot(ui.folderDot, 'ok');
}

async function chooseFolder() {
  const picked = await api.genPickFolder(lastSaveDir);
  if (!picked.ok) return; // user canceled
  setChosenFolder(picked.path);
  saveInputs(); // remember immediately, don't wait for a generation to complete
}

// Extracts the last-downloaded zip into the folder chosen in Step 1 and runs
// `npm install` locally. Split out from showStructure so a failure here (e.g.
// disk full) can be retried on its own — no need to wait through another
// 15-20 minute server generation just to redo the local part.
async function deliverLocally() {
  ui.retryLocalBtn.hidden = true;
  ui.installStatus.hidden = false;
  ui.installStatus.className = 'hint hint--left muted';
  ui.installStatus.textContent = `Extraindo para ${lastSaveDir}…`;

  const save = await api.genSave(lastSaveDir);
  if (!save.ok) {
    ui.installStatus.className = 'hint hint--left plan-bad';
    ui.installStatus.textContent = `⚠ Falha ao extrair o projeto: ${save.error}`;
    ui.retryLocalBtn.hidden = false;
    return;
  }

  ui.resultHint.textContent = `Salvo em ${save.path} (${save.fileCount} arquivo(s))`;
  // Building (not just installing) locally catches real compile errors — a
  // typo the AI made in a property name, for instance — before the user
  // finds out via a `docker compose up --build` failure minutes into a build.
  ui.installStatus.textContent = `Instalando dependências e validando a build localmente (apps/api, apps/web) em ${save.path}… isso pode levar alguns minutos.`;

  // pendingRequest already carries the Step 3 BYOK fields in the exact shape
  // local-llm.js expects (llmProvider, anthropicApiKey, bedrockAccessKeyId,
  // ...) — same object the server request used, no separate config to keep
  // in sync. When no provider is configured, the main process just skips
  // auto-fix and behaves exactly as before.
  const install = await api.genNpmInstallAndBuild(save.path, pendingRequest);
  const allFixedFiles = (install.results || []).flatMap((x) => x.autoFixedFiles || []);
  const fixedNote = allFixedFiles.length
    ? ` A IA corrigiu automaticamente: ${allFixedFiles.join(', ')}.`
    : '';

  if (install.ok) {
    ui.installStatus.className = 'hint hint--left plan-ok';
    ui.installStatus.textContent = `✓ Projeto pronto: dependências instaladas e build validada com sucesso.${fixedNote}`;
  } else {
    const failed = (install.results || []).filter((x) => !x.ok);
    const detail = failed
      .map((x) => {
        const where = x.stage === 'install' ? 'npm install' : 'npm run build';
        const fixNote = x.autoFixAttempts ? ` (IA tentou corrigir ${x.autoFixAttempts}x sem sucesso)` : '';
        return `${x.app} (${where})${fixNote}: ${x.error}`;
      })
      .join(' | ') || install.error || 'erro desconhecido';
    ui.installStatus.className = 'hint hint--left plan-bad';
    ui.installStatus.textContent = `⚠ Falha em ${failed.map((x) => x.app).join(', ') || 'o projeto'}: ${detail}${fixedNote}`;
    ui.retryLocalBtn.hidden = false;
  }
}

function pollJob(jobId) {
  stopPolling();
  let failStreak = 0;
  let slowMode = false;

  // Perda de conexão NUNCA vira "Geração falhou": o job continua rodando no
  // servidor. Depois de ~30s sem contato, passa a reconectar a cada 30s e
  // avisa que a conclusão também chega por e-mail. Só falha de verdade quando
  // o servidor reportar status "failed".
  const tick = async () => {
    const r = await api.genJob(jobId);
    if (!r.ok) {
      failStreak += 1;
      if (slowMode) return;
      if (failStreak >= 6) {
        slowMode = true;
        stopPolling();
        jobTimer = setInterval(tick, 30000);
        setDot(ui.genDot, 'warn');
        ui.genText.textContent =
          'Sem conexão com o servidor, mas a geração CONTINUA rodando lá. '
          + 'Vamos seguir tentando reconectar — e você também será avisado por e-mail quando concluir.';
      } else {
        ui.genText.textContent = `Conexão instável com o servidor — tentando de novo (${failStreak}/6)… a geração continua rodando.`;
      }
      return;
    }
    if (slowMode) {
      slowMode = false;
      stopPolling();
      jobTimer = setInterval(tick, 5000);
      setDot(ui.genDot, 'loading');
    }
    failStreak = 0;
    if (r.progress) ui.genText.textContent = r.progress;
    const status = String(r.status || '').toLowerCase();
    if (status === 'completed' || status === 'completed_with_warnings') {
      stopPolling();
      if (r.downloadUrl) showStructure(r.downloadUrl);
      else failGeneration('Geração concluída, mas sem arquivo para download.');
    } else if (status === 'failed') {
      failGeneration(r.error || 'A geração falhou no servidor.');
    }
  };
  jobTimer = setInterval(tick, 5000);
}

async function generate() {
  if (!pendingRequest) return;
  if (!lastSaveDir) {
    // Shouldn't normally happen — Step 1 already requires this before you can
    // reach Step 4 — but defend against pendingRequest surviving a folder reset.
    showError('Escolha a pasta de destino antes de gerar.');
    goToStep(1);
    return;
  }

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
    saveDir: lastSaveDir,
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
  if (saved.anthropicModel) setSelectValue(el('anthropicModel'), saved.anthropicModel);
  el('bedrockRegion').value = saved.bedrockRegion || '';
  el('bedrockKeyId').value = saved.bedrockKeyId || '';
  el('bedrockSecret').value = saved.bedrockSecret || '';
  if (saved.bedrockModel) setSelectValue(el('bedrockModel'), saved.bedrockModel);
  ui.deepContext.checked = saved.deepContext !== false;
  if (saved.saveDir) setChosenFolder(saved.saveDir);
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
  document.querySelectorAll('[data-next]').forEach((btn) => btn.addEventListener('click', () => {
    if (currentStep === 1) {
      if (!ui.projName.value.trim()) {
        showError('Dê um nome ao projeto antes de continuar.');
        ui.projName.focus();
        return;
      }
      if (!lastSaveDir) {
        showError('Escolha a pasta de destino antes de continuar.');
        ui.chooseFolderBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    showError('');
    goToStep(currentStep + 1);
  }));
  document.querySelectorAll('[data-back]').forEach((btn) => btn.addEventListener('click', () => goToStep(currentStep - 1)));
  ui.chooseFolderBtn.addEventListener('click', chooseFolder);
  ui.extractBtn.addEventListener('click', detectScreens);
  ui.clearBtn.addEventListener('click', clearScreens);
  ui.provider.addEventListener('change', syncProviderFields);
  el('fetch-anthropic-models').addEventListener('click', () =>
    fetchModels('anthropic', el('fetch-anthropic-models'), el('anthropic-models-status')));
  el('fetch-bedrock-models').addEventListener('click', () =>
    fetchModels('bedrock', el('fetch-bedrock-models'), el('bedrock-models-status')));
  el('fetch-openai-models').addEventListener('click', () =>
    fetchModels('openai-compatible', el('fetch-openai-models'), el('openai-models-status')));
  ui.planBtn.addEventListener('click', showPlan);
  ui.confirmBtn.addEventListener('click', generate);
  ui.adjustBtn.addEventListener('click', () => { ui.plan.hidden = true; pendingRequest = null; });
  ui.retryLocalBtn.addEventListener('click', deliverLocally);
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
  ui.stepper.hidden = false;
  goToStep(1);

  // Offer to restore the previous generation's inputs.
  try {
    const saved = await api.loadWizardInputs();
    if (saved && (saved.projName || (saved.routeCandidates || []).length)) ui.reuseBtn.hidden = false;
  } catch { /* ignore */ }
}

init();
