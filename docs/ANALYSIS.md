# Token Proctor — Detailed Analysis

An open‑source layer on top of GitHub Copilot that does three things before a request hits a model:

1. **Prompt validation** — is the prompt complete enough to finish in one shot?
2. **Model routing** — which model is the best fit (quality × latency × $)?
3. **Cost estimation** — approximate $ and tokens for this request.

Plus optional: policy guardrails, telemetry, caching, audit log — all the things enterprises actually ask for.

---

## 1. Where can we plug into GitHub Copilot?

GitHub Copilot is not a single product. There are five real extension surfaces, each with different trade‑offs:

| Surface | What it is | Can we route models? | Can we pre‑validate prompts? | Enterprise adoption |
|---|---|---|---|---|
| **VS Code Chat Participant** (`@proctor`) | Custom `@mention` agent in Copilot Chat, uses `vscode.lm` API to call *any* model the user has access to | ✅ Yes — we pick `vscode.lm.selectChatModels({...})` | ✅ Yes — we see the raw prompt first | ★★★★★ (easy, per‑user install, works with Copilot Business/Enterprise) |
| **Language Model Tool** (`vscode.lm.registerTool`) | A tool Copilot's agent mode can call | ❌ No — Copilot chooses the model | ⚠️ Only indirectly (you can *advise* but not gate) | ★★★★ |
| **MCP Server** | Tools/resources exposed via Model Context Protocol; works with Copilot agent mode, Copilot CLI, Claude Desktop, Cursor, etc. | ❌ Not directly, but you can expose a `route_model` tool the agent must call | ✅ Yes, via a `validate_prompt` tool | ★★★★★ (portable across clients) |
| **GitHub Copilot Extension** (GitHub App / platform) | Server‑side extension in the `@github` ecosystem | ✅ Yes — you own the completion | ✅ Yes | ★★★ (heavier: GitHub App, OAuth, hosting) |
| **Standalone CLI / Proxy** | HTTP proxy in front of model endpoints, or a wrapper CLI | ✅ Full control | ✅ Full control | ★★ (doesn't integrate with Copilot Chat UX) |

### Recommendation

Ship **two surfaces from one codebase**:

- **Primary: VS Code Chat Participant** — best UX. The user types `@proctor fix the flaky test in checkout.spec.ts` and we:
  1. classify the task,
  2. score prompt completeness (ask follow‑ups if low),
  3. pick a model,
  4. show estimated cost,
  5. forward to the chosen model via `vscode.lm`, stream the response back.

- **Secondary: MCP Server** — same core logic, exposed as `validate_prompt`, `recommend_model`, `estimate_cost` tools. This works with **Copilot CLI**, **agent mode**, and non‑Copilot clients. Enterprises already govern MCP servers centrally (VS Code 1.102+ has MCP policy controls).

Both wrap the same `core/` library — one source of truth.

---

## 2. Why not just use Copilot's built‑in model picker?

Copilot Chat already lets users pick a model from a dropdown. The gap this project fills:

| Problem with manual picker | What Conductor adds |
|---|---|
| Users default to the most powerful model for everything → wasted premium quota | Routes trivial tasks (rename, docstring, regex) to cheap/fast models |
| No visibility into cost before sending | Inline `~1,420 tokens · ~$0.018 · GPT‑4o‑mini` preview |
| Vague prompts cause multi‑round ping‑pong → premium request quota burns | Completeness score with targeted follow‑up questions before a model is even called |
| No org‑wide policy ("don't send secrets to model X", "PRs must use reasoning model") | Declarative `.conductor.yaml` policy file, loaded per workspace |
| No audit trail | Optional JSONL log of routing decisions |

For GitHub Copilot **Business/Enterprise**, the "premium request" budget is real money. Routing a one‑line rename away from Claude Opus / GPT‑5 to a cheap model is direct savings, measurable per seat.

---

## 3. Model routing — how to actually decide

A mix of **deterministic rules** (fast, auditable) and an **LLM judge** (fallback). Rules first, judge only if confidence < threshold.

### Task taxonomy

```
trivial       -> rename, format, one‑line fix, simple regex, docstring
code_small    -> single‑function edit, ≤ ~50 LoC, well‑specified
code_large    -> multi‑file refactor, new feature, > ~200 LoC touched
reasoning     -> debugging, architecture, "why is this slow", algorithm design
research      -> "compare X and Y", long docs, exploratory
creative      -> naming, copywriting, commit messages, READMEs
agentic       -> needs tools / multi‑step (tests, terminal, search)
```

### Routing matrix (starter values — override per org)

| Task | Preferred | Fallback | Rationale |
|---|---|---|---|
| trivial | `gpt-4o-mini` / `claude-haiku` | any | cost dominates |
| code_small | `gpt-4o` / `claude-sonnet` | `gpt-4o-mini` | quality vs cost sweet spot |
| code_large | `claude-sonnet-4` / `gpt-5` | `gpt-4o` | large context + quality |
| reasoning | `o4-mini` / `claude-opus` reasoning | `gpt-4o` | explicit reasoning helps |
| research | `gpt-4o` with browsing (if available) | `claude-sonnet` | long context |
| creative | `claude-sonnet` | `gpt-4o` | subjective prefs |
| agentic | `claude-sonnet-4` | `gpt-4o` | tool‑use quality |

The matrix is data, not code — lives in [`src/data/pricing.ts`](../src/data/pricing.ts) and is overridable via config.

### Inputs to the classifier

- prompt text (n‑grams, verbs, question words)
- attached context size (file count, token estimate)
- presence of code blocks / stack traces / error messages
- workspace signals (language, framework, file being edited)
- user override (`@proctor /reason …`)

Starter implementation is rule‑based + keyword heuristics. Drop‑in upgrade path: swap `TaskClassifier` for an LLM‑based classifier using the cheapest available model.

---

## 4. Prompt validation — the "one‑shot" score

Score 0–100 across dimensions. Below threshold → ask follow‑ups instead of invoking the expensive model.

| Dimension | Weight | Signal |
|---|---|---|
| **Goal clarity** | 25 | imperative verb present? concrete noun? |
| **Scope** | 20 | specific file/function named? success criteria? |
| **Context** | 20 | relevant files attached, error messages pasted, inputs/outputs shown |
| **Constraints** | 15 | language/framework/style mentioned or inferable |
| **Acceptance** | 10 | "done when…", tests to pass, example output |
| **Ambiguity** | 10 | no contradictions, no vague pronouns |

If score < 60: generate up to 3 **targeted** questions (the cheapest thing an LLM does well). If ≥ 60 but some dimensions are low: proceed but warn.

This alone is the single biggest lever on premium‑request burn: **most "expensive" Copilot rounds are caused by underspecified prompts, not hard problems.**

---

## 5. Cost estimation

Two numbers per request: **tokens** and **$**.

- Token count: `tiktoken` where available, otherwise `chars/4` heuristic (good enough ±15%).
- Price table: per‑model `$ / 1M input` and `$ / 1M output`, with an assumed output ratio (default 0.4× input for code, 1.5× for reasoning).
- For Copilot Business/Enterprise, also surface **premium requests consumed** (1× base model, N× for premium models — N comes from config since GitHub updates the multipliers).

Output is a single line: `~1,420 in / ~570 out · ~$0.018 · 1 premium request · model=gpt-4o-mini`.

---

## 6. Enterprise concerns (non‑negotiables)

| Concern | How we handle it |
|---|---|
| Data residency | We never send prompts anywhere ourselves — we call `vscode.lm` which uses the user's existing Copilot entitlement. Validation + routing is 100% local. |
| Policy | `.conductor.yaml` at repo root or `~/.token-proctor/config.yaml`. Supports model allow/deny lists, redaction patterns, required task types for premium models. |
| Secrets | Pre‑send regex redaction (AWS keys, PEM blocks, JWTs) with visible `[REDACTED]` markers. Block‑list modes for high‑sensitivity repos. |
| Telemetry | Off by default. Opt‑in JSONL log local to workspace. No network calls. |
| Supply chain | Zero runtime deps beyond VS Code API + MCP SDK. Everything else is dev‑only. |
| Licensing | MIT, no CLA. |

---

## 7. Roadmap

**v0.1** — classifier, validator, cost, router; chat participant `@proctor`; MCP server.

**v0.2 (shipped)** — `.token-proctor.json` policy loader (allow/deny/premium-gating), built-in secret redaction (AWS, GitHub, Slack, OpenAI, Stripe, JWT, PEM, Google), JSONL audit log (opt-in).

**v0.3 (shipped)** — LLM-judge fallback classifier that auto-picks the cheapest available `vscode.lm` model; exact token counts via optional `js-tiktoken`. Both configurable and on by default.

**v0.4** — Language Model Tool so Copilot's agent mode can call `conductor.route` directly.

**v0.5** — GitHub Copilot Extension (server‑side) for orgs that want centralized routing for web Copilot Chat.

---

## 8. What we are **not** building

- Our own inference endpoint. Copilot already has one.
- Our own model. We route to existing ones.
- A new chat UI. VS Code Chat is fine.
- Proxying outside the user's Copilot entitlement — that would break ToS and data guarantees.
