'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { FigmaMcpClient, DEFAULT_MCP_URL } = require('./figma-mcp');
const { hasProvider, callLlm, extractCode } = require('./local-llm');

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

// Extracts every entry of a ZIP buffer onto disk under destDir. Reuses the
// central-directory scan from listZipEntries but also reads each entry's
// LOCAL header (name/extra length can differ from the central directory)
// to find the real compressed-data offset, then either copies it (method 0,
// stored) or inflates it (method 8, deflate) — the only two methods project
// zips use. No external dependency, matching listZipEntries above.
function extractZip(buffer, destDir) {
  const EOCD = 0x06054b50;
  const CDFH = 0x02014b50;
  const LFH = 0x04034b50;
  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Arquivo ZIP inválido ou corrompido.');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  let fileCount = 0;
  const topLevelDirs = new Set();

  for (let n = 0; n < count && offset + 46 <= buffer.length; n++) {
    if (buffer.readUInt32LE(offset) !== CDFH) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    const firstSegment = name.split('/')[0];
    if (firstSegment) topLevelDirs.add(firstSegment);

    const destPath = path.join(destDir, name);
    if (!destPath.startsWith(path.normalize(destDir))) continue; // guard against zip-slip

    if (name.endsWith('/')) {
      fs.mkdirSync(destPath, { recursive: true });
      continue;
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== LFH) continue;
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compSize);
    const content = method === 8 ? zlib.inflateRawSync(compressed) : compressed;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content);
    fileCount++;
  }
  return { fileCount, topLevelDirs: [...topLevelDirs] };
}

ipcMain.handle('gen:pickFolder', async (_e, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolha onde salvar o projeto',
    defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0] };
});

function findNpmBinary() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// tsc/ng-build/npm all emit ANSI color codes even when stdout is piped
// (not a real TTY), which show up as raw "[90m"/"[0m" junk once captured as
// plain text — and, worse, break extractErrorFiles()'s regex when a color
// reset lands between a filename and its ":line:col", silently preventing
// auto-fix from ever finding the file to correct.
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// On Windows, npm is npm.cmd — spawning a .cmd with shell:false throws
// EINVAL synchronously (before even reaching the 'error' event), so this
// must go through the shell there. Args/cwd are always fixed literals (no
// user input reaches the shell), so this is safe despite Node's generic
// shell:true warning. Unix doesn't need this — npm is a real executable.
function runNpm(cwd, args, fallbackError) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(findNpmBinary(), args, {
        cwd,
        shell: process.platform === 'win32',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (err) {
      resolve({ ok: false, error: `Não foi possível iniciar o npm (${err.message}).` });
      return;
    }
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('error', (err) => resolve({ ok: false, error: `npm não encontrado no PATH local (${err.message}).` }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      // Type errors (the class of bug a build catches) tend to produce long,
      // detailed esbuild/tsc output — keep more tail than a typical npm
      // install failure so the actual error survives the truncation.
      const clean = stripAnsi(output).trim();
      resolve({ ok: false, error: clean.slice(-2500) || `${fallbackError} (código ${code}).` });
    });
  });
}

const runNpmInstall = (cwd) => runNpm(cwd, ['install'], 'npm install falhou');
const runNpmBuild = (cwd) => runNpm(cwd, ['run', 'build'], 'npm run build falhou');

// Two-phase download: fetch keeps the zip in memory and returns its file
// structure for preview; save extracts it onto disk in a user-chosen folder
// and runs `npm install` locally — the heavy dependency-resolution work
// happens on the user's machine instead of the (memory-constrained) server.
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

