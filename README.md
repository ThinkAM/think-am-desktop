# Think A.M. Builder — Desktop

Native desktop client (Electron) for **Think A.M. Builder**. It lets you download an app,
pick/confirm the environment, check the API, and log in to the Builder — with a **persistent
session** and a **local Figma bridge** check that a hosted web app cannot do.

## Why a desktop client

The hosted web app cannot reach services running on your machine (e.g. the **Figma desktop
MCP server** on `localhost:3845`). The desktop client runs locally, so it can detect and talk
to those local services — the intended path for reliable Figma-driven generation.

## Run in development

```bash
cd think-am-desktop
pnpm install        # or npm install
pnpm start          # launches Electron against production (api/app tbldr.com.br)
pnpm dev            # same, with DevTools open
```

## Build installers

```bash
pnpm dist:win       # NSIS installer (.exe)  → dist/
pnpm dist:mac       # DMG
pnpm dist:linux     # AppImage
```

> Add a real app icon before shipping: drop `build/icon.ico` (Windows), `build/icon.icns`
> (macOS) and `build/icon.png` (Linux) and reference them under `build` in `package.json`.

## How it works

| Piece | File | Responsibility |
|-------|------|----------------|
| Main process | `src/main.js` | Window, persistent session (`persist:thinkam`), IPC, menu |
| Preload | `src/preload.js` | Safe `window.thinkam` bridge (contextIsolation on) |
| Launcher UI | `src/launcher.{html,css,js}` | Environment picker, API/Figma checks, "Enter Builder" |
| Figma MCP client | `src/figma-mcp.js` | Minimal MCP client (Streamable HTTP + SSE) for the local Figma server |
| Bridge UI | `src/bridge.{html,css,js}` | Connect → extract design context → send to generation |

### Figma MCP bridge (client-side)

The client talks to the **local** Figma desktop MCP server (default
`http://127.0.0.1:3845/mcp`) — the server never touches your Figma:

1. **Connect** — MCP `initialize` handshake, then `tools/list`.
2. **Extract** — calls a design-context tool (`get_design_context` / `get_metadata` / …),
   optionally scoped to a `nodeId` (empty = current Figma selection), and previews the JSON.
3. **Send** — POSTs the extracted context to `${apiUrl}/api/knowledge/design-sources/analyze`
   as `figma_context`, so the knowledge service generates from the locally-extracted design.

- **Environment**: Production (`api.tbldr.com.br` / `tbldr.com.br`) or a custom API/App URL.
- **API check**: pings `${apiUrl}/health` from the main process (no browser CORS).
- **Figma bridge check**: TCP probe of `127.0.0.1:3845` (configurable).
- **Enter Builder**: loads the web app in the same persistent-session window; the login and
  the API traffic happen there and stay signed in across restarts.

Config is stored at the OS user-data dir (`config.json`).

## Roadmap

- Native login form posting to the API auth endpoint (token via `safeStorage`), so the
  bridge's "Send" can auth automatically instead of pasting a JWT.
- Backend contract: have the knowledge `design-sources/analyze` + `generate` accept the
  client-supplied `figma_context` and use it in place of server-side Figma extraction.
- Hosted installers + wired download buttons on the landing.
- Auto-update (electron-updater).
