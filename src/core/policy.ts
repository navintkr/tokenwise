// v0.2 — Policy loader.
// Reads `.conductor.json` from workspace root or `~/.conductor/config.json`.
// Pure JSON for zero-dep loading; YAML can be added later.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TaskType } from "./types.js";

export interface Policy {
  // Model gating
  allowModels?: string[];                  // if set, only these catalog ids are eligible
  denyModels?: string[];                   // never pick these
  premiumModelsAllowedFor?: TaskType[];    // if set, premium tier only allowed for these tasks

  // Redaction
  redact?: {
    builtins?: boolean;                    // aws, pem, jwt, high-entropy (default: true)
    patterns?: string[];                   // additional regex strings
    blockOnMatch?: boolean;                // refuse to proceed if any redaction fires
  };

  // Audit
  audit?: {
    enabled?: boolean;                     // default: false
    path?: string;                         // default: <workspace>/.conductor/audit.jsonl
  };

  // Defaults (override settings.json)
  completenessThreshold?: number;
  preferCheap?: boolean;
  /** "tokens" | "turns" | "balanced" — how to weigh cost axes in routing. */
  optimizeFor?: "tokens" | "turns" | "balanced";

  // LLM judge
  llmJudge?: {
    enabled?: boolean;                     // default: true
    confidenceThreshold?: number;          // default: 0.85
  };

  // Token-based plan context — drives "% of monthly allowance" in summary.
  plan?: {
    name?: string;                         // e.g. "squad", "fleet", "free", "internal"
    monthlyTokenAllowance?: number;        // tokens bundled per user per month
    overageUsdPerM?: number;               // USD per 1M tokens beyond allowance
  };
}

const DEFAULT_POLICY: Policy = {
  redact: { builtins: true, blockOnMatch: false },
  audit: { enabled: false },
  llmJudge: { enabled: true, confidenceThreshold: 0.85 },
};

export function loadPolicy(workspaceRoot?: string): { policy: Policy; source: string } {
  const candidates: string[] = [];
  if (workspaceRoot) {
    candidates.push(path.join(workspaceRoot, ".conductor.json"));
    candidates.push(path.join(workspaceRoot, ".conductor", "config.json"));
  }
  candidates.push(path.join(os.homedir(), ".conductor", "config.json"));

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw) as Policy;
        return { policy: mergePolicy(DEFAULT_POLICY, parsed), source: file };
      }
    } catch {
      // ignore malformed and continue
    }
  }
  return { policy: DEFAULT_POLICY, source: "(defaults)" };
}

export function mergePolicy(a: Policy, b: Policy): Policy {
  return {
    allowModels: b.allowModels ?? a.allowModels,
    denyModels: dedupe([...(a.denyModels ?? []), ...(b.denyModels ?? [])]),
    premiumModelsAllowedFor: b.premiumModelsAllowedFor ?? a.premiumModelsAllowedFor,
    redact: { ...(a.redact ?? {}), ...(b.redact ?? {}) },
    audit: { ...(a.audit ?? {}), ...(b.audit ?? {}) },
    completenessThreshold: b.completenessThreshold ?? a.completenessThreshold,
    preferCheap: b.preferCheap ?? a.preferCheap,
    optimizeFor: b.optimizeFor ?? a.optimizeFor,
    llmJudge: { ...(a.llmJudge ?? {}), ...(b.llmJudge ?? {}) },
    plan: { ...(a.plan ?? {}), ...(b.plan ?? {}) },
  };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Filter the catalog ids given a policy. Returns the allowed id list or undefined (no gating). */
export function applyModelGating(
  catalogIds: string[],
  policy: Policy,
  task: TaskType,
  premiumIds: Set<string>
): { allowedIds: string[] | undefined; reasons: string[] } {
  const reasons: string[] = [];
  let pool = catalogIds;

  if (policy.allowModels?.length) {
    pool = pool.filter((id) => policy.allowModels!.includes(id));
    reasons.push(`policy.allowModels restricts pool to ${policy.allowModels.join(", ")}`);
  }
  if (policy.denyModels?.length) {
    pool = pool.filter((id) => !policy.denyModels!.includes(id));
    reasons.push(`policy.denyModels removes ${policy.denyModels.join(", ")}`);
  }
  if (policy.premiumModelsAllowedFor && !policy.premiumModelsAllowedFor.includes(task)) {
    pool = pool.filter((id) => !premiumIds.has(id));
    reasons.push(`premium tier blocked for task=${task} by policy.premiumModelsAllowedFor`);
  }

  // Undefined signals "no gating" to the router, so pass the full pool only when gating applied.
  const gated = policy.allowModels?.length || policy.denyModels?.length || policy.premiumModelsAllowedFor;
  return { allowedIds: gated ? pool : undefined, reasons };
}
