/**
 * Adaptive orchestrator plugin entry. One global toggle controls
 * orchestration; when disabled, all policy is bypassed.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";
import z from "@deepseek-ai/schemastery";
import { FileSettingsRepository } from "./persistence/index.js";
import { SettingsService, defaultSettings } from "./host/settings.js";
import {
  compatibilityReport,
  type HostCapabilities,
} from "./host/compatibility.js";
import {
  BUILTIN_CAPTAIN_TOOLS,
  CAPTAIN_GUIDANCE,
  decideTool,
  OrchestrationAllowlist,
} from "./host/policy.js";
import {
  createDelegationHandler,
  createTaskClaimHandler,
  type SchedulerGateway,
} from "./host/admission.js";
import {
  createScheduler,
  MemoryStateStore,
  type Route,
} from "./scheduler/index.js";

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

/**
 * Static seam evidence. The immutable-role seam is intentionally NOT claimed
 * here: it is proven at runtime by the first observed agent role, and until
 * then the tool guard denies every captain call (fail closed).
 */
function hostCapabilities(
  ctx: Context,
  roleProven: { current: boolean },
): HostCapabilities {
  const admission = ctx.get("delegationAdmission");
  const caps = admission?.capabilities?.();
  return {
    admissionProtocol: caps?.protocol,
    admissionVersion: caps?.version,
    taskClaim: caps?.taskClaim,
    ...(roleProven.current ? { agentRole: true } : {}),
  };
}

/** Build the real in-process scheduler gateway used while orchestration is active. */
function buildSchedulerGateway(): SchedulerGateway {
  const store = new MemoryStateStore();
  const scheduler = createScheduler(store, {
    globalCap: 8,
    providerCap: 4,
    accountCap: 4,
    modelCap: 4,
    interactiveReserve: 1,
    backgroundReserve: 1,
  });
  return {
    acquire: async (request) => {
      const route: Route = {
        id: "default",
        provider: "default",
        account: "default",
        model: "default",
        safeSlots: 1,
      };
      const enqueued = scheduler.enqueue({ ...request, deficitCost: 1 });
      if (enqueued.kind !== "admitted")
        throw new Error("admission queue rejected the request");
      const started = scheduler.tick([route], Date.now());
      const lease = started.find(
        (candidate) => candidate.requestId === request.requestId,
      );
      if (lease === undefined) {
        scheduler.cancel(request.requestId, "cancel");
        throw new Error("no scheduler capacity for the request");
      }
      return { leaseId: lease.leaseId };
    },
    release: async (leaseId, attemptId) => {
      const token = scheduler.observeProviderTerminal(
        leaseId,
        attemptId,
        "succeeded",
      );
      if (token === false) scheduler.cancel(attemptId, "cancel");
      else scheduler.settleProviderTerminal(token);
    },
  };
}

/** Structural host settings service face (dsh-settings). */
interface SettingsServiceLike {
  register(
    namespace: string,
    schema: unknown,
    options?: { base?: object; applies?: "live" | "restart" },
  ): {
    get(): { enabled?: boolean };
    watch(cb: (next: { enabled?: boolean }) => void): () => void;
  };
}

/** Settings-page schema: the global toggle and the sensitive allowlist. */
const adaptiveSettingsSchema = z.object({
  enabled: z.boolean(),
  sensitive: z.object({
    enabled: z.boolean(),
    modelAllowlist: z.array(z.string()),
  }),
});

export function apply(ctx: Context, config: Config = {}): void {
  const profileDirectory =
    config.profileDirectory ?? join(homedir(), ".dsh-adaptive-orchestrator");
  const roleProven = { current: false };

  ctx.effect(() => {
    const disposers: Array<() => void> = [];
    const runtime = { active: false, roleProven: false };
    roleProven.current = runtime.roleProven;

    // Durable toggle source: the original DSH Settings namespace when the host
    // exposes settings, else the profile-local file repository.
    const settingsService = ctx.get("settings") as
      SettingsServiceLike | undefined;
    if (settingsService?.register !== undefined) {
      const scope = settingsService.register(
        "adaptive-orchestrator",
        adaptiveSettingsSchema,
        { applies: "live" },
      );
      runtime.active = scope.get()?.enabled === true;
      disposers.push(
        scope.watch((next) => {
          runtime.active = next?.enabled === true;
        }),
      );
    } else {
      const settings = new SettingsService(
        new FileSettingsRepository(profileDirectory),
      );
      void settings
        .read()
        .then((stored) => {
          runtime.active = (stored ?? defaultSettings()).enabled;
        })
        .catch(() => {
          runtime.active = false;
        });
    }

    // Enforcement hooks only register when the admission seams are present;
    // they stay inert until the durable toggle turns active.
    const report = compatibilityReport(
      { capabilities: () => hostCapabilities(ctx, roleProven) },
      config.dshVersion ?? "unknown",
    );
    const staticFailures = report.failures.filter(
      (failure) => failure.code !== "AGENT_ROLE",
    );
    if (staticFailures.length > 0) {
      ctx.logger.warn(
        `adaptive orchestrator unavailable: ${staticFailures.map((failure) => failure.code).join(", ")}`,
      );
      return () => {
        for (const dispose of disposers) dispose();
      };
    }

    const allowlist = new OrchestrationAllowlist(BUILTIN_CAPTAIN_TOOLS);
    const gateway = buildSchedulerGateway();

    // Synchronous registration: cleanup cannot outrun hook installation.
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
      if (!runtime.active) return next();
      const caller = exec.agent as CallerAgent | undefined;
      if (caller?.delegationRole !== undefined) {
        runtime.roleProven = true;
        roleProven.current = true;
      }
      const decision = decideTool(
        caller?.delegationRole,
        exec.name,
        runtime.active,
        allowlist,
        (name) => {
          const definition = ctx.tools?.get?.(name);
          return definition === undefined
            ? undefined
            : { name: definition.name };
        },
      );
      if (decision.kind === "deny")
        return { kind: "deny", reason: decision.reason };
      return next();
    };
    const eventDisposer = ctx.on("tools/pre-execute", preExecute as never);
    if (eventDisposer !== undefined) disposers.push(eventDisposer);

    const bridgeOptions = {
      gateway,
      resolveRoute: () => "default",
    };
    const admission = ctx.get("delegationAdmission");
    if (admission !== undefined) {
      const delegation = createDelegationHandler(bridgeOptions);
      const taskClaim = createTaskClaimHandler(bridgeOptions);
      disposers.push(
        admission.register(
          (request: { provider: string }, signal: AbortSignal) => {
            if (!runtime.active) return { release: () => undefined };
            return delegation(request, signal);
          },
        ) as never,
      );
      disposers.push(
        admission.registerTaskClaim({
          prepare: (
            request: {
              teamId: string;
              taskId: string;
              attemptId: string;
              ownerId: string;
            },
            signal: AbortSignal,
          ) => {
            if (!runtime.active)
              return { commit: () => undefined, rollback: () => undefined };
            return taskClaim.prepare(request, signal);
          },
          reacquire: (
            request: {
              teamId: string;
              taskId: string;
              attemptId: string;
              ownerId: string;
            },
            signal: AbortSignal,
          ) => {
            if (!runtime.active)
              return { commit: () => undefined, rollback: () => undefined };
            return taskClaim.reacquire(request, signal);
          },
        }) as never,
      );
    }

    if (runtime.active && !runtime.roleProven) {
      ctx.logger.info(
        "adaptive orchestrator enabled; awaiting the first observed delegation role",
      );
    }

    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}
