'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe API surface exposed to the launcher renderer.
contextBridge.exposeInMainWorld('thinkam', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  checkApi: (apiUrl) => ipcRenderer.invoke('api:health', apiUrl),
  checkFigmaBridge: (port) => ipcRenderer.invoke('figma:check', port),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  navigate: (page) => ipcRenderer.invoke('nav:go', page),
  // Auth (native login + plan gating)
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  getAuth: () => ipcRenderer.invoke('auth:get'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  // Figma MCP bridge
  figmaConnect: (url) => ipcRenderer.invoke('figma:connect', url),
  figmaExtract: (tool, args) => ipcRenderer.invoke('figma:extract', { tool, args }),
  figmaGenerate: (context, projectName) => ipcRenderer.invoke('figma:generate', { context, projectName }),
  // Native generation wizard
  getVersion: () => ipcRenderer.invoke('app:version'),
  genAnalyze: (context, projectName) => ipcRenderer.invoke('gen:analyze', { context, projectName }),
  genPreview: (request) => ipcRenderer.invoke('gen:preview', request),
  genGenerate: (request) => ipcRenderer.invoke('gen:generate', request),
  genJob: (jobId) => ipcRenderer.invoke('gen:job', jobId),
  genFetch: (downloadUrl) => ipcRenderer.invoke('gen:fetch', downloadUrl),
  genPickFolder: (defaultPath) => ipcRenderer.invoke('gen:pickFolder', defaultPath),
  genSave: (destDir) => ipcRenderer.invoke('gen:save', destDir),
  genNpmInstall: (projectDir) => ipcRenderer.invoke('gen:npmInstall', projectDir),
  saveWizardInputs: (inputs) => ipcRenderer.invoke('wizard:saveInputs', inputs),
  loadWizardInputs: () => ipcRenderer.invoke('wizard:loadInputs'),
  listLlmModels: (request) => ipcRenderer.invoke('llm:models', request),
});
