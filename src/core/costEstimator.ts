import { CostEstimate, ModelSpec, TaskType } from "./types.js";

export interface PlanConfig {
  name: string;                      // e.g. "squad", "fleet", "free"
  monthlyTokenAllowance?: number;    // total tokens bundled per user per month
  overageUsdPerM?: number;           // $ per 1M tokens over the allowance
}

export interface CostOptions {
  inputTokens: number;
  task: TaskType;
  /** If provided (e.g. from the LLM judge), overrides the task-ratio heuristic. */
  outputTokensOverride?: number;
  /** If provided (e.g. from the LLM judge), multiplies cost for an agentic loop. */
  turnsOverride?: number;
  /** Plan context for calculating % of monthly allowance used. */
  plan?: PlanConfig;
}

// Task -> assumed output:input ratio. Reasoning tasks tend to produce
// long answers; trivial edits produce short ones.
const OUTPUT_RATIO: Record<TaskType, number> = {
  trivial: 0.2,
  code_small: 0.4,
  code_large: 0.8,
  reasoning: 1.5,
  research: 1.0,
  creative: 0.6,
  agentic: 0.8,
};

// Default turn count per task type when the judge isn't consulted.
// Roughly: one-shot vs multi-step agent loops.
const DEFAULT_TURNS: Record<TaskType, number> = {
  trivial: 1,
  code_small: 2,
  code_large: 12,
  reasoning: 4,
  research: 2,
  creative: 1,
  agentic: 10,
};

export function estimateCost(model: ModelSpec, opts: CostOptions): CostEstimate {
  const outPerTurn = opts.outputTokensOverride ??
    Math.ceil(opts.inputTokens * (OUTPUT_RATIO[opts.task] ?? 0.5));
  const turns = Math.max(1, opts.turnsOverride ?? DEFAULT_TURNS[opts.task] ?? 1);

  // For multi-turn tasks we assume input roughly repeats each turn (agent
  // re-reads context, stacks prior messages). Output compounds linearly.
  const totalInputTokens = opts.inputTokens * turns;
  const totalOutputTokens = outPerTurn * turns;

  const inUsd  = (totalInputTokens  / 1_000_000) * model.pricePerMInput;
  const outUsd = (totalOutputTokens / 1_000_000) * model.pricePerMOutput;
  const total = inUsd + outUsd;

  const totalTokens = totalInputTokens + totalOutputTokens;
  let planBurnPercent: number | undefined;
  let planBits = "";
  if (opts.plan?.monthlyTokenAllowance && opts.plan.monthlyTokenAllowance > 0) {
    planBurnPercent = (totalTokens / opts.plan.monthlyTokenAllowance) * 100;
    planBits = ` · plan=${opts.plan.name} ${planBurnPercent.toFixed(planBurnPercent < 1 ? 2 : 1)}%`;
  }

  const turnsBits = turns > 1 ? ` × ${turns} turns` : "";
  const humanReadable =
    `~${fmt(opts.inputTokens)} in / ~${fmt(outPerTurn)} out${turnsBits} · ` +
    `~$${total.toFixed(total < 0.01 ? 4 : 3)} · ` +
    `${model.copilotPremiumMultiplier ? `${(model.copilotPremiumMultiplier * turns).toFixed(1)}× premium` : "base quota"} · ` +
    `model=${model.id}${planBits}`;

  return {
    inputTokens: opts.inputTokens,
    outputTokensEstimate: outPerTurn,
    totalUsd: total,
    premiumRequests: model.copilotPremiumMultiplier * turns,
    model: model.id,
    humanReadable,
    turnsEstimate: turns,
    totalTokensEstimate: totalTokens,
    planBurnPercent,
    planName: opts.plan?.name,
  };
}

function fmt(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
