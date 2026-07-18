'use strict';

const api = window.thinkam;
const el = (id) => document.getElementById(id);

const ui = {
  back: el('back-btn'),
  gate: el('gate'),
  gateTitle: el('gate-title'),
  gateMsg: el('gate-msg'),
  gateCta: el('gate-cta'),
  connectCard: el('connect-card'),
  mcpUrl: el('mcpUrl'),
  connect: el('connect-btn'),
  mcpDot: el('mcp-dot'),
  mcpText: el('mcp-text'),
  extractCard: el('extract-card'),
  tool: el('tool'),
  nodeId: el('nodeId'),
  extract: el('extract-btn'),
  previewWrap: el('preview-wrap'),
  preview: el('preview').querySelector('code'),
  copy: el('copy-btn'),
  sendCard: el('send-card'),
  projectName: el('projectName'),
  token: el('token'),
  send: el('send-btn'),
  sendStatus: el('send-status'),
  sendDot: el('send-dot'),
  sendText: el('send-text'),
  siteLink: el('site-link'),
};

let lastContext = null;

const setDot = (dot, state) => { dot.className = 'dot' + (state ? ' ' + state : ''); };

async function connect() {
  setDot(ui.mcpDot, 'loading');
  ui.mcpText.textContent = 'Conectando ao Figma MCP…';
  ui.connect.disabled = true;
  try {
    const r = await api.figmaConnect(ui.mcpUrl.value.trim());
    if (!r.ok) {
      setDot(ui.mcpDot, 'bad');
      ui.mcpText.textContent = 'Falha: ' + r.error + ' — abra o Figma desktop e ative o MCP (Dev Mode).';
      return;
    }
    setDot(ui.mcpDot, 'ok');
    const name = (r.server && r.server.name) || 'Figma MCP';
    ui.mcpText.textContent = `Conectado a ${name} · ${r.tools.length} ferramenta(s).`;
    ui.tool.innerHTML = '';
    for (const t of r.tools) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      if (t.name === r.preferred) opt.selected = true;
      ui.tool.appendChild(opt);
    }
    ui.extractCard.hidden = false;
  } finally {
    ui.connect.disabled = false;
  }
}

async function extract() {
  const tool = ui.tool.value;
  if (!tool) return;
  const args = {};
  const node = ui.nodeId.value.trim();
  if (node) args.nodeId = node;

  ui.extract.disabled = true;
  ui.extract.textContent = 'Extraindo…';
  try {
    const r = await api.figmaExtract(tool, args);
    if (!r.ok) {
      ui.previewWrap.hidden = false;
      ui.preview.textContent = 'Erro: ' + r.error;
      lastContext = null;
      return;
    }
    lastContext = r.result;
    ui.preview.textContent = JSON.stringify(r.result, null, 2);
    ui.previewWrap.hidden = false;
    ui.sendCard.hidden = false;
  } finally {
    ui.extract.disabled = false;
    ui.extract.textContent = 'Extrair design context';
  }
}

async function copyPreview() {
  if (!navigator.clipboard) return;
  await navigator.clipboard.writeText(ui.preview.textContent || '');
  ui.copy.textContent = '✓';
  setTimeout(() => { ui.copy.textContent = '⧉'; }, 1500);
}

async function send() {
  if (!lastContext) return;
  ui.sendStatus.hidden = false;
  setDot(ui.sendDot, 'loading');
  ui.sendText.textContent = 'Enviando para geração…';
  ui.send.disabled = true;
  try {
    const r = await api.figmaGenerate(lastContext, ui.projectName.value.trim());
    if (r.ok) {
      setDot(ui.sendDot, 'ok');
      ui.sendText.textContent = `Enviado (HTTP ${r.status}). Geração acionada no knowledge.`;
    } else {
      setDot(ui.sendDot, 'bad');
      ui.sendText.textContent = r.error
        ? 'Falha: ' + r.error
        : `Resposta HTTP ${r.status}: ${(r.body || '').slice(0, 200)}`;
    }
  } finally {
    ui.send.disabled = false;
  }
}

// Gate the whole bridge behind login + Architect (paid) plan.
async function applyGate(cfg) {
  const auth = await api.getAuth();
  const cards = [ui.connectCard, ui.extractCard, ui.sendCard];
  if (auth && auth.architect) {
    ui.gate.hidden = true;
    ui.connectCard.hidden = false;
    return true;
  }
  // Locked — hide the tool cards and show the upgrade/login CTA.
  for (const c of cards) c.hidden = true;
  ui.gate.hidden = false;
  if (!auth) {
    ui.gateTitle.textContent = 'Faça login para usar a ponte Figma';
    ui.gateMsg.textContent = 'A ponte com o Figma MCP local é exclusiva do app desktop e do plano Architect. Entre na sua conta na tela inicial.';
    ui.gateCta.textContent = 'Voltar e fazer login';
    ui.gateCta.onclick = () => api.navigate('launcher');
  } else {
    ui.gateTitle.textContent = 'Recurso exclusivo do plano Architect';
    ui.gateMsg.textContent = 'A geração via Figma MCP local está disponível apenas no plano Architect. Faça upgrade para desbloquear.';
    ui.gateCta.textContent = 'Fazer upgrade para Architect';
    ui.gateCta.onclick = () => api.openExternal((cfg.appUrl || 'https://tbldr.com.br') + '/#pricing');
  }
  return false;
}

async function init() {
  const cfg = await api.getConfig();
  ui.mcpUrl.value = cfg.figmaMcpUrl || 'http://127.0.0.1:3845/mcp';
  ui.back.addEventListener('click', () => api.navigate('launcher'));
  ui.connect.addEventListener('click', connect);
  ui.extract.addEventListener('click', extract);
  ui.copy.addEventListener('click', copyPreview);
  ui.send.addEventListener('click', send);
  ui.siteLink.addEventListener('click', (e) => { e.preventDefault(); api.openExternal('https://tbldr.com.br'); });

  await applyGate(cfg);
}

init();
