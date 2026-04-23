// Core types shared by extension and MCP server.

export type TaskType =
  | "trivial"
  | "code_small"
  | "code_large"
  | "reasoning"
  | "research"
  | "creative"
  | "agentic";

export interface ClassificationResult {
  task: TaskType;
  confidence: number; // 0..1
  signals: string[];  // human-readable reasons
}

export interface ValidationDimension {
  name: string;
  weight: number;
  score: number; // 0..100
  note: string;
}

export interface ValidationResult {
  score: number;                    // 0..100, weighted
  dimensions: ValidationDimension[];
  followUpQuestions: string[];      // non-empty if score < threshold
  verdict: "ready" | "weak" | "blocked";
}

export interface ModelSpec {
  id: string;                       // e.g. "gpt-4o-mini"
  family: "openai" | "anthropic" | "google" | "meta" | "mistral" | "other";
  displayName: string;
  contextWindow: number;            // tokens
  pricePerMInput: number;           // USD per 1M tokens
  pricePerMOutput: number;
  copilotPremiumMultiplier: number; // 0 = base, 1 = 1 premium request, etc.
  strengths: TaskType[];
  tier: "cheap" | "balanced" | "premium" | "reasoning";
}

export interface RoutingResult {
  model: ModelSpec;
  alternatives: ModelSpec[];
  rationale: string[];
}

export interface CostEstimate {
  inputTokens: number;
  outputTokensEstimate: number;
  totalUsd: number;
  premiumRequests: number;
  model: string;
  humanReadable: string;
  /** Estimated agent turns (1 = a single LLM call; more for agentic/code_large). */
  turnsEstimate?: number;
  /** Total tokens across all turns (input + output). */
  totalTokensEstimate?: number;
  /** % of monthly plan allowance this prompt is projected to consume (0-100+). */
  planBurnPercent?: number;
  /** Name of the plan this was measured against ("squad", "fleet", or custom). */
  planName?: string;
}
