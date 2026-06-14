# Usage Guide — Switching Models in Pi

This guide shows how to switch Pi to a model provided by each of the four
extensions in this directory, with a concrete example for every one. Each example
asks the bridged agent to **write a Haskell quicksort**, so you can compare the
agents directly.

For how these extensions work internally, see `HOW_IT_WORKS.md`.

---

## Prerequisites

1. **Install extension dependencies** (only `claude-code-acp` strictly needs them,
   but install once for all):

   ```bash
   cd ~/.pi/agent/extensions
   npm install
   npm run check:claude-code-acp-deps
   ```

2. **Install and authenticate each external CLI** you intend to use. Each
   extension spawns its CLI as a child process and discovers models at startup, so
   the CLI must be on your `PATH` and logged in:

   | Extension | Required CLI | Default command |
   |-----------|-------------|-----------------|
   | cursor-acp | Cursor Agent | `cursor-agent acp` |
   | codex-app-server | OpenAI Codex | `codex app-server` |
   | claude-code-acp | (bundled npm package) | runs `@agentclientprotocol/claude-agent-acp` via Node |
   | rovo-acp | Atlassian Rovo Dev | `rovo acp` |

3. **Restart Pi** after install so the extensions reload and re-discover models.

---

## How model switching works (the short version)

1. Open the model picker in Pi: **`/model`**.
2. Look for entries tagged with the provider name in brackets, e.g.
   `… [codex-app-server]`, `… [claude-code-acp]`, or prefixed (`Cursor …`,
   `Rovo …`).
3. Select the model. For cursor / claude-code / rovo, Pi fires a `model_select`
   event and you'll see a confirmation notification (e.g. *"Cursor ACP model
   set: …"*). For Codex, the model is locked in when the first prompt starts the
   thread.
4. Type your prompt. The conversation now runs through that agent.
5. Each extension also offers `*-status` and `*-reset` commands (see per-section
   notes below).

> The exact model **ids and names are discovered dynamically** from each CLI, so
> what you see in `/model` depends on your CLI version and account. The model names
> used below are representative examples — pick whatever the picker actually lists.

---

## 1. cursor-acp — Cursor Agent

**Switch:**

1. `/model`
2. Choose an entry like **`Claude 4.5 Sonnet [cursor-acp]`** (shown as
   `<name> [cursor-acp]`).
   - If Cursor advertises no selectable models, you'll see **`Auto
     [cursor-acp]`** (`default[]`) and the agent picks its own model.
3. You should see: *"Cursor ACP model set: …"*.

**Example prompt:**

```
Write quicksort in Haskell. Keep it idiomatic and add a short comment.
```

**Expected style of result** (the agent generates it; shown here for reference):

```haskell
-- Quicksort: partition around the head, recurse on each side.
quicksort :: Ord a => [a] -> [a]
quicksort []     = []
quicksort (p:xs) = quicksort smaller ++ [p] ++ quicksort larger
  where smaller = [x | x <- xs, x <= p]
        larger  = [x | x <- xs, x >  p]
```

**Useful commands:** `/cursor-acp-status`, `/cursor-acp-reset`.

**Env overrides:** `CURSOR_ACP_COMMAND`, `CURSOR_ACP_ARGS`,
`CURSOR_ACP_AUTO_ALLOW=false` (to deny tool permissions), `CURSOR_ACP_DEBUG=true`.

---

## 2. codex-app-server — OpenAI Codex

**Switch:**

1. `/model`
2. Choose an entry like **`GPT-5.4 [codex-app-server]`** (shown as
   `<displayName> [codex-app-server]`).
3. **Important:** Codex binds the model when the **thread starts**, i.e. on your
   first prompt. There is no `model_select` confirmation. To change models
   mid-session, switch in `/model` then run `/codex-reset` so a new thread starts
   with the new model.

**Example prompt:**

```
Write quicksort in Haskell. Keep it idiomatic and add a short comment.
```

**Expected style of result:**

```haskell
-- Quicksort over any orderable list.
quicksort :: Ord a => [a] -> [a]
quicksort []     = []
quicksort (p:xs) =
  quicksort [x | x <- xs, x <= p] ++ [p] ++ quicksort [x | x <- xs, x > p]
