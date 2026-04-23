import { classify, classifyAsync } from "./taskClassifier.js";
import { validate, ValidateOptions } from "./promptValidator.js";
import { route } from "./modelRouter.js";
import { estimateCost } from "./costEstimator.js";
import { estimateTokens } from "./tokens.js";
import { MODEL_CATALOG } from "../data/pricing.js";
import { JudgeFn } from "./llmJudge.js";
import { Policy, applyModelGating } from "./policy.js";
import { redact } from "./redactor.js";
import {
  ClassificationResult, CostEstimate, RoutingResult, ValidationResult,
} from "./types.js";

export interface AnalyzeInput {
  prompt: string;
  attachedText?: string;             // concatenated context (files, selection, etc.)
  availableModelIds?: string[];
  preferCheap?: boolean;
  completenessThreshold?: number;
}

export interface AnalyzeResult {
  classification: ClassificationResult;
  validation: ValidationResult;
  routing: RoutingResult;
  cost: CostEstimate;
  inputTokens: number;
}

export function analyze(input: AnalyzeInput): AnalyzeResult {
  const attached = input.attachedText ?? "";
  const fullText = input.prompt + "\n\n" + attached;
  const inputTokens = estimateTokens(fullText);

  const classification = classify(input.prompt, {
    attachedTokens: estimateTokens(attached),
    fileCount: attached ? Math.max(1, (attached.match(/^```/gm)?.length ?? 1)) : 0,
  });

  const validation = validate(input.prompt, {
    attachedChars: attached.length,
    threshold: input.completenessThreshold,
  } satisfies ValidateOptions);

  const routing = route(classification.task, {
    inputTokens,
    availableModels: input.availableModelIds,
    preferCheap: input.preferCheap,
  });

  const cost = estimateCost(routing.model, {
    inputTokens,
    task: classification.task,
  });

  return { classification, validation, routing, cost, inputTokens };
}

// ---------- v0.2 + v0.3: policy-aware, redacted, judge-capable pipeline ----------

export interface AnalyzeAsyncInput extends AnalyzeInput {
  policy?: Policy;
  judge?: JudgeFn;
  judgeEnabled?: boolean;
  judgeThreshold?: number;
}

export interface AnalyzeAsyncResult extends AnalyzeResult {
  redactedPromptText: string;
  redactedAttachedText: string;
  redactions: { kind: string; count: number }[];
  policyNotes: string[];
  blocked: boolean;
}

/**
 * Full pipeline with policy + redaction + optional LLM-judge classification.
 * - Redacts prompt and attached text first (so token counts, forwarded
 *   content, and audit logs never include raw secrets).
 * - Gates the model pool via policy (allow/deny, premium-for-task).
 * - Escalates to the LLM judge when rule-based confidence < threshold.
 */
export async function analyzeAsync(input: AnalyzeAsyncInput): Promise<AnalyzeAsyncResult> {
  const policy = input.policy ?? {};
  const policyNotes: string[] = [];

  // --- Redaction ---
  const redactOpts = {
    builtins: policy.redact?.builtins !== false,
    extraPatterns: policy.redact?.patterns,
  };
  const pr = redact(input.prompt, redactOpts);
  const ar = redact(input.attachedText ?? "", redactOpts);
  const redactions = mergeRedactions(pr.redactions, ar.redactions);
  if (redactions.length) {
    policyNotes.push(
      `redacted: ${redactions.map((r) => `${r.count}× ${r.kind}`).join(", ")}`
    );
  }
  const blocked = !!policy.redact?.blockOnMatch && redactions.length > 0;

  const prompt = pr.text;
  const attached = ar.text;
  const fullText = prompt + "\n\n" + attached;
  const inputTokens = estimateTokens(fullText);

  // --- Classification ---
  const classifyOpts = {
    attachedTokens: estimateTokens(attached),
    fileCount: attached ? Math.max(1, (attached.match(/^```/gm)?.length ?? 1)) : 0,
  };
  const classification = input.judgeEnabled
    ? await classifyAsync(prompt, {
        ...classifyOpts,
        judge: input.judge,
        judgeThreshold: input.judgeThreshold,
      })
    : classify(prompt, classifyOpts);

  const validation = validate(prompt, {
    attachedChars: attached.length,
    threshold: input.completenessThreshold ?? policy.completenessThreshold,
  } satisfies ValidateOptions);

  // --- Model gating via policy ---
  const premiumIds = new Set(
    MODEL_CATALOG.filter((m) => m.tier === "premium").map((m) => m.id)
  );
  const gated = applyModelGating(
    input.availableModelIds ?? MODEL_CATALOG.map((m) => m.id),
    policy,
    classification.task,
    premiumIds
  );
  policyNotes.push(...gated.reasons);

  const routing = route(classification.task, {
    inputTokens,
    availableModels: gated.allowedIds ?? input.availableModelIds,
    preferCheap: input.preferCheap ?? policy.preferCheap,
  });

  const cost = estimateCost(routing.model, {
    inputTokens,
    task: classification.task,
    outputTokensOverride: (classification as any).judgeOutputTokensEstimate,
    turnsOverride: (classification as any).judgeTurnsEstimate,
    plan: policy.plan?.monthlyTokenAllowance ? {
      name: policy.plan.name ?? "plan",
      monthlyTokenAllowance: policy.plan.monthlyTokenAllowance,
      overageUsdPerM: policy.plan.overageUsdPerM,
    } : undefined,
  });

  return {
    classification,
    validation,
    routing,
    cost,
    inputTokens,
    redactedPromptText: prompt,
    redactedAttachedText: attached,
    redactions,
    policyNotes,
    blocked,
  };
}

function mergeRedactions(
  a: { kind: string; count: number }[],
  b: { kind: string; count: number }[]
): { kind: string; count: number }[] {
  const map = new Map<string, number>();
  for (const r of [...a, ...b]) {
    map.set(r.kind, (map.get(r.kind) ?? 0) + r.count);
  }
  return [...map.entries()].map(([kind, count]) => ({ kind, count }));
}

export { MODEL_CATALOG, classify, classifyAsync, validate, route, estimateCost, estimateTokens };
export * from "./types.js";
export { Policy, loadPolicy } from "./policy.js";
export { redact } from "./redactor.js";
export { writeAuditEntry, AuditEntry } from "./audit.js";
export { JudgeFn, JudgeResult, JUDGE_PROMPT, parseJudgeResponse } from "./llmJudge.js";
export { setTokenizer, isExactTokenization, tryInstallTiktoken } from "./tokens.js";
