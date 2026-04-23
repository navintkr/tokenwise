import * as vscode from "vscode";
import * as path from "node:path";
import {
  analyzeAsync, AnalyzeAsyncResult,
  MODEL_CATALOG, JudgeFn, JUDGE_PROMPT, parseJudgeResponse,
  loadPolicy, Policy, writeAuditEntry, AuditEntry,
  tryInstallTiktoken, isExactTokenization,
} from "./core/index.js";

// Cached across handler invocations.
let cachedPolicy: { policy: Policy; source: string } | null = null;
let tiktokenAttempted = false;

export function registerConductor(context: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant(
    "copilot-conductor.conductor",
    handler
  );
  participant.iconPath = new vscode.ThemeIcon("rocket");

  // Follow-up provider — surfaces the hand-off button after a routing turn.
  // The primary action routes the (redacted) prompt to the GitHub Copilot
  // agent so it can drive the real code changes with its own tools. A
  // secondary `/confirm` path keeps the in-Conductor text-only fallback.
  participant.followupProvider = {
    provideFollowups(result: vscode.ChatResult) {
      const md = result.metadata as ChatMeta | undefined;
      if (!md?.awaitingConfirmation || !md.lastPrompt) return [];
      const cfg = vscode.workspace.getConfiguration("copilotConductor");
      const handoff = cfg.get<boolean>("handoffToCopilot", true);
      const handoffId = cfg.get<string>("handoffParticipant", "github.copilot");
      const prompt = md.redactedPrompt ?? md.lastPrompt;
      const followups: vscode.ChatFollowup[] = [];
      if (handoff) {
        followups.push({
          prompt,
          label: `🚀 Hand off to Copilot (use \`${md.recommendedModel ?? "recommended"}\`)`,
          participant: handoffId,
        });
      }
      followups.push({
        prompt: `/confirm ${md.lastPrompt}`,
        label: `💬 Run here as text (no tools)`,
      });
      followups.push({
        prompt: `/cancel`,
        label: `✖ Cancel`,
      });
      return followups;
    },
  };

  context.subscriptions.push(participant);

  // One-click "Accept & hand off" command — tries to switch Copilot's
  // chat model to the recommendation, then submits the redacted prompt
  // to the default Copilot agent (which has file/terminal/edit tools).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilot-conductor.handoff",
      async (args: { prompt: string; modelId: string; modelFamily: string }) => {
        if (!args?.prompt) return;
        const res = await tryToSwitchCopilotModel(args.modelId, args.modelFamily);
        if (res.ok) {
          void vscode.window.showInformationMessage(
            `Copilot Conductor: switched chat model via \`${res.via}\`.`
          );
        } else {
          void vscode.window.showWarningMessage(
            `Copilot Conductor: could not auto-switch model. ${res.detail ?? ""} Please pick \`${args.modelId}\` in the chat model dropdown before sending.`,
            "Open model picker"
          ).then(async (choice) => {
            if (choice !== "Open model picker") return;
            const tryCmds = [
              "workbench.action.chat.openModelPicker",
              "workbench.action.chat.manageLanguageModels",
              "github.copilot.chat.openModelPicker",
            ];
            let all: string[] = [];
            try { all = await vscode.commands.getCommands(true); } catch { /* */ }
            for (const c of tryCmds) {
              if (all.includes(c)) {
                try { await vscode.commands.executeCommand(c); break; } catch { /* */ }
              }
            }
          });
        }
        // Open Copilot Chat with the prompt prefilled. Plain text (no @mention)
        // lands in the default Copilot agent, which can use its tools.
        try {
          await vscode.commands.executeCommand("workbench.action.chat.open", {
            query: args.prompt,
            isPartialQuery: false,
          });
        } catch {
          await vscode.env.clipboard.writeText(args.prompt);
          await vscode.commands.executeCommand("workbench.action.chat.focus");
          void vscode.window.showInformationMessage(
            "Copilot Conductor: prompt copied to clipboard — paste into Copilot Chat."
          );
        }
      }
    )
  );

  // Diagnostic: dumps every command in this VS Code build that looks
  // model/picker related. Run from command palette: "Copilot Conductor:
  // Diagnose Model Commands".
  context.subscriptions.push(
    vscode.commands.registerCommand("copilot-conductor.diagnoseModelCommands", async () => {
      const all = await vscode.commands.getCommands(true);
      const hits = all.filter((c) => /(chat|copilot).*(model|picker)|language.?model/i.test(c));
      const msg = hits.length
        ? `Found ${hits.length} model-related commands in this build:\n\n${hits.join("\n")}`
        : "No model-related commands found in this build.";
      const doc = await vscode.workspace.openTextDocument({ content: msg, language: "text" });
      await vscode.window.showTextDocument(doc);
    })
  );

  // Kick off exact tokenization in the background — participant uses
  // whatever is installed by the time the first request runs.
  if (!tiktokenAttempted) {
    tiktokenAttempted = true;
    const cfg = vscode.workspace.getConfiguration("copilotConductor");
    if (cfg.get<boolean>("exactTokenCounts", true)) {
      void tryInstallTiktoken().then((ok) => {
        console.log(`Copilot Conductor: exact tokenization ${ok ? "enabled (js-tiktoken)" : "unavailable — using heuristic"}`);
      });
    }
  }
}

