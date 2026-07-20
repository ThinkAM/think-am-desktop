'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { FigmaMcpClient, DEFAULT_MCP_URL } = require('./figma-mcp');

const IS_DEV = process.argv.includes('--dev');
const SESSION_PARTITION = 'persist:thinkam';

const DEFAULT_CONFIG = {
  apiUrl: 'https://api.tbldr.com.br',
  appUrl: 'https://tbldr.com.br',
  figmaBridgePort: 3845,
  figmaMcpUrl: DEFAULT_MCP_URL,
};

let figmaClient = null;

let mainWindow = null;

// --- config persistence -----------------------------------------------------

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist config:', err);
  }
  return next;
}

// --- auth (native login + plan gating) --------------------------------------

function authPath() {
  return path.join(app.getPath('userData'), 'auth.json');
}

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(authPath(), 'utf-8'));
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  try {
    fs.writeFileSync(authPath(), JSON.stringify(auth), 'utf-8');
  } catch (err) {
    console.error('Failed to persist auth:', err);
  }
}

function clearAuth() {
  try {
    fs.rmSync(authPath(), { force: true });
  } catch {
    /* ignore */
  }
}

// Architect = paid plan. Mirrors the web app's hasArchitectAccess logic.
function hasArchitect(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const ba = user.builderAccess || {};
  if (ba.plan === 'architect' && ba.status === 'active') return true;
  return user.plan === 'architect';
}

// --- window -----------------------------------------------------------------

function launcherFile() {
  return path.join(__dirname, 'launcher.html');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0b1220',
    show: false,
    title: 'Think A.M. Builder',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      partition: SESSION_PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(launcherFile());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Open target=_blank / external links in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function backToLauncher() {
  if (mainWindow) mainWindow.loadFile(launcherFile());
}

// --- app menu ---------------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: 'Think A.M.',
      submenu: [
        { label: 'Connection / Login', accelerator: 'CmdOrCtrl+L', click: backToLauncher },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open tbldr.com.br', click: () => shell.openExternal('https://tbldr.com.br') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC ---------------------------------------------------------------------

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (_e, patch) => saveConfig(patch || {}));

// Ping the API from the main process (no browser CORS restrictions).
ipcMain.handle('api:health', async (_e, apiUrl) => {
  const base = (apiUrl || loadConfig().apiUrl).replace(/\/+$/, '');
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), ms: Date.now() - started };
  }
});

// Check whether a local Figma desktop MCP bridge is listening (desktop-only advantage).
ipcMain.handle('figma:check', async (_e, port) => {
  const p = Number(port) || loadConfig().figmaBridgePort;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (reachable) => {
      socket.destroy();
      resolve({ reachable, port: p });
    };
    socket.setTimeout(1200);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(p, '127.0.0.1');
  });
});

ipcMain.handle('shell:external', (_e, url) => {
  if (typeof url === 'string' && url.startsWith('http')) shell.openExternal(url);
});

// Navigate the main window between local pages (launcher ↔ wizard ↔ bridge).
ipcMain.handle('nav:go', (_e, page) => {
  const safe = { launcher: 'launcher.html', bridge: 'bridge.html', wizard: 'wizard.html' };
  const file = safe[page] || 'launcher.html';
  if (mainWindow) mainWindow.loadFile(path.join(__dirname, file));
});

ipcMain.handle('app:version', () => app.getVersion());

// --- auth IPC ----------------------------------------------------------------

