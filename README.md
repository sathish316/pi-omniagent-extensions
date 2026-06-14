# Pi Omniagent extensions

## Pi Agent Extensions — How Each One Works

### The common idea (read this first)

All four files do the same job: they let Pi (the host coding agent) drive another coding agent's CLI as if it were just another model in Pi's `/model` picker. You pick "Cursor Sonnet" or "GPT-5 [codex-app-server]" or "Opus [claude-code-acp]" in Pi, and your turn is secretly executed by that external agent running in your workspace.

They all follow this shape:

```
┌────────────────────────────────────────────────────────────────────┐
│ Pi host process                                                    │
│                                                                    │
│   /model picker ──► pi.registerProvider(...)                       │
│        │                                                           │
│        │ streamSimple(model, context)                              │
│        ▼                                                           │
│   ┌─────────────┐   builds prompt    ┌──────────────────────┐      │
│   │  Provider   │ ─────────────────► │   Bridge (singleton) │      │
│   │  stream fn  │ ◄───────────────── │  serializes turns,   │      │
│   └─────────────┘   stream events    │  owns 1 session      │      │
│        ▲                             └──────────┬───────────┘      │
│        │ AssistantMessageEventStream            │ spawn            │
│        │ (text/thinking deltas)                 ▼                  │
└────────┼────────────────────────────────────────┼──────────────────┘
         │                                        │
         │                                        ▼
         │                              ┌───────────┬──────────┐
         └──── JSON-RPC over stdio ───► │ Child process (CLI)  │
                                        │ cursor-agent / rovo  │
                                        │ codex / claude-acp   │
                                        └──────────────────────┘
```

The bundled extensions:

- `cursor-acp.ts` — Cursor Agent over ACP
- `codex-app-server.ts` — OpenAI Codex over app-server
- `claude-code-acp.ts` — Claude Code over ACP (uses the official ACP SDK)
- `rovo-acp.ts` — Atlassian Rovo Dev over ACP

## Installing into `~/.pi/agent/extensions`

Pi auto-discovers `*.ts` files in `~/.pi/agent/extensions`, but external npm dependencies are not bundled into those files.

1. Clone this repo:

   ```bash
   git clone https://github.com/sathish316/pi-omniagent-extensions.git
   cd pi-omniagent-extensions
   ```

2. Copy the extension files into your Pi extensions directory:

   ```bash
   mkdir -p ~/.pi/agent/extensions
   cp cursor-acp.ts rovo-acp.ts codex-app-server.ts claude-code-acp.ts \
      package.json ~/.pi/agent/extensions/
   ```

3. Install the extension dependencies:

   ```bash
   cd ~/.pi/agent/extensions
   npm install
   npm run check:claude-code-acp-deps
   ```

4. Make sure the underlying agent CLIs are installed and on your `PATH` for the
   extensions you want to use: `cursor-agent` (cursor-acp), `rovo` (rovo-acp),
   `codex` (codex-app-server). `claude-code-acp` pulls its runtime from npm.

5. Restart Pi. The bridged models appear in the `/model` picker tagged with
   their provider, e.g. `[codex-app-server]` or `[claude-code-acp]`.

The `claude-code-acp.ts` extension needs:

- `@agentclientprotocol/sdk`
- `@agentclientprotocol/claude-agent-acp`

The Pi API packages imported by the extensions are provided by the running Pi installation.
