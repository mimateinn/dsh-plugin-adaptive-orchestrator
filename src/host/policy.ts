/** Captain orchestration policy: delegation-only tool guard and prompt guidance. */

export type ToolDecision = { kind: "allow" } | { kind: "deny"; reason: string };

/** Delegation role of the calling agent (absent when the host lacks roles). */
export type RoleLike = "captain" | "worker" | undefined;

/**
 * Capability-based captain allowlist. Membership is granted either from the
 * minimal builtin orchestration surface or by explicit trusted registration
 * (never by a tool name alone appearing in the call stream).
 */
export class OrchestrationAllowlist {
  private readonly names = new Set<string>();

  constructor(initial: readonly string[] = []) {
    for (const name of initial) this.names.add(name);
  }

  /** Grant orchestration capability from trusted plugin code. */
  add(name: string): void {
    this.names.add(name);
  }

  has(name: string): boolean {
    return this.names.has(name);
  }
}

/** Minimal builtin orchestration surface for the captain. */
export const BUILTIN_CAPTAIN_TOOLS = [
  "plan",
  "ask_user",
  "todo",
  "subagent",
  "subagent_control",
  "agent_team",
  "agent_team_control",
  "job_status",
  "job_collect",
  "message",
  "message_send",
];

/** Registry-resolved tool identity (definition name), never the raw call stream. */
export interface ResolvedTool {
  readonly name: string;
}

/** Resolve the tool the host registry would actually execute for a call name. */
export type ToolResolver = (name: string) => ResolvedTool | undefined;

/**
 * Decide whether a tool call may proceed under the captain policy. Trust
 * binds to the REGISTRY-RESOLVED tool definition, not the caller-supplied
 * name string: an unresolvable or mis-resolved call is denied even when the
 * requested name sits in the allowlist.
 */
export function decideTool(
  role: RoleLike,
  toolName: string,
  enabled: boolean,
  allowlist: OrchestrationAllowlist,
  resolver?: ToolResolver,
): ToolDecision {
  if (!enabled) return { kind: "allow" };
  if (role === "worker") return { kind: "allow" };
  if (role !== "captain") {
    // Without an authoritative immutable role the policy cannot prove the
    // caller is the captain; enforcement must fail closed.
    return {
      kind: "deny",
      reason:
        "delegation role is unavailable; global orchestration is not authoritative",
    };
  }
  if (resolver !== undefined) {
    const resolved = resolver(toolName);
    if (resolved === undefined) {
      return {
        kind: "deny",
        reason: `"${toolName}" is not registered in the host tool registry`,
      };
    }
    if (resolved.name !== toolName) {
      return {
        kind: "deny",
        reason: `"${toolName}" resolved to a different tool definition`,
      };
    }
  }
  if (allowlist.has(toolName)) return { kind: "allow" };
  return {
    kind: "deny",
    reason: `captain must delegate "${toolName}" to a qualified worker`,
  };
}

/** System-prompt guidance contributed to captain sessions. */
export const CAPTAIN_GUIDANCE = [
  "You are the captain. Delegate code reading, research, design production, implementation, testing, and review to workers.",
  "Direct, decompose, define dependencies, supervise, integrate results, and communicate with the user.",
  "Use planning, task, delegation, status, messaging, and result-collection tools; do not execute worker tools yourself.",
].join("\n");
