#!/usr/bin/env node
// MCP server — exposes Conductor's core as tools over stdio.
// Works with Copilot agent mode, Copilot CLI, Claude Desktop, Cursor, etc.
//
// v0.2: policy-aware (`.token-proctor.json`), redacts secrets in prompts and
//       attached context before analysis, optional JSONL audit log.
// v0.3: exact token counts via js-tiktoken when installed.

import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  analyzeAsync, classify, validate, estimateTokens, estimateCost,
  MODEL_CATALOG, loadPolicy, redact, writeAuditEntry,
  tryInstallTiktoken, isExactTokenization,
} from "./core/index.js";
import { route } from "./core/modelRouter.js";
import { findModel } from "./data/pricing.js";

// Best-effort install of exact tokenization at startup.
void tryInstallTiktoken();

// Load policy from the MCP client's cwd (workspace root for stdio MCPs).
const { policy, source: policySource } = loadPolicy(process.cwd());

const server = new Server(
  { name: "token-proctor", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "analyze_prompt",
    description:
      "Run the full Conductor pipeline on a prompt: redact, classify, validate, route, cost. Applies policy if .token-proctor.json is present.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        attachedText: { type: "string", description: "Concatenated attached context (optional)" },
        preferCheap: { type: "boolean" },
        completenessThreshold: { type: "number" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "validate_prompt",
    description: "Score a prompt's completeness 0-100 and return follow-up questions if weak.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        attachedChars: { type: "number" },
        threshold: { type: "number" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "recommend_model",
    description: "Recommend the best model for a given prompt. Returns model id, alternatives, rationale.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        attachedText: { type: "string" },
        preferCheap: { type: "boolean" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "estimate_cost",
    description: "Estimate tokens and USD cost for a prompt against a named model.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        attachedText: { type: "string" },
        modelId: { type: "string", description: "One of the catalog ids; omit to auto-route" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_models",
    description: "List the model catalog with prices and premium multipliers.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "redact_text",
    description: "Return a redacted copy of the input text using built-in + policy secret patterns.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "get_policy",
    description: "Return the loaded policy and its source path.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case "analyze_prompt": {
        const r = await analyzeAsync({
          prompt: String(args.prompt),
          attachedText: args.attachedText ? String(args.attachedText) : undefined,
          preferCheap: !!args.preferCheap,
          completenessThreshold: typeof args.completenessThreshold === "number"
            ? args.completenessThreshold : undefined,
          policy,
          // No judge: MCP server has no way to call the client's LLM here.
          // Rule-based classifier is still fast and deterministic.
          judgeEnabled: false,
        });

        // Opt-in audit log.
        if (policy.audit?.enabled) {
          const filePath = policy.audit.path
            ? path.resolve(process.cwd(), policy.audit.path)
            : path.join(process.cwd(), ".token-proctor", "audit.jsonl");
          writeAuditEntry(filePath, {
            ts: new Date().toISOString(),
            surface: "mcp",
            command: "analyze_prompt",
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
            blocked: r.blocked,
            notes: r.policyNotes,
          });
        }

        return json({
          ...r,
          tokenization: isExactTokenization() ? "exact" : "heuristic",
          policySource,
        });
      }

      case "validate_prompt": {
        const redacted = redact(String(args.prompt), {
          builtins: policy.redact?.builtins !== false,
          extraPatterns: policy.redact?.patterns,
        });
        const r = validate(redacted.text, {
          attachedChars: typeof args.attachedChars === "number" ? args.attachedChars : 0,
          threshold: typeof args.threshold === "number" ? args.threshold : undefined,
        });
        return json({ ...r, redactions: redacted.redactions });
      }

      case "recommend_model": {
        const prompt = redact(String(args.prompt), {
          builtins: policy.redact?.builtins !== false,
          extraPatterns: policy.redact?.patterns,
        }).text;
        const attached = args.attachedText
          ? redact(String(args.attachedText), {
              builtins: policy.redact?.builtins !== false,
              extraPatterns: policy.redact?.patterns,
            }).text
          : "";
        const cls = classify(prompt, { attachedTokens: estimateTokens(attached) });
        const r = route(cls.task, {
          inputTokens: estimateTokens(prompt + "\n" + attached),
          preferCheap: !!args.preferCheap,
        });
        return json({ classification: cls, routing: r });
      }

      case "estimate_cost": {
        const prompt = redact(String(args.prompt), {
          builtins: policy.redact?.builtins !== false,
          extraPatterns: policy.redact?.patterns,
        }).text;
        const attached = args.attachedText
          ? redact(String(args.attachedText), {
              builtins: policy.redact?.builtins !== false,
              extraPatterns: policy.redact?.patterns,
            }).text
          : "";
        const inputTokens = estimateTokens(prompt + "\n" + attached);
        const cls = classify(prompt);
        const model = args.modelId
          ? findModel(String(args.modelId))
          : route(cls.task, { inputTokens }).model;
        if (!model) return text(`Unknown model: ${args.modelId}`);
        const c = estimateCost(model, { inputTokens, task: cls.task });
        return json({ ...c, tokenization: isExactTokenization() ? "exact" : "heuristic" });
      }

      case "list_models":
        return json(MODEL_CATALOG);

      case "redact_text": {
        const r = redact(String(args.text), {
          builtins: policy.redact?.builtins !== false,
          extraPatterns: policy.redact?.patterns,
        });
        return json(r);
      }

      case "get_policy":
        return json({ source: policySource, policy });

      default:
        return text(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return text(`Error: ${err?.message ?? err}`);
  }
});

function json(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function text(t: string) {
  return { content: [{ type: "text", text: t }] };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `token-proctor MCP server ready (policy=${policySource}, tokens=${
      isExactTokenization() ? "exact" : "heuristic"
    })`
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
