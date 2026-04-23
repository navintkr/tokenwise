import { ClassificationResult, TaskType } from "./types.js";
import { JudgeFn } from "./llmJudge.js";

// Rule-based classifier. Fast, deterministic, auditable.
// Upgrade path: if confidence < 0.6 call a cheap LLM as a judge.

interface Rule {
  task: TaskType;
  patterns: RegExp[];
  weight: number;
  reason: string;
}

const RULES: Rule[] = [
  // trivial
  { task: "trivial", weight: 3, reason: "rename/format/one-liner verb",
    patterns: [/\brename\b/i, /\bformat\b/i, /\bindent\b/i, /\btypo\b/i,
               /\badd (a )?(doc ?string|comment|jsdoc)\b/i,
               /\bone[- ]line(r)?\b/i, /\bregex\b/i] },

  // reasoning
  { task: "reasoning", weight: 3, reason: "debug/why/root-cause language",
    patterns: [/\bwhy (is|does|are)\b/i, /\bdebug\b/i, /\broot cause\b/i,
               /\bexplain\b/i, /\banalyz(e|se)\b/i, /\bthink step by step\b/i,
               /\barchitect(ure)?\b/i, /\btrade[- ]offs?\b/i] },
  { task: "reasoning", weight: 2, reason: "stack trace present",
    patterns: [/at \w+ \(.+:\d+:\d+\)/, /Traceback \(most recent call last\)/,
               /Exception in thread/] },

  // code_large
  { task: "code_large", weight: 3, reason: "multi-file / refactor / feature",
    patterns: [/\brefactor\b/i, /\bmigrate\b/i, /\bmulti[- ]file\b/i,
               /\bnew feature\b/i, /\bimplement (a|the) (service|module|system|feature)\b/i,
               /\bport (from|to)\b/i] },

  // code_small
  { task: "code_small", weight: 2, reason: "single function/fix language",
    patterns: [/\bfix\b/i, /\bimplement\b/i, /\badd (a )?function\b/i,
               /\bunit test\b/i, /\bwrite (a )?test\b/i, /\bmethod\b/i] },

  // research
  { task: "research", weight: 3, reason: "comparison/exploration",
    patterns: [/\bcompare\b/i, /\bdifference between\b/i, /\bpros and cons\b/i,
               /\bshould i use\b/i, /\bsurvey\b/i, /\boverview of\b/i] },

  // creative
  { task: "creative", weight: 3, reason: "naming/copy/readme",
    patterns: [/\bname (for|this|the)\b/i, /\bcommit message\b/i,
               /\breadme\b/i, /\btagline\b/i, /\bchangelog\b/i] },

  // agentic
  { task: "agentic", weight: 3, reason: "multi-step / tool-use language",
    patterns: [/\brun tests?\b/i, /\bopen a pr\b/i, /\bstep[- ]by[- ]step\b/i,
               /\band then\b/i, /\bfirst.*then.*finally\b/i,
               /\bscaffold\b/i, /\bset up\b/i] },
];

export function classify(
  prompt: string,
  opts?: { attachedTokens?: number; fileCount?: number }
): ClassificationResult {
  const scores = new Map<TaskType, number>();
  const signals: string[] = [];

  for (const rule of RULES) {
    for (const re of rule.patterns) {
      if (re.test(prompt)) {
        scores.set(rule.task, (scores.get(rule.task) ?? 0) + rule.weight);
        signals.push(`${rule.task}: ${rule.reason}`);
        break; // one hit per rule
      }
    }
  }

  // Context-size heuristics
  const ctxTokens = opts?.attachedTokens ?? 0;
  const files = opts?.fileCount ?? 0;
  if (ctxTokens > 20_000 || files >= 4) {
    scores.set("code_large", (scores.get("code_large") ?? 0) + 2);
    signals.push(`code_large: large context (${ctxTokens} tok, ${files} files)`);
  }

  // Default if nothing matched: treat as code_small.
  if (scores.size === 0) {
    return {
      task: "code_small",
      confidence: 0.4,
      signals: ["default: no rules matched"],
    };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  // confidence: margin over runner-up, normalized
  const confidence = Math.min(1, 0.4 + (topScore - second) * 0.15 + topScore * 0.05);

  return { task: top, confidence, signals };
}

// v0.3 — async variant that escalates to an LLM judge when rule-based
// confidence is below `judgeThreshold`. If the judge is unavailable or
// returns null, the rule-based result stands.
export interface ClassifyAsyncOptions {
  attachedTokens?: number;
  fileCount?: number;
  judge?: JudgeFn;
  judgeThreshold?: number;   // default 0.85 (v0.3.1)
}

export interface ClassifyAsyncResult extends ClassificationResult {
  /** If the LLM judge was consulted and provided one, its output-token estimate. */
  judgeOutputTokensEstimate?: number;
  /** If the LLM judge provided one, estimated agent turns. */
  judgeTurnsEstimate?: number;
  judgeModelId?: string;
}

export async function classifyAsync(
  prompt: string,
  opts: ClassifyAsyncOptions = {}
): Promise<ClassifyAsyncResult> {
  const base = classify(prompt, {
    attachedTokens: opts.attachedTokens,
    fileCount: opts.fileCount,
  });
  const threshold = opts.judgeThreshold ?? 0.85;
  if (!opts.judge || base.confidence >= threshold) return base;

  try {
    const judged = await opts.judge(prompt);
    if (!judged) return base;
    return {
      task: judged.task,
      confidence: Math.max(base.confidence, judged.confidence),
      signals: [
        ...base.signals,
        `llm-judge(${judged.modelId}): task=${judged.task} conf=${judged.confidence.toFixed(2)}${
          judged.outputTokensEstimate ? ` out≈${judged.outputTokensEstimate}` : ""
        }${judged.turnsEstimate ? ` turns≈${judged.turnsEstimate}` : ""}${
          judged.rationale ? ` — ${judged.rationale}` : ""
        }`,
      ],
      judgeOutputTokensEstimate: judged.outputTokensEstimate,
      judgeTurnsEstimate: judged.turnsEstimate,
      judgeModelId: judged.modelId,
    };
  } catch {
    return base;
  }
}
