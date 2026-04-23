// v0.3 — LLM-judge classifier.
// A last-resort classifier that asks a cheap LLM to label the task when
// rule-based confidence is below threshold. Designed to be pluggable:
// caller provides a `judgeFn` (async (prompt) => JudgeResult | null).
//
// The participant wires a judge backed by `vscode.lm` that auto-picks the
// cheapest available model. The MCP server cannot issue LLM calls itself,
// so it simply skips the judge (rule-based result stands).

import { TaskType } from "./types.js";

export interface JudgeResult {
  task: TaskType;
  confidence: number;       // 0..1, the judge's self-reported confidence
  modelId: string;          // which model was asked (for audit)
  rationale?: string;
  /** Estimated output tokens the chosen model will produce for this prompt. */
  outputTokensEstimate?: number;
  /** Estimated number of agent turns (LLM round-trips) to complete this task. */
  turnsEstimate?: number;
}

export type JudgeFn = (prompt: string) => Promise<JudgeResult | null>;

export const JUDGE_PROMPT = [
  "You are a classifier for a coding assistant. Analyze the user request and return a JSON assessment.",
  "",
  "Pick ONE task label:",
  "- trivial      (rename, format, one-liner, typo, regex)",
  "- code_small   (single function edit, <=50 LoC, well-specified)",
  "- code_large   (multi-file refactor, new feature, >200 LoC)",
  "- reasoning    (debug, root-cause, architecture, trade-off)",
  "- research     (compare, explore, survey, pros/cons)",
  "- creative     (naming, commit msg, README, copywriting)",
  "- agentic      (multi-step, tool-use, scaffolding, e2e)",
  "",
  "Also estimate, realistically:",
  "- outputTokens: tokens the model will produce in ONE turn (50-300 short, 300-1500 typical edit, 2000-8000 big refactor, 1500-5000 long reasoning).",
  "- turns: total agent round-trips to finish (1 for a pure Q&A or one-shot edit, 3-8 for multi-file code_small, 10-30 for code_large/agentic, 5-15 for reasoning).",
  "",
  "Reply with STRICT JSON on one line, no prose, no backticks, no prefix:",
  `{"task":"<label>","confidence":<0..1>,"outputTokens":<integer>,"turns":<integer>,"rationale":"<=20 words"}`,
].join("\n");

export function parseJudgeResponse(text: string): Omit<JudgeResult, "modelId"> | null {
  if (!text) return null;
  // Strip markdown fences and whitespace.
  const clean = text.replace(/```[a-z]*\n?|```/gi, "").trim();
  // Find first {...} block.
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || typeof obj.task !== "string") return null;
    const valid: TaskType[] = [
      "trivial", "code_small", "code_large", "reasoning", "research", "creative", "agentic",
    ];
    if (!valid.includes(obj.task)) return null;
    const conf = typeof obj.confidence === "number" ? obj.confidence : 0.6;
    const outTok = typeof obj.outputTokens === "number" && obj.outputTokens > 0
      ? Math.round(obj.outputTokens)
      : undefined;
    const turns = typeof obj.turns === "number" && obj.turns > 0
      ? Math.max(1, Math.round(obj.turns))
      : undefined;
    return {
      task: obj.task,
      confidence: Math.max(0, Math.min(1, conf)),
      rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
      outputTokensEstimate: outTok,
      turnsEstimate: turns,
    };
  } catch {
    return null;
  }
}