```

**Useful commands:** `/codex-status`, `/codex-reset`.

**Env overrides:** `CODEX_BIN`, `CODEX_APPSERVER_MODEL` (restrict to one model),
`CODEX_APPSERVER_APPROVAL` (`never` | `on-request` | …),
`CODEX_APPSERVER_SANDBOX` (`read-only` | `workspace-write` |
`danger-full-access`), `CODEX_APPSERVER_DEBUG=true`.

> If no Codex models are discovered, the provider is **not registered** and nothing
> appears in `/model` — check that `codex` is installed and authenticated.

---

## 3. claude-code-acp — Claude Code

**Switch:**

1. `/model`
2. Choose an entry like **`Sonnet [claude-code-acp]`** (other typical ids:
   `Opus [claude-code-acp]`, `Haiku [claude-code-acp]`).
3. You should see: *"Claude Code ACP model set: …"*.

**Example prompt:**

```
Write quicksort in Haskell. Keep it idiomatic and add a short comment.
```

**Expected style of result:**

```haskell
-- Classic list-comprehension quicksort.
quicksort :: Ord a => [a] -> [a]
quicksort []     = []
quicksort (p:xs) = quicksort lesser ++ [p] ++ quicksort greater
  where
    lesser  = filter (<= p) xs
    greater = filter (>  p) xs
```

**Useful commands:** `/claude-code-acp-status` (also shows the resolved command),
`/claude-code-acp-reset`.

**Env overrides:** `CLAUDE_CODE_ACP_COMMAND`, `CLAUDE_CODE_ACP_ARGS`,
`CLAUDE_CODE_ACP_AUTO_ALLOW=false`, `CLAUDE_CODE_ACP_DEBUG=true`.

> This is the one extension that requires `npm install` (it imports the official
> ACP SDK). If `/model` shows no Claude Code entries, run
> `npm run check:claude-code-acp-deps` and restart Pi.

---

## 4. rovo-acp — Atlassian Rovo Dev

**Switch:**

1. `/model`
2. Choose an entry like **`Claude 4.5 Sonnet [rovo-acp]`** (shown as
   `<name> [rovo-acp]`), or **`Auto [rovo-acp]`** (`default[]`) if no models are
   advertised.
3. You should see: *"Rovo ACP model set: …"*.

**Example prompt:**

```
Write quicksort in Haskell. Keep it idiomatic and add a short comment.
```

**Expected style of result:**

```haskell
-- Quicksort using a partitioning helper.
quicksort :: Ord a => [a] -> [a]
quicksort []     = []
quicksort (p:xs) = quicksort smaller ++ [p] ++ quicksort larger
  where (smaller, larger) = partition' xs
        partition' = foldr (\x (lo, hi) -> if x <= p then (x:lo, hi) else (lo, x:hi)) ([], [])
```

**Useful commands:** `/rovo-acp-status` (shows current model **and mode**),
`/rovo-acp-reset`.

**Env overrides:** `ROVO_ACP_COMMAND`, `ROVO_ACP_ARGS`,
`ROVO_ACP_MODE` (`default` | `ask` | `YOLO`), `ROVO_ACP_AUTO_ALLOW=false`,
`ROVO_ACP_DEBUG=true`.

> If the `rovo` binary is missing, the bridge fails gracefully with
> *"failed to start rovo acp command …"* instead of crashing Pi.

---

## Quick reference

| Provider | Pick in `/model` as | Set on select? | Status cmd | Reset cmd |
|----------|--------------------|----------------|------------|-----------|
| cursor-acp | `<name> [cursor-acp]` | yes (`model_select`) | `/cursor-acp-status` | `/cursor-acp-reset` |
| codex-app-server | `<name> [codex-app-server]` | at first prompt (thread start) | `/codex-status` | `/codex-reset` |
| claude-code-acp | `<name> [claude-code-acp]` | yes (`model_select`) | `/claude-code-acp-status` | `/claude-code-acp-reset` |
| rovo-acp | `<name> [rovo-acp]` | yes (`model_select`) | `/rovo-acp-status` | `/rovo-acp-reset` |

**Tips**

- After **compacting** a conversation, the bridge resets the external session and
  the next prompt re-sends full context automatically — no action needed.
- Use the **reset** command to start a fresh external session/thread while keeping
  your Pi session (handy after changing the Codex model, or to clear agent state).
- Set `*_AUTO_ALLOW=false` if you want the bridged agent to be **denied** file and
  terminal access (it will refuse tool actions rather than editing your repo).