ipcMain.handle('gen:save', async (_e, destDir) => {
  if (!lastZip) return { ok: false, error: 'Nada para salvar — gere o projeto primeiro.' };
  try {
    const baseDir = destDir && fs.existsSync(destDir) ? destDir : app.getPath('downloads');
    // Every entry in the server's zip is already prefixed with the clean
    // project slug ("allpetz/apps/api/...") — the zip FILENAME additionally
    // carries a job-id suffix ("allpetz-7f99f0ac.zip") that has nothing to
    // do with that internal folder name. Extracting straight into baseDir
    // (not a folder we invent ourselves from the filename) means the real
    // project lands at baseDir/allpetz — not double-nested under a
    // mismatched baseDir/allpetz-7f99f0ac/allpetz.
    fs.mkdirSync(baseDir, { recursive: true });
    const { fileCount, topLevelDirs } = extractZip(lastZip.buffer, baseDir);
    const target = topLevelDirs.length === 1 ? path.join(baseDir, topLevelDirs[0]) : baseDir;
    shell.showItemInFolder(target);
    return { ok: true, path: target, fileCount };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Compiler error output mentions the failing file — either esbuild/ng-build
// style ("src/app/foo.component.ts:574:45:") or classic tsc style
// ("src/foo.ts(12,34):"). Extract unique paths so the fixer knows what to
// read and rewrite, without needing to parse full diagnostic structure.
function extractErrorFiles(errorText, appDir) {
  const matches = new Set();
  const re = /([a-zA-Z0-9_\-./]+\.ts)[:(]\d+[,:]\d+/g;
  let m;
  while ((m = re.exec(errorText))) matches.add(m[1]);
  return [...matches]
    .map((rel) => path.join(appDir, rel))
    .filter((abs) => fs.existsSync(abs) && abs.startsWith(path.normalize(appDir)));
}

const MAX_AUTO_FIX_ATTEMPTS = 3;
const MAX_FILES_PER_FIX = 3; // bound cost/scope of a single fix round

// Asks the configured LLM to correct each file the build error points at,
// writes the correction back, and returns whether it touched anything (the
// caller re-runs the build to see if it actually helped).
async function attemptAutoFix(appDir, errorText, llmConfig, progressCb) {
  const files = extractErrorFiles(errorText, appDir).slice(0, MAX_FILES_PER_FIX);
  if (!files.length) return { touched: [], error: 'Não encontrei nenhum arquivo .ts citado no erro para corrigir.' };

  const touched = [];
  for (const absPath of files) {
    const relPath = path.relative(appDir, absPath);
    if (progressCb) progressCb(relPath);
    const original = fs.readFileSync(absPath, 'utf-8');
    const system =
      'You are fixing a TypeScript compile error in a generated Angular/NestJS project file. ' +
      'You will receive the exact compiler error output and the CURRENT full content of one file. ' +
      'Return ONLY the complete corrected file content — no explanation, no markdown fences, no commentary. ' +
      'Make the minimal change needed to resolve the error(s) shown; preserve all unrelated working code exactly as-is.';
    const user = `Build error output:\n${errorText.slice(0, 4000)}\n\nFile: ${relPath}\n\nCurrent content:\n${original}`;
    const r = await callLlm(llmConfig, system, user);
    if (!r.ok || !r.text) continue; // leave this file alone, build will report it again if still broken
    const fixed = extractCode(r.text);
    if (!fixed || fixed.length < 10) continue;
    fs.writeFileSync(absPath, fixed, 'utf-8');
    touched.push(relPath);
  }
  return { touched, error: touched.length ? null : 'A IA não conseguiu propor uma correção aplicável.' };
}

// Runs `npm install` + `npm run build` locally for each app under the
// extracted project — the "trabalho pesado" of dependency resolution and
// actual TypeScript compilation happens on the user's machine, not the
// server (which only does a lightweight npm-registry resolvability check).
// The build step catches real compile errors (wrong property names, bad
// syntax the AI produced) that a plain `npm install` can't — the case that
// motivated this: `docker compose up --build` failing on a typo 19 minutes
// into a build the user only found out about after the fact.
//
// When a build fails AND the user has a BYOK LLM provider configured (the
// same one from Step 3 — no separate credentials, no new product), retries
// up to MAX_AUTO_FIX_ATTEMPTS times: send the error + failing file(s) to the
// model, write back its correction, rebuild. Gives up and reports the last
// real error if the model can't fix it in that many rounds. With no
// provider configured, behaves exactly as before (report and stop).
ipcMain.handle('gen:npmInstallAndBuild', async (_e, projectDir, llmConfig) => {
  const apps = [
    { key: 'api', dir: path.join(projectDir, 'apps', 'api') },
    { key: 'web', dir: path.join(projectDir, 'apps', 'web') },
  ].filter((a) => fs.existsSync(path.join(a.dir, 'package.json')));

  if (!apps.length) return { ok: false, error: 'Nenhum apps/api ou apps/web com package.json encontrado.' };

  const results = [];
  for (const a of apps) {
    const install = await runNpmInstall(a.dir);
    if (!install.ok) {
      results.push({ app: a.key, stage: 'install', ok: false, error: install.error });
      continue;
    }

    let build = await runNpmBuild(a.dir);
    const autoFixedFiles = [];
    let attempts = 0;
    while (!build.ok && hasProvider(llmConfig) && attempts < MAX_AUTO_FIX_ATTEMPTS) {
      attempts += 1;
      const fix = await attemptAutoFix(a.dir, build.error, llmConfig);
      if (!fix.touched.length) break; // nothing the fixer could act on — stop looping
      autoFixedFiles.push(...fix.touched);
      build = await runNpmBuild(a.dir);
    }

    results.push({
      app: a.key,
      stage: 'build',
      ok: build.ok,
      error: build.error,
      autoFixAttempts: attempts,
      autoFixedFiles: [...new Set(autoFixedFiles)],
    });
  }
  return { ok: results.every((r) => r.ok), results };
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