interface ChatMeta {
  command?: string;
  blocked?: boolean;
  awaitingConfirmation?: boolean;
  lastPrompt?: string;
  redactedPrompt?: string;
  recommendedModel?: string;
}

async function handler(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  const cfg = vscode.workspace.getConfiguration("copilotConductor");
  const threshold = cfg.get<number>("completenessThreshold", 60);
  const autoForward = cfg.get<boolean>("autoForward", true);
  const requireConfirmation = cfg.get<boolean>("requireConfirmation", true);
  const preferCheap = cfg.get<boolean>("preferCheap", false);
  const judgeEnabledCfg = cfg.get<boolean>("llmJudge.enabled", true);
  const judgeThreshold = cfg.get<number>("llmJudge.confidenceThreshold", 0.85);

  // Policy (v0.2) — reload each turn so edits to `.conductor.json` take effect.
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  cachedPolicy = loadPolicy(wsRoot);
  const { policy, source: policySource } = cachedPolicy;

  const cmd = request.command ?? "route";

  // /cancel — user dismissed confirmation.
  if (cmd === "cancel") {
    stream.markdown("_Cancelled. No model was called._");
    return { metadata: { command: "cancel" } as ChatMeta };
  }

  // Available Copilot models (for the judge).
  let availableModels: vscode.LanguageModelChat[] = [];
  try {
    availableModels = await vscode.lm.selectChatModels();
  } catch {
    /* ignore */
  }

  // LLM-judge (v0.3) — on by default, backed by the cheapest available
  // Copilot model. Disabled if settings or policy opt out.
  const judgeEnabled = judgeEnabledCfg && (policy.llmJudge?.enabled !== false);
  const judge = judgeEnabled ? buildVscodeLmJudge(availableModels, token) : undefined;
  const effectiveJudgeThreshold = policy.llmJudge?.confidenceThreshold ?? judgeThreshold;

  const attached = collectAttachedText(request, chatContext);

  const result = await analyzeAsync({
    prompt: request.prompt,
    attachedText: attached,
    preferCheap,
    completenessThreshold: threshold,
    policy,
    judge,
    judgeEnabled,
    judgeThreshold: effectiveJudgeThreshold,
  });

  renderSummary(stream, result, { policySource, judgeEnabled });

  if (result.redactions.length) {
    const pieces = result.redactions.map((r) => `${r.count}× \`${r.kind}\``).join(", ");
    stream.markdown(`\n> 🛡️ **Redacted** before analysis: ${pieces}\n`);
  }

  if (result.blocked) {
    stream.markdown(
      "\n> ⛔ Policy `redact.blockOnMatch` is enabled and secrets were found. Refusing to forward.\n"
    );
    writeAudit("participant", cmd, result, policySource, true);
    return { metadata: { command: cmd, blocked: true } as ChatMeta };
  }

  if (cmd === "validate") {
    renderValidation(stream, result);
    writeAudit("participant", cmd, result, policySource, false);
    return { metadata: { command: cmd } as ChatMeta };
  }

  if (cmd === "cost") {
    renderCost(stream, result);
    writeAudit("participant", cmd, result, policySource, false);
    return { metadata: { command: cmd } as ChatMeta };
  }

  if (cmd === "explain") {
    renderExplain(stream, result);
    if (result.policyNotes.length) {
      stream.markdown("\n### Policy\n\n");
      stream.markdown(`Source: \`${policySource}\`\n\n`);
      for (const n of result.policyNotes) stream.markdown(`- ${n}\n`);
    }
    writeAudit("participant", cmd, result, policySource, false);
    return { metadata: { command: cmd } as ChatMeta };
  }

  renderRouting(stream, result);

  if (result.validation.verdict !== "ready") {
    renderFollowUps(stream, result);
    writeAudit("participant", cmd, result, policySource, true);
    return { metadata: { command: cmd, blocked: true } as ChatMeta };
  }

  // Confirmation gate — /confirm bypasses, otherwise we stop here and render buttons.
  const isConfirmed = cmd === "confirm";
  if (!autoForward) {
    stream.markdown(
      "\n\n_`copilotConductor.autoForward` is off — use your normal chat model to run the prompt._"
    );
    writeAudit("participant", cmd, result, policySource, false);
    return { metadata: { command: cmd } as ChatMeta };
  }

  const handoffEnabled = cfg.get<boolean>("handoffToCopilot", true);
  if (requireConfirmation && !isConfirmed) {
    if (handoffEnabled) {
      const args = encodeURIComponent(JSON.stringify([{
        prompt: result.redactedPromptText,
        modelId: result.routing.model.id,
        modelFamily: result.routing.model.family,
      }]));
      const link = new vscode.MarkdownString(
        `\n\n---\n**Recommended model:** \`${result.routing.model.id}\`\n\n` +
        `[🚀 **Accept & hand off to Copilot**](command:copilot-conductor.handoff?${args}) ` +
        `— switches Copilot's chat model to the recommendation and lets the Copilot ` +
        `agent drive the change with its own tools (edits, terminal, etc.).\n\n` +
        `_If the model can't be switched automatically (older Copilot builds), ` +
        `pick \`${result.routing.model.id}\` in the chat model picker, then click the ` +
        `hand-off button again._\n`
      );
      link.isTrusted = { enabledCommands: ["copilot-conductor.handoff"] };
      stream.markdown(link);
    } else {
      stream.markdown(
        `\n\n---\n**Ready to forward to \`${result.routing.model.id}\`.** ` +
        `Click **Confirm & forward** below, or type \`/confirm <your prompt>\` to proceed.\n`
      );
    }
    writeAudit("participant", cmd, result, policySource, false);
    return {
      metadata: {
        command: cmd,
        awaitingConfirmation: true,
        lastPrompt: request.prompt,
        redactedPrompt: result.redactedPromptText,
        recommendedModel: result.routing.model.id,
      } as ChatMeta,
    };
  }

  // Forward — either autoForward without confirmation, or /confirm turn.
  stream.markdown(`\n\n---\n*Forwarding to \`${result.routing.model.id}\`…*\n\n`);
  await forward(result.redactedPromptText, result, stream, token);
  writeAudit("participant", cmd, result, policySource, false);
  return { metadata: { command: cmd } as ChatMeta };
}

