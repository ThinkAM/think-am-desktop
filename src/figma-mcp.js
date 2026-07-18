'use strict';

/**
 * Minimal MCP client for the local Figma desktop MCP server.
 *
 * Speaks MCP over the Streamable HTTP transport (JSON-RPC 2.0). The Figma
 * desktop app exposes this locally (default http://127.0.0.1:3845/mcp), which a
 * hosted web app can't reach — this is the whole point of the desktop bridge.
 */

const DEFAULT_MCP_URL = 'http://127.0.0.1:3845/mcp';

// Tools we prefer for pulling a design context, best-first.
const PREFERRED_TOOLS = ['get_design_context', 'get_code', 'get_metadata', 'get_variable_defs'];

class FigmaMcpClient {
  constructor(url) {
    this.url = url || DEFAULT_MCP_URL;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
  }

  async _send(message, { expectResponse = true } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (!expectResponse || res.status === 202) return null;

    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${raw.slice(0, 200)}`);

    const payload = contentType.includes('text/event-stream')
      ? this._parseSse(raw, message.id)
      : raw ? JSON.parse(raw) : null;

    if (payload && payload.error) {
      throw new Error(payload.error.message || `MCP error ${payload.error.code}`);
    }
    return payload ? payload.result : null;
  }

  // Extract the JSON-RPC message matching `id` from an SSE response body.
  _parseSse(raw, id) {
    let fallback = null;
    for (const event of raw.split(/\n\n/)) {
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg.id === id) return msg;
        if (msg.result || msg.error) fallback = msg;
      } catch {
        /* ignore keep-alive / non-JSON events */
      }
    }
    return fallback;
  }

  async initialize() {
    const result = await this._send({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ThinkAMDesktop', version: '0.1.0' },
      },
    });
    // Best-effort "initialized" notification (no response expected).
    await this._send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectResponse: false }).catch(() => {});
    this.initialized = true;
    return result;
  }

  async listTools() {
    if (!this.initialized) await this.initialize();
    const result = await this._send({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} });
    return (result && result.tools) || [];
  }

  async callTool(name, args = {}) {
    if (!this.initialized) await this.initialize();
    return this._send({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  }

  /** Pick the best available design-context tool from a tools list. */
  static preferredTool(tools) {
    const names = new Set((tools || []).map((t) => t.name));
    return PREFERRED_TOOLS.find((n) => names.has(n)) || (tools && tools[0] && tools[0].name) || null;
  }
}

module.exports = { FigmaMcpClient, DEFAULT_MCP_URL, PREFERRED_TOOLS };
