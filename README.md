# Token Proctor

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/token-proctor.token-proctor?label=VS%20Marketplace&color=blueviolet)](https://marketplace.visualstudio.com/items?itemName=token-proctor.token-proctor)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/token-proctor.token-proctor)](https://marketplace.visualstudio.com/items?itemName=token-proctor.token-proctor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/navintkr/token-proctor?style=social)](https://github.com/navintkr/token-proctor)

> Pick the right model. Validate the prompt. See the real cost — tokens **and** turns. Before you spend a premium request.

<p align="center">
  <video src="https://github.com/navintkr/token-proctor/raw/main/docs/token-proctor.mp4" controls muted width="720">
    Your browser doesn't render embedded video.
    <a href="docs/token-proctor.mp4">Watch the demo (MP4)</a>.
  </video>
</p>

▶️ **[Watch the 30-second demo](docs/token-proctor.mp4)** (MP4)

An open-source layer on top of **GitHub Copilot** (and any token-priced LLM plan) that answers the three questions every team eventually asks:

1. **Is this prompt ready to run?** — scores completeness 0–100 and suggests follow-ups when it's too vague.
2. **Which model should run it?** — picks the cheapest model that clears the quality bar, with a knob for token-cost vs agent-turn-cost trade-offs.
3. **What will it actually cost?** — projects **tokens × turns × $** before the call, including % of your monthly plan allowance.

Ships as two surfaces from one core:

- **VS Code chat participant** (`@proctor`) — primary UX, built on `vscode.chat` + `vscode.lm`.
- **MCP server** (`token-proctor-mcp`) — same core over Model Context Protocol, works with Copilot CLI, Copilot agent mode, Claude Desktop, Cursor, etc.

100% local. No network calls. We don't proxy prompts anywhere — we call `vscode.lm` (your existing Copilot entitlement) or hand a decision back to the MCP client.

Full design doc: [docs/ANALYSIS.md](docs/ANALYSIS.md).

---

## What's new in v0.4

- **Turn-aware cost projection.** The LLM judge now predicts **how many agent turns** a prompt will need (1 for Q&A, 10–30 for code_large/agentic), and the cost is `inputTokens × outputTokens × turns × model price`. No more hiding the cost of 20-turn agent loops behind a single-call estimate.
- **`optimizeFor` knob** — `tokens` (default) minimizes $/M token price; `turns` minimizes `premium × turns` (great for agent loops that run many rounds); `balanced` splits the difference.
- **Plan-aware allowance %.** Set `plan.monthlyTokenAllowance` in your policy and the summary shows **"this prompt ≈ 4.5% of your squad-plan monthly tokens"**.
- **Exact tokenization on by default** via `js-tiktoken` (hard dep) using `o200k_base`.
- **Copilot agent hand-off.** After confirmation, Token Proctor can launch a new Copilot Chat turn with the redacted prompt so Copilot's *own* agent tools (file edits, terminal) drive the work. Model-dropdown auto-switching is attempted but depends on the Copilot Chat build (VS Code does not expose a public API for this yet).
- **Renamed** from Copilot Conductor → Token Proctor. Participant is now `@proctor`, policy file is `.token-proctor.json`, settings prefix is `tokenProctor.*`.

---

## Prerequisites

- **Node.js** ≥ 20
- **VS Code** ≥ 1.95
- **GitHub Copilot** extension installed and signed in (Business or Enterprise entitlement recommended for premium models)

---

## Quick start

```bash
git clone https://github.com/<your-org>/token-proctor.git
cd token-proctor
npm install
npm run compile
```

### Try the chat participant

1. Open this folder in VS Code.
2. Press **F5** → an **Extension Development Host** window opens.
3. In the new window, make sure the workspace is the same `token-proctor` folder (so `.token-proctor.json` loads).
4. Open **Copilot Chat** (`Ctrl+Shift+I`) and type:

```
@proctor add caching to fetchUser so repeated calls within 5s return the same result
```

Sample output:

```
Task: code_small (confidence 90%)
Completeness: ✅ 72/100 (ready)
Recommended model: gpt-4o-mini
Estimate: ~210 in / ~180 out × 2 turns · ~$0.0005 · base quota · model=gpt-4o-mini · plan=squad 0.01%
<sub>tokens=exact · judge=on · policy=.token-proctor.json</sub>

🧠 llm-judge(gpt-4o-mini): task=code_small conf=0.90 out≈180 turns≈2 — ...

---
Recommended model: gpt-4o-mini

🚀 Accept & hand off to Copilot — switches Copilot's chat model to the recommendation
and lets the Copilot agent drive the change with its own tools (edits, terminal, etc.).
```

Click **🚀 Accept & hand off to Copilot** to have Copilot's default agent take over with file/terminal tools. Token Proctor tries to flip the chat model dropdown automatically (a handful of best-effort command ids); if your Copilot build doesn't expose any of them, you'll see a toast asking you to pick the model manually.

### Slash commands

| Command | What it does |
|---|---|
| `@proctor /route <prompt>` | Default. Classify → validate → route → project cost. |
| `@proctor /validate <prompt>` | Completeness report with weighted dimensions + follow-ups. |
| `@proctor /cost <prompt>` | Per-turn and total tokens, turns, USD, plan burn %. |
| `@proctor /explain <prompt>` | Everything + the full candidate model matrix. |
| `@proctor /confirm <prompt>` | Confirm the last recommendation and forward. |
| `@proctor /cancel` | Abandon a pending confirmation. |

### Try the MCP server

```bash
npm run compile
node ./out/mcp-server.js
```

Register it with your MCP client. Example (`.vscode/mcp.json`):

```json
{
  "servers": {
    "token-proctor": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/out/mcp-server.js"]
    }
  }
}
```

For **Copilot CLI** / Claude Desktop:

```json
{
  "mcpServers": {
    "token-proctor": {
      "command": "npx",
      "args": ["-y", "token-proctor-mcp"]
    }
  }
}
```

Tools exposed:

| Tool | Purpose |
|---|---|
| `analyze_prompt` | Full pipeline — redact, classify, validate, route, project cost. |
| `validate_prompt` | Completeness score + follow-up questions. |
| `recommend_model` | Task classification + best model + alternatives. |
| `estimate_cost` | Tokens + turns + USD against an auto-routed or named model. |
| `list_models` | The model catalog (prices, premium multipliers). |
| `redact_text` | Redact secrets using built-in + policy patterns. |
| `get_policy` | Return the loaded `.token-proctor.json` policy and its source path. |

---

## Configuration

### VS Code settings

```jsonc
{
  "tokenProctor.completenessThreshold": 60,
  "tokenProctor.autoForward": true,
  "tokenProctor.requireConfirmation": true,
  "tokenProctor.handoffToCopilot": true,
  "tokenProctor.handoffParticipant": "github.copilot",
  "tokenProctor.preferCheap": false,
  "tokenProctor.optimizeFor": "tokens",      // "tokens" | "turns" | "balanced"
  "tokenProctor.exactTokenCounts": true,
  "tokenProctor.llmJudge.enabled": true,
  "tokenProctor.llmJudge.confidenceThreshold": 0.85
}
```

### `optimizeFor` — the key routing knob

| Mode | Weights | Best for |
|---|---|---|
| `tokens` *(default)* | prioritize $/M token price | One-shot Q&A, docs, creative |
| `turns` | prioritize low `premium × turns` burn | Agent loops (`code_large`, `agentic`) |
| `balanced` | weighted compromise | Mixed workloads |

**Why it matters:** Claude Sonnet has a 1× premium multiplier. On an agentic prompt predicted to run 20 turns, that's 20 premium requests. An `o4-mini` at 0.33× would burn ~6.6 — about 70% less of your monthly bucket. `optimizeFor: turns` surfaces that trade-off.

### Policy file — `.token-proctor.json`

Drop at workspace root (or `~/.token-proctor/config.json`):

```json
{
  "allowModels": ["gpt-4o-mini", "gpt-4o", "claude-sonnet-4", "o4-mini", "gemini-flash"],
  "denyModels": ["claude-opus"],
  "premiumModelsAllowedFor": ["code_large", "reasoning"],
  "optimizeFor": "balanced",
  "preferCheap": true,
  "completenessThreshold": 60,
  "redact": {
    "builtins": true,
    "patterns": ["CORP-[A-Z0-9]{12}"],
    "blockOnMatch": false
  },
  "audit": {
    "enabled": true,
    "path": ".token-proctor/audit.jsonl"
  },
  "llmJudge": {
    "enabled": true,
    "confidenceThreshold": 0.85
  },
  "plan": {
    "name": "squad",
    "monthlyTokenAllowance": 10000000,
    "overageUsdPerM": 5.0
  }
}
```

Block reference:

- **allow/deny/premium-for-task** — gate the model pool the router can pick from.
- **redact** — built-in detectors cover AWS access/secret keys, GitHub/Slack/OpenAI/Stripe tokens, JWTs, PEM private keys, Google API keys. Matches are replaced with `[REDACTED:kind]` before anything leaves the pure-function core. The forwarded prompt never contains raw secrets.
- **audit** — opt-in JSONL log of every decision (task, model, cost, redactions, verdict). Local file; no network.
- **llmJudge** — when rule-based confidence < `confidenceThreshold`, call the cheapest available `vscode.lm` model to classify + estimate output tokens + estimate turns.
- **plan** — token-based plan context. When `monthlyTokenAllowance` is set, the summary shows **"plan=`name` X.Y%"**.

### Exact token counting

`js-tiktoken` is a regular dependency; token counts are exact (`o200k_base`) on every run. The summary tags `tokens=exact`. If the dep fails to load for some reason, falls back to a `chars/4 + punctuation` heuristic and tags `tokens=heuristic`.

### Model catalog

Prices and premium multipliers are plain data in [`src/data/pricing.ts`](src/data/pricing.ts). Fork it, tune it for your org's real rates, ship it.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ VS Code Chat Participant (@proctor)                    │ ◄── primary UX
│ src/participant.ts                                       │
└────────────┬────────────────────────────────────────────┘
             │
             │             ┌───────────────────────────────┐
             ▼             ▼                               │
   ┌────────────────────────────────────┐                  │
   │ Core (src/core/)                   │   src/mcp-server.ts
   │   taskClassifier • promptValidator │ ◄── same core over MCP
   │   modelRouter • costEstimator      │
   │   llmJudge • redactor • policy     │
   │   tokens (js-tiktoken) • audit     │
   └────────────────────────────────────┘
             ▲
             │
   ┌─────────┴──────────┐
   │ src/data/pricing.ts │  ← model catalog, override per org
   └────────────────────┘
```

Core modules are pure functions (except `policy` and `audit` which touch the filesystem). No globals, no network. Trivial to unit-test, easy to swap any piece.

---

## Why this exists

Copilot Business/Enterprise (and most token-priced LLM plans) bill per **premium request** or per **token**. In practice, most overspend comes from:

- Users defaulting to the most powerful model for trivial edits.
- Vague prompts that require many expensive round-trips to finish.
- Agent mode running 10–30 turns of a 1× premium model on what could have been a 2-turn job on a 0× model.

Token Proctor surfaces all three *before* the call. It's the cheapest lever an org can pull on LLM spend — and it composes with, rather than replaces, whatever the underlying chat or agent does next.

---

## Roadmap

- [x] v0.1 — classifier, validator, router, cost, chat participant, MCP server.
- [x] v0.2 — `.token-proctor.json` policy (allow/deny/premium-gating) + secret redaction + JSONL audit log.
- [x] v0.3 — LLM judge fallback classifier + `js-tiktoken` for exact counts.
- [x] v0.4 — **turns-aware cost projection**, **plan-aware allowance %**, **`optimizeFor` knob**, **Copilot agent hand-off**, rename to Token Proctor.
- [ ] v0.5 — `vscode.lm.registerTool` so Copilot agent mode can call Proctor directly mid-turn.
- [ ] v0.6 — Server-side GitHub Copilot Extension for centralized org routing and fleet-wide budget enforcement.

---

## License

MIT. See [LICENSE](LICENSE).