// ---------- LLM-judge backed by vscode.lm (auto-picks cheapest) ----------

function buildVscodeLmJudge(
  available: vscode.LanguageModelChat[],
  token: vscode.CancellationToken
): JudgeFn {
  return async (prompt: string) => {
    let pool = rankCheapest(available);
    if (pool.length === 0) {
      try {
        const fallback = await vscode.lm.selectChatModels();
        pool = rankCheapest(fallback);
      } catch { /* ignore */ }
    }
    if (pool.length === 0) return null;

    for (const m of pool) {
      try {
        const messages = [
          vscode.LanguageModelChatMessage.User(JUDGE_PROMPT),
          vscode.LanguageModelChatMessage.User("Classify this user request:\n\n" + prompt),
        ];
        const resp = await m.sendRequest(messages, {}, token);
        let text = "";
        for await (const chunk of resp.text) text += chunk;
        const parsed = parseJudgeResponse(text);
        if (parsed) return { ...parsed, modelId: m.id };
      } catch {
        // try next candidate
      }
    }
    return null;
  };
}

function rankCheapest(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat[] {
  const score = (id: string): number => {
    const s = id.toLowerCase();
    if (/mini|haiku|flash|nano|small/.test(s)) return 0;
    if (/sonnet|4o\b|balanced/.test(s)) return 1;
    if (/opus|gpt-5|o1|reasoning|pro/.test(s)) return 3;
    return 2;
  };
  return [...models].sort((a, b) => score(a.id) - score(b.id));
}

// ---------- forwarding ----------

// Order tiers from cheapest to most expensive. Forwarding must never exceed
// the recommended tier — if Copilot doesn't expose a matching model, fall
// back to the cheapest available within the allowed ceiling.
const TIER_ORDER: Array<"cheap" | "balanced" | "reasoning" | "premium"> = [
  "cheap", "balanced", "reasoning", "premium",
];

async function forward(
  prompt: string,
  result: AnalyzeAsyncResult,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
) {
  const want = result.routing.model;

  // 1. Try exact family match first.
  let candidates: vscode.LanguageModelChat[] = [];
  try {
    candidates = await vscode.lm.selectChatModels({ family: want.family });
  } catch { /* ignore */ }

  // 2. If that fails, take all available and filter/rank them by our cheapest-first heuristic.
  if (candidates.length === 0) {
    try { candidates = await vscode.lm.selectChatModels(); } catch { /* ignore */ }
  }
  if (candidates.length === 0) {
    stream.markdown("> ⚠️ No language models available via `vscode.lm`. Install/sign in to GitHub Copilot.");
    return;
  }

  // 3. Never exceed the recommended tier. `want.tier` is our ceiling.
  const ceiling = TIER_ORDER.indexOf(want.tier);
  const ranked = rankCheapest(candidates).filter((m) => estimateTier(m.id) <= ceiling);

  // 4. If nothing fits under the ceiling, still prefer the cheapest available
  //    rather than the first. Better to be slightly over-cheap than way over-budget.
  const picked = ranked[0] ?? rankCheapest(candidates)[0];

  const warn = estimateTier(picked.id) > ceiling
    ? ` (⚠️ no model ≤ ${want.tier} tier available; picked cheapest: \`${picked.id}\`)`
    : ` (closest available to recommended \`${want.id}\`)`;
  stream.markdown(`> Using \`${picked.id}\`${warn}.\n\n`);

  try {
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const resp = await picked.sendRequest(messages, {}, token);
    if (!resp) {
      stream.markdown(`\n\n> ❌ Model call failed: No response received`);
      return;
    }
    if (resp.text) {
      try {
        for await (const chunk of resp.text) stream.markdown(chunk);
      } catch (streamErr: any) {
        stream.markdown(`\n\n> ❌ Failed to stream response: \`${streamErr?.message ?? streamErr}\``);
      }
    } else {
      stream.markdown(`\n\n> ❌ Model returned empty response`);
    }
  } catch (err: any) {
    stream.markdown(`\n\n> ❌ Model call failed: \`${err?.message ?? JSON.stringify(err)}\``);
  }
}

/** Heuristic tier from model id (vscode.lm doesn't expose a real tier). */
function estimateTier(id: string): number {
  const s = id.toLowerCase();
  if (/mini|haiku|flash|nano|small/.test(s)) return TIER_ORDER.indexOf("cheap");
  if (/opus|gpt-5|o1\b|o3\b|o4\b|reasoning|pro\b/.test(s)) return TIER_ORDER.indexOf("premium");
  if (/sonnet|4o\b|balanced/.test(s)) return TIER_ORDER.indexOf("balanced");
  return TIER_ORDER.indexOf("balanced");
}

// ---------- Copilot model switcher ----------

/**
 * Tries to switch Copilot's chat model to the given id.
 *
 * HONEST NOTE: VS Code does NOT ship a public API or stable command for
 * changing the Copilot Chat model dropdown from an extension. The dropdown
 * is private UI owned by the GitHub Copilot Chat extension. This function
 * therefore does best-effort detection + a last-resort settings write, and
 * returns a status string so callers can tell the user what happened.
 */
async function tryToSwitchCopilotModel(
  modelId: string,
  family: string
): Promise<{ ok: boolean; via: string; detail?: string }> {
  const candidateCmds = [
    "github.copilot.chat.selectModel",
    "github.copilot.chat.setModel",
    "github.copilot.chat.changeModel",
    "github.copilot.chat.switchToModel",
    "workbench.action.chat.selectModel",
    "workbench.action.chat.setModel",
    "workbench.action.chat.changeModel",
  ];

  let commands: string[] = [];
  try { commands = await vscode.commands.getCommands(true); } catch { /* ignore */ }
  const matched = commands.filter((c) => /(chat|copilot).*model/i.test(c));
  console.log("Copilot Conductor: model-ish commands in this build:", matched);

  for (const cmd of candidateCmds) {
    if (!commands.includes(cmd)) continue;
    for (const arg of [modelId, family, { id: modelId }, { family }, undefined]) {
      try {
        await vscode.commands.executeCommand(cmd, arg as any);
        return { ok: true, via: cmd };
      } catch {
        // try next arg shape
      }
    }
  }

  // Last-resort: write the preferred model to Copilot Chat settings. Some
  // builds honor this, most do not — so we still return ok:false.
  try {
    const picks = await vscode.lm.selectChatModels({ family });
    if (picks.length) {
      await vscode.workspace
        .getConfiguration("github.copilot.chat")
        .update("preferredModel", picks[0].id, vscode.ConfigurationTarget.Global);
      return {
        ok: false,
        via: "settings",
        detail: `Wrote github.copilot.chat.preferredModel=${picks[0].id} as a hint (no switch command available in this build).`,
      };
    }
  } catch { /* ignore */ }

  return {
    ok: false,
    via: "none",
    detail: "This VS Code / Copilot Chat build does not expose any command for switching the chat model.",
  };
}

// ---------- rendering ----------

function renderSummary(
  stream: vscode.ChatResponseStream,
  r: AnalyzeAsyncResult,
  meta: { policySource: string; judgeEnabled: boolean }
) {
  const v = r.validation;
  const verdictIcon = v.verdict === "ready" ? "✅" : v.verdict === "weak" ? "⚠️" : "⛔";
  const tokMode = isExactTokenization() ? "exact" : "heuristic";
  const judgeTag = meta.judgeEnabled ? "on" : "off";
  stream.markdown(
    `**Task:** \`${r.classification.task}\` (confidence ${(r.classification.confidence * 100).toFixed(0)}%)  \n` +
    `**Completeness:** ${verdictIcon} ${v.score}/100 (${v.verdict})  \n` +
    `**Recommended model:** \`${r.routing.model.id}\`  \n` +
    `**Estimate:** ${r.cost.humanReadable}  \n` +
    `<sub>tokens=${tokMode} · judge=${judgeTag} · policy=${path.basename(meta.policySource)}</sub>\n`
  );
}

function renderValidation(stream: vscode.ChatResponseStream, r: AnalyzeAsyncResult) {
  stream.markdown("\n### Prompt completeness\n\n");
  stream.markdown("| Dimension | Weight | Score | Note |\n|---|---:|---:|---|\n");
  for (const d of r.validation.dimensions) {
    stream.markdown(`| ${d.name} | ${d.weight} | ${d.score} | ${d.note} |\n`);
  }
  if (r.validation.followUpQuestions.length) {
    stream.markdown("\n**Suggested follow‑ups:**\n");
    for (const q of r.validation.followUpQuestions) stream.markdown(`- ${q}\n`);
  }
}

function renderRouting(stream: vscode.ChatResponseStream, r: AnalyzeAsyncResult) {
  stream.markdown("\n### Routing\n\n");
  stream.markdown(r.routing.rationale.map((x) => `- ${x}`).join("\n") + "\n");
  if (r.routing.alternatives.length) {
    stream.markdown("\n**Alternatives:** " +
      r.routing.alternatives.map((m) => `\`${m.id}\``).join(", ") + "\n");
  }
  const judgeLine = r.classification.signals.find((s) => s.startsWith("llm-judge"));
  if (judgeLine) {
    stream.markdown(`\n> 🧠 ${judgeLine}\n`);
  }
}

function renderCost(stream: vscode.ChatResponseStream, r: AnalyzeAsyncResult) {
  stream.markdown("\n### Cost estimate\n\n");
  const turns = r.cost.turnsEstimate ?? 1;
  const planLine = r.cost.planBurnPercent !== undefined
    ? `- Plan burn: **${r.cost.planBurnPercent.toFixed(r.cost.planBurnPercent < 1 ? 2 : 1)}%** of \`${r.cost.planName}\` monthly allowance\n`
    : "";
  stream.markdown(
    `- Input tokens (per turn): **${r.cost.inputTokens.toLocaleString()}**\n` +
    `- Est. output tokens (per turn): **${r.cost.outputTokensEstimate.toLocaleString()}**\n` +
    `- Est. turns: **${turns}** ${turns > 1 ? "_(agent loop)_" : "_(single call)_"}\n` +
    (r.cost.totalTokensEstimate ? `- Total tokens (all turns): **${r.cost.totalTokensEstimate.toLocaleString()}**\n` : "") +
    `- Est. USD total: **$${r.cost.totalUsd.toFixed(4)}**\n` +
    `- Premium requests total: **${r.cost.premiumRequests.toFixed(1)}**\n` +
    planLine +
    `- Model: \`${r.cost.model}\`\n` +
    `- Tokenization: \`${isExactTokenization() ? "exact (js-tiktoken)" : "heuristic"}\`\n`
  );
  stream.markdown(
    "\n_Prices are list prices in [`src/data/pricing.ts`](command:copilot-conductor.openPricing); " +
    "override in your fork for real org rates. Set `plan` in `.conductor.json` for allowance %._\n"
  );
}

function renderExplain(stream: vscode.ChatResponseStream, r: AnalyzeAsyncResult) {
  renderValidation(stream, r);
  renderRouting(stream, r);
  renderCost(stream, r);
  stream.markdown("\n### Candidate models considered\n\n");
  stream.markdown("| Model | Tier | Ctx | $/M in | $/M out | Premium× |\n|---|---|---:|---:|---:|---:|\n");
  for (const m of MODEL_CATALOG) {
    stream.markdown(`| \`${m.id}\` | ${m.tier} | ${m.contextWindow.toLocaleString()} | ${m.pricePerMInput} | ${m.pricePerMOutput} | ${m.copilotPremiumMultiplier} |\n`);
  }
}

function renderFollowUps(stream: vscode.ChatResponseStream, r: AnalyzeAsyncResult) {
  stream.markdown("\n> Prompt is **" + r.validation.verdict + "** — answering these first will save a premium request:\n\n");
  for (const q of r.validation.followUpQuestions) stream.markdown(`- ${q}\n`);
}

// ---------- audit ----------

function writeAudit(
  surface: AuditEntry["surface"],
  command: string | undefined,
  r: AnalyzeAsyncResult,
  policySource: string,
  blocked: boolean
): void {
  if (!cachedPolicy?.policy.audit?.enabled) return;
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const filePath = cachedPolicy.policy.audit.path
    ? path.resolve(wsRoot, cachedPolicy.policy.audit.path)
    : path.join(wsRoot, ".conductor", "audit.jsonl");

  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    surface,
    command,
    task: r.classification.task,
    confidence: r.classification.confidence,
    completeness: r.validation.score,
    verdict: r.validation.verdict,
    modelChosen: r.routing.model.id,
    alternatives: r.routing.alternatives.map((m) => m.id),
    inputTokens: r.cost.inputTokens,
    outputTokensEstimate: r.cost.outputTokensEstimate,
    totalUsd: r.cost.totalUsd,
    premiumRequests: r.cost.premiumRequests,
    redactions: r.redactions,
    policySource,
    blocked,
    notes: r.policyNotes,
  };
  writeAuditEntry(filePath, entry);
}

// ---------- attached context ----------

function collectAttachedText(
  request: vscode.ChatRequest,
  _ctx: vscode.ChatContext
): string {
  const parts: string[] = [];
  for (const ref of request.references ?? []) {
    try {
      const v = (ref as any).value;
      if (typeof v === "string") {
        parts.push(v);
      } else if (v && typeof v === "object") {
        if ("uri" in v && v.uri?.fsPath) parts.push(`file: ${v.uri.fsPath}`);
      }
    } catch { /* ignore */ }
  }
  return parts.join("\n");
}
