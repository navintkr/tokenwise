# Hello-world test walkthrough

End-to-end exercise for every Conductor feature. Run these in order after
pressing **F5** to launch the Extension Development Host.

Prereqs in the dev-host window:
1. Open this same folder (`github-copilot-limit`) as the workspace.
2. Open [hello.ts](./hello.ts) in an editor tab so chat has context.
3. Open Copilot Chat: **Ctrl+Shift+I**.

All prompts below are typed into Copilot Chat, not a terminal.

---

## 1. Sanity check — trivial task

```
@proctor add a JSDoc comment to helloWorld in #file:hello.ts
```

**Expected**
- `Task: trivial` (or `code_small`)
- Cheap model picked (e.g. `gpt-4o-mini` / `claude-haiku` / `gemini-flash`)
- Summary footer: `tokens=exact|heuristic · judge=on · policy=.token-proctor.json`
- Auto-forwards; you should see a JSDoc suggestion stream back.

---

## 2. Validation — weak prompt blocks forwarding

```
@proctor fix it
```

**Expected**
- `Completeness: ⛔` or `⚠️`
- Follow-up questions rendered, e.g. *"What exactly do you want changed?"*
- No model call is forwarded (saves a premium request).

---

## 3. Reasoning — picks reasoning tier

```
@proctor /explain why would fetchUser occasionally return stale data after a deploy
```

**Expected**
- `Task: reasoning`
- Model from `reasoning` or `premium` tier (`o4-mini` / `claude-sonnet-4`)
- `/explain` shows the full candidate matrix table at the bottom.

---

## 4. LLM-judge fires on ambiguous prompts

```
@proctor look at the thing and make it better somehow
```

**Expected**
- Rule-based confidence < 0.6
- In the **Routing** section: `🧠 llm-judge(<model-id>): task=... conf=...`
- If no judge-capable model is available, the rule-based result stands (no 🧠 line).

---

## 5. Cost-only view

```
@proctor /cost refactor fetchUser to use async/await with error handling
```

**Expected**
- No forwarding. Table shows:
  - Input tokens, estimated output tokens, USD, premium requests
  - `Tokenization: exact (js-tiktoken)` if you ran `npm install js-tiktoken`, else `heuristic`.

---

## 6. Redaction + policy

```
@proctor /validate my CORP-AB12CD34EF56 token should not leak: sk-proj-abcdefghij1234567890
```

**Expected**
- `🛡️ Redacted before analysis: 1× custom:CORP-[A-Z0-9]{12}…, 1× openai-key`
- With `blockOnMatch: false` (current policy): proceeds after redaction.
- Flip `blockOnMatch: true` in `.token-proctor.json`, re-run → forwarding refused.

---

## 7. Audit log

After running the prompts above, check:

```powershell
Get-Content .token-proctor/audit.jsonl | Select-Object -Last 5
```

Each line is a JSON record: `ts, task, modelChosen, inputTokens, totalUsd, premiumRequests, redactions, verdict, policySource`.

---

## 8. MCP server

From a regular terminal:

```powershell
npx @modelcontextprotocol/inspector node ./out/mcp-server.js
```

In the inspector UI, try each tool:
- `get_policy` → returns the loaded `.token-proctor.json`.
- `redact_text` with `{ "text": "AKIAABCDEFGHIJKLMNOP and sk-abcdef1234567890abcdef" }` → both redacted.
- `analyze_prompt` with `{ "prompt": "add pagination to /users" }` → full report.
- `estimate_cost` with `{ "prompt": "...", "modelId": "claude-sonnet-4" }`.

---

## 9. Toggle tests

| Change | Where | Expected |
|---|---|---|
| `"llmJudge": { "enabled": false }` | `.token-proctor.json` | Summary shows `judge=off`; no 🧠 line. |
| Uninstall `js-tiktoken` (`npm uninstall js-tiktoken`) | terminal | Summary shows `tokens=heuristic`. |
| `"autoForward": false` | VS Code settings | Summary + routing shown, no model call made. |
| `"preferCheap": true` | `.token-proctor.json` | Cheap tier wins more often; watch the routing rationale. |

---

## Troubleshooting

- **No model output after forwarding** → sign in to GitHub Copilot in the dev-host window.
- **`policy=(defaults)` in footer** → the dev-host didn't open this folder as workspace; open it and reload.
- **Judge never fires** → every prompt clears the 0.6 confidence bar. Use the ambiguous prompt from §4.
