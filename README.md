# Pi Omniagent extensions

## Pi Agent Extensions — How Each One Works

### The common idea (read this first)

All four files do the same job: they let Pi (the host coding agent) drive another coding agent's CLI as if it were just another model in Pi's `/model` picker. It uses ACP (https://agentclientprotocol.com/) to communicate with any coding agent. You pick "Cursor Sonnet" or "GPT-5 [codex-app-server]" or "Opus [claude-code-acp]" in Pi, and your turn is secretly executed by that external agent running in your workspace.

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
      acp-config.sample.json package.json ~/.pi/agent/extensions/
   cp -R acp-lib ~/.pi/agent/extensions/
   ```

   `acp-lib/` holds the shared provider gate the four extensions import, so it
   has to come along. It sits in a subdirectory without an `index.ts` on
   purpose — Pi only auto-loads `extensions/*.ts` and `extensions/<dir>/index.ts`,
   so it is never mistaken for an extension of its own.

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

## Choosing which ACP providers load

Each extension discovers its models by spawning the underlying agent CLI, which
used to be where Pi's startup time went — on this machine, loading all four
cost about **13.9s**. Discovery results are now cached on disk, so the spawn
happens once (first run, or after the cache expires); every later start
registers models from the cache in milliseconds. `acp-config.json` still
decides which providers load at all. See
[Caching model discovery](#caching-model-discovery).

### The config file

Copy the sample once — the real file is gitignored, so it stays local to your
machine:

```bash
cd ~/.pi/agent/extensions
cp acp-config.sample.json acp-config.json
```

It lives next to the extension `.ts` files (`~/.pi/agent/extensions/acp-config.json`)
and is found regardless of Pi's working directory. Set `PI_ACP_CONFIG=/path/to/file.json`
to read it from somewhere else. Line and block comments are allowed.

| Key | Effect |
| --- | --- |
| `enable_acp_models` | Master switch. `false` disables every ACP provider. |
| `enable_all_acp_models` | `true` enables cursor + codex + claude + rovo, ignoring the per-provider keys. |
| `enable_cursor_acp_models` | `true` enables only the Cursor ACP models. |
| `enable_codex_acp_models` | `true` enables only the Codex app-server models. |
| `enable_claude_acp_models` | `true` enables only the Claude Code ACP models. |
| `enable_rovo_acp_models` | `true` enables only the Rovo Dev ACP models. |

Precedence, highest first:

1. `DISABLE_ALL_ACP_MODELS` — kill switch, nothing loads.
2. `DISABLE_<PROVIDER>_ACP` — that provider off.
3. `ENABLE_<PROVIDER>_ACP` — that provider on.
4. `enable_acp_models: false` — nothing loads.
5. `enable_all_acp_models: true` — everything loads.
6. The matching `enable_<provider>_acp_models` key.
7. Nothing set: if **none** of the four per-provider keys are present, all four
   load (the behaviour from before this config existed). As soon as **at least
   one** is present, the ones you left out stay off.

So the "only Cursor" setup is a single key:

```json
{ "enable_cursor_acp_models": true }
```

A missing or unparseable `acp-config.json` falls back to loading everything, so
a typo never silently costs you your models.

### Environment overrides

Two variables per provider, both checked before anything in the file:

| Provider | Force on | Force off |
| --- | --- | --- |
| `cursor-acp` | `ENABLE_CURSOR_ACP` | `DISABLE_CURSOR_ACP` |
| `codex-app-server` | `ENABLE_CODEX_ACP` | `DISABLE_CODEX_ACP` |
| `claude-code-acp` | `ENABLE_CLAUDE_ACP` | `DISABLE_CLAUDE_ACP` |
| `rovo-acp` | `ENABLE_ROVO_ACP` | `DISABLE_ROVO_ACP` |

Plus `DISABLE_ALL_ACP_MODELS`, a kill switch that turns off every provider.

For all of these, any value other than `0` or `false` activates the variable;
unset or empty means "ignore me and defer to the next rule". So an
`ENABLE_*` force-enables a provider **even when the config file disabled it**,
and a `DISABLE_*` force-disables it **even when the config file or an
`ENABLE_*` enabled it**.

**Disable beats enable.** A kill switch something else could override wouldn't
be a kill switch, so `DISABLE_ALL_ACP_MODELS=1` wins even alongside
`ENABLE_CODEX_ACP=1`. Setting a `DISABLE_*` var to `0` or `false` does not force
a provider on — it just stops disabling, and the lower rules decide.

```bash
DISABLE_ALL_ACP_MODELS=1 pi   # ~1s, no ACP models regardless of config
DISABLE_CURSOR_ACP=1 pi       # everything the config enables, minus Cursor
```

This is the fast setup: turn everything off by default, then opt in per shell.

```bash
# ~/.pi/agent/extensions/acp-config.json
{ "enable_acp_models": false }
```

```bash
pi                        # ~1s, no ACP models
ENABLE_CODEX_ACP=1 pi     # Codex models only
ENABLE_CURSOR_ACP=1 ENABLE_CLAUDE_ACP=1 pi   # Cursor + Claude
```

### Caching model discovery

Model lists rarely change, so each provider caches its discovery result in
`~/.pi/agent/extensions/acp-cache/<provider>.json` and registers from the cache
at startup:

- **Cache hit** — models register immediately; no CLI is spawned. A stale cache
  (older than 24h by default) is refreshed in the background after
  `session_start`, so startup never waits for it. When the refreshed list
  differs, the provider is re-registered live — no `/reload` needed.
- **Cache miss** (first run, wiped cache, or a discovery failure) — the
  extension pays the one-time discovery cost during startup so the `/model`
  picker is real from the start, then writes the cache. Failures are not
  cached, so a temporarily missing CLI is retried on the next start.

Force a refresh for every loaded provider with:

```
/acp-config refresh
```

Useful when you just installed a new Cursor/Claude/Codex version and want its
new models without waiting for the TTL.

| Env var | Effect |
| --- | --- |
| `ACP_MODEL_CACHE_TTL_MS` | How long a cached model list stays fresh (default 24h). |
| `PI_ACP_CACHE_DIR` | Read/write caches from another directory. |

The startup summary and `/acp-config` report where each provider's model list
came from — `(cache)`, `(discovered)`, or `(fallback)` — next to the load time.

### What Pi shows at startup

```
ACP model providers loaded: cursor-acp (32 models (cache), 0.00s), codex-app-server (29 models (cache), 0.01s)
ACP model providers skipped: claude-code-acp (enable_claude_acp_models not set), rovo-acp (enable_rovo_acp_models not set)
Time taken for loading ACP models: 0.01s
```

Skipped providers list the rule that turned them off, so it is always clear
whether a model is missing because of the config file, an env toggle, or a CLI
that failed to start.

Run `/acp-config` inside Pi for the full picture — resolved config path, every
key's value, per-provider load time and model-list source, and the current env
toggles. `/acp-config refresh` re-discovers every loaded provider's models and
re-registers them if the list changed.