ipcMain.handle('auth:login', async (_e, creds) => {
  const { email, password } = creds || {};
  const base = (loadConfig().apiUrl || DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // API expects `loginIdentifier` (email or username), not `email`.
      body: JSON.stringify({ loginIdentifier: email, password }),
    });
    if (!res.ok) {
      const status = res.status;
      let message = `Falha no login (HTTP ${status}).`;
      if (status === 401) message = 'E-mail ou senha inválidos.';
      else {
        try {
          const body = await res.json();
          if (body && body.error) message = body.error;
        } catch { /* body wasn't JSON, keep default message */ }
      }
      return { ok: false, status, error: message };
    }
    const data = await res.json();
    saveAuth({ token: data.token, user: data.user });
    return { ok: true, user: data.user, architect: hasArchitect(data.user) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('auth:get', () => {
  const a = loadAuth();
  return a ? { user: a.user, architect: hasArchitect(a.user) } : null;
});

ipcMain.handle('auth:logout', () => {
  clearAuth();
  return { ok: true };
});

// --- Figma MCP bridge (client-side, talks to the LOCAL Figma desktop) --------
// Whole feature is Architect-only (paid) and desktop-exclusive.

function requireArchitect() {
  const a = loadAuth();
  if (!a) return { error: 'Faça login para usar a ponte Figma.', reason: 'auth' };
  if (!hasArchitect(a.user)) return { error: 'Recurso exclusivo do plano Architect.', reason: 'upgrade' };
  return null;
}

ipcMain.handle('figma:connect', async (_e, url) => {
  const gate = requireArchitect();
  if (gate) return { ok: false, ...gate };
  try {
    figmaClient = new FigmaMcpClient(url || loadConfig().figmaMcpUrl || DEFAULT_MCP_URL);
    const info = await figmaClient.initialize();
    const tools = await figmaClient.listTools();
    return {
      ok: true,
      server: (info && info.serverInfo) || null,
      preferred: FigmaMcpClient.preferredTool(tools),
      tools: tools.map((t) => ({ name: t.name, description: t.description || '' })),
    };
  } catch (err) {
    figmaClient = null;
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('figma:extract', async (_e, payload) => {
  const { tool, args } = payload || {};
  try {
    if (!figmaClient) throw new Error('Not connected to the Figma MCP.');
    if (!tool) throw new Error('No tool selected.');
    const finalArgs = { ...(args || {}) };
    if (tool === 'get_design_context') {
      if (!finalArgs.clientLanguages) finalArgs.clientLanguages = 'typescript,html,css';
      if (!finalArgs.clientFrameworks) finalArgs.clientFrameworks = 'angular';
    }
    const result = await figmaClient.callTool(tool, finalArgs);
    // The Figma MCP reports tool-level failures inside the result payload.
    if (result && result.isError) {
      const text = (result.content || [])
        .filter((p) => p && p.type === 'text')
        .map((p) => p.text)
        .join(' ');
      return { ok: false, error: text || 'Figma MCP tool error.' };
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Bridge the extracted design context to the Think A.M. API (which proxies to knowledge).
ipcMain.handle('figma:generate', async (_e, payload) => {
  const gate = requireArchitect();
  if (gate) return { ok: false, ...gate };
  const { context, projectName } = payload || {};
  const auth = loadAuth();
  const base = (loadConfig().apiUrl || DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '');
  const endpoint = `${base}/api/code-generation/design-sources/analyze`;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ projectName: projectName || null, figmaContext: context }),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, endpoint, body: body.slice(0, 4000) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), endpoint };
  }
});

// --- native generation wizard (no embedded site) ------------------------------

function requireAuth() {
  const a = loadAuth();
  if (!a || !a.token) return { error: 'Faça login para gerar projetos.', reason: 'auth' };
  return null;
}

function apiBase() {
  return (loadConfig().apiUrl || DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '');
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2000) }; }
  return { status: res.status, ok: res.ok, body };
}

// Runs the pre-extracted local-MCP context through the same analysis pipeline
// the hosted wizard uses; returns the full parsed analysis (routes/screens).
ipcMain.handle('gen:analyze', async (_e, payload) => {
  const gate = requireAuth();
  if (gate) return { ok: false, ...gate };
  const { context, projectName } = payload || {};
  const auth = loadAuth();
  try {
    const r = await apiJson(`${apiBase()}/api/code-generation/design-sources/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ projectName: projectName || null, figmaContext: context || null }),
    });
    return { ok: r.ok, status: r.status, analysis: r.ok ? r.body : null, error: r.ok ? null : extractApiError(r.body, r.status) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Kicks off code generation. Returns { async: true, jobId } on 202 or the
// sync result on 200.
ipcMain.handle('gen:generate', async (_e, request) => {
  const gate = requireAuth();
  if (gate) return { ok: false, ...gate };
  const auth = loadAuth();
  try {
    const r = await apiJson(`${apiBase()}/api/code-generation/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify(request || {}),
    });
    if (r.status === 202) {
      return { ok: true, async: true, jobId: r.body && (r.body.jobId || r.body.job_id), sessionId: r.body && (r.body.sessionId || r.body.session_id) };
    }
    if (r.ok) {
      return {
        ok: true,
        async: false,
        downloadUrl: r.body && (r.body.downloadUrl || r.body.download_url),
        projectName: r.body && (r.body.projectName || r.body.project_name),
        sizeBytes: r.body && (r.body.sizeBytes || r.body.size_bytes),
      };
    }
    return { ok: false, status: r.status, error: extractApiError(r.body, r.status) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Polls an async generation job (knowledge JSON is snake_case; tolerate both).
ipcMain.handle('gen:job', async (_e, jobId) => {
  const gate = requireAuth();
  if (gate) return { ok: false, ...gate };
  const auth = loadAuth();
  try {
    const r = await apiJson(`${apiBase()}/api/code-generation/jobs/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!r.ok) return { ok: false, status: r.status, error: extractApiError(r.body, r.status) };
    const b = r.body || {};
    return {
      ok: true,
      status: b.status,
      progress: b.progress,
      downloadUrl: b.download_url || b.downloadUrl || null,
      error: b.error || null,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Runs the same request through /preview-manifest so the user can review the
// generation plan (routes, screens, stack, inferred modules) before generating.
ipcMain.handle('gen:preview', async (_e, request) => {
  const gate = requireAuth();
  if (gate) return { ok: false, ...gate };
  const auth = loadAuth();
  try {
    const r = await apiJson(`${apiBase()}/api/code-generation/preview-manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify(request || {}),
    });
    if (!r.ok) return { ok: false, status: r.status, error: extractApiError(r.body, r.status) };
    return { ok: true, manifest: (r.body && r.body.manifest) || r.body };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Minimal ZIP central-directory reader — entry names only, no dependencies.
function listZipEntries(buffer) {
  const EOCD = 0x06054b50;
  const CDFH = 0x02014b50;
  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - 65557); // max comment + EOCD size
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count && offset + 46 <= buffer.length; n++) {
    if (buffer.readUInt32LE(offset) !== CDFH) break;
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// Two-phase download: fetch keeps the zip in memory and returns its file
// structure for preview; save writes it to the OS Downloads folder.
let lastZip = null; // { fileName, buffer }

ipcMain.handle('gen:fetch', async (_e, downloadUrl) => {
  try {
    const fileName = String(downloadUrl || '').split('/').pop() || 'project.zip';
    const res = await fetch(`${apiBase()}/api/code-generation/download/${encodeURIComponent(fileName)}`);
    if (!res.ok) return { ok: false, error: `Download falhou (HTTP ${res.status}).` };
    const buffer = Buffer.from(await res.arrayBuffer());
    lastZip = { fileName, buffer };
    return { ok: true, fileName, sizeBytes: buffer.length, files: listZipEntries(buffer) || [] };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('gen:save', async () => {
  if (!lastZip) return { ok: false, error: 'Nada para salvar — gere o projeto primeiro.' };
  try {
    const target = path.join(app.getPath('downloads'), lastZip.fileName);
    fs.writeFileSync(target, lastZip.buffer);
    shell.showItemInFolder(target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Lists the LLM models available with the user's BYOK credentials (server-side
// listing — Bedrock requires AWS SigV4 signing the client can't do alone).
ipcMain.handle('llm:models', async (_e, request) => {
  const gate = requireAuth();
  if (gate) return { ok: false, ...gate };
  const auth = loadAuth();
  try {
    const r = await apiJson(`${apiBase()}/api/code-generation/llm/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify(request || {}),
    });
    if (!r.ok) return { ok: false, error: extractApiError(r.body, r.status) };
    const body = r.body || {};
    if (!body.ok) return { ok: false, error: body.error || 'Falha ao listar modelos.' };
    return { ok: true, models: body.models || [] };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Persist the last generation inputs so the user can reuse them next time.
function wizardInputsPath() {
  return path.join(app.getPath('userData'), 'wizard-last.json');
}

ipcMain.handle('wizard:saveInputs', (_e, inputs) => {
  try {
    fs.writeFileSync(wizardInputsPath(), JSON.stringify(inputs || {}, null, 2), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('wizard:loadInputs', () => {
  try {
    return JSON.parse(fs.readFileSync(wizardInputsPath(), 'utf-8'));
  } catch {
    return null;
  }
});

function extractApiError(body, status) {
  if (body) {
    if (typeof body.error === 'string') return body.error;
    if (typeof body.detail === 'string') return body.detail;
    if (typeof body.title === 'string') return body.title;
    if (typeof body.raw === 'string' && body.raw.trim()) return body.raw.slice(0, 300);
  }
  if (status === 401) return 'Sessão expirada — faça login novamente.';
  if (status === 402) return 'Limite do plano Free atingido (3 gerações/mês). Faça upgrade para o plano Builder.';
  if (status === 403) return 'Recurso não disponível no seu plano.';
  return `Falha na requisição (HTTP ${status}).`;
}

// --- lifecycle ---------------------------------------------------------------

app.whenReady().then(() => {
  // Give the persistent session a friendly UA suffix for observability.
  session.fromPartition(SESSION_PARTITION).setUserAgent(
    session.fromPartition(SESSION_PARTITION).getUserAgent() + ' ThinkAMDesktop/' + app.getVersion(),
  );
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
