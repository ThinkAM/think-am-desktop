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

// Load the Builder web app in the same (persistent) session window.
ipcMain.handle('app:open', (_e, appUrl) => {
  const url = (appUrl || loadConfig().appUrl).replace(/\/+$/, '');
  if (mainWindow) mainWindow.loadURL(url);
  return { ok: true, url };
});

ipcMain.handle('shell:external', (_e, url) => {
  if (typeof url === 'string' && url.startsWith('http')) shell.openExternal(url);
});

// Navigate the main window between local pages (launcher ↔ bridge).
ipcMain.handle('nav:go', (_e, page) => {
  const safe = { launcher: 'launcher.html', bridge: 'bridge.html' };
  const file = safe[page] || 'launcher.html';
  if (mainWindow) mainWindow.loadFile(path.join(__dirname, file));
});

// --- auth IPC ----------------------------------------------------------------

ipcMain.handle('auth:login', async (_e, creds) => {
  const { email, password } = creds || {};
  const base = (loadConfig().apiUrl || DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: res.status === 401 ? 'E-mail ou senha inválidos.' : `Falha no login (HTTP ${res.status}).` };
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
    const result = await figmaClient.callTool(tool, args || {});
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
