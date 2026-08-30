/**
 * Adaptive orchestrator plugin entry. One global toggle controls
 * orchestration; when disabled, all policy is bypassed.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";
import { FileSettingsRepository } from "./persistence/index.js";
import { SettingsService, defaultSettings } from "./host/settings.js";
import {
  compatibilityReport,
  type HostCapabilities,
} from "./host/compatibility.js";
import {
  CAPTAIN_ALLOWLIST,
  CAPTAIN_GUIDANCE,
  decideTool,
} from "./host/policy.js";
import {
  createDelegationHandler,
  createTaskClaimHandler,
} from "./host/admission.js";

export * from "./persistence/index.js";
export * from "./host/index.js";

export const name = "adaptive-orchestrator";

export interface Config {
  enabled?: boolean;
  /** Directory for durable profile-local settings and evaluations. */
  profileDirectory?: string;
  /** DSH version string used in the compatibility report. */
  dshVersion?: string;
}

export const Config = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: false },
    profileDirectory: { type: "string" },
    dshVersion: { type: "string", default: "unknown" },
  },
} as const;

/** Structural view of the calling agent: immutable role, absent on legacy hosts. */
interface CallerAgent {
  delegationRole?: "captain" | "worker";
}

function hostCapabilities(ctx: Context): HostCapabilities {
  const admission = ctx.get("delegationAdmission");
  const caps = admission?.capabilities?.();
  return {
    admissionProtocol: caps?.protocol,
    admissionVersion: caps?.version,
    taskClaim: caps?.taskClaim,
    // Immutable roles ship with the same host as the task-claim seam; the
    // tool guard additionally fails closed when a real caller lacks a role.
    agentRole: true,
  };
}

export function apply(ctx: Context, config: Config = {}): void {
  const profileDirectory =
    config.profileDirectory ?? join(homedir(), ".dsh-adaptive-orchestrator");
  const settings = new SettingsService(
    new FileSettingsRepository(profileDirectory),
  );
  const enabled = config.enabled ?? false;
  if (!enabled) return;

  const report = compatibilityReport(
    { capabilities: () => hostCapabilities(ctx) },
    config.dshVersion ?? "unknown",
  );
  if (!report.supported) {
    ctx.logger.warn(
      `adaptive orchestrator unavailable: ${report.failures.map((f) => f.code).join(", ")}`,
    );
    return;
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = [];
    void settings.read().then(async (stored) => {
      const current = stored ?? defaultSettings();
      if (!current.enabled) return;

      const section: PromptSection = {
        name: "adaptive-orchestrator",
        order: 1000,
        text: CAPTAIN_GUIDANCE,
      };
      const sectionDisposer = ctx.systemPrompt?.section?.(section);
      if (sectionDisposer !== undefined) disposers.push(sectionDisposer);

      const preExecute = async (
        exec: ToolExecution,
        next: () => Promise<PreToolDecision>,
      ): Promise<PreToolDecision> => {
        const caller = exec.agent as CallerAgent | undefined;
        const decision = decideTool(
          caller?.delegationRole,
          exec.name,
          true,
          CAPTAIN_ALLOWLIST,
        );
        if (decision.kind === "deny")
          return { kind: "deny", reason: decision.reason };
        return next();
      };
      const eventDisposer = ctx.on("tools/pre-execute", preExecute as never);
      if (eventDisposer !== undefined) disposers.push(eventDisposer);

      const bridgeOptions = {
        gateway: {
          acquire: async () => ({ leaseId: crypto.randomUUID() }),
          release: async () => undefined,
        },
        resolveRoute: () => "default",
      };
      const admission = ctx.get("delegationAdmission");
      if (admission !== undefined) {
        disposers.push(
          admission.register(createDelegationHandler(bridgeOptions) as never),
        );
        disposers.push(
          admission.registerTaskClaim(
            createTaskClaimHandler(bridgeOptions) as never,
          ),
        );
      }
    });
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}
