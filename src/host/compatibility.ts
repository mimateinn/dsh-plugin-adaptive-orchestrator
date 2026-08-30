/** Host capability probing for global orchestration enablement. */

/** What the running DSH host advertises through its generic seams. */
export interface HostCapabilities {
  readonly admissionProtocol?: string;
  readonly admissionVersion?: number;
  readonly taskClaim?: number;
  readonly agentRole?: boolean;
}

/** One capability failure that makes global mode unavailable. */
export interface CapabilityFailure {
  readonly code: string;
  readonly message: string;
}

/** Injectable seam that reads the host capability surface. */
export interface CompatibilityProbe {
  capabilities(): HostCapabilities;
}

export interface CompatibilityReport {
  readonly dshVersion: string;
  readonly checkedAt: string;
  readonly capabilities: HostCapabilities;
  readonly supported: boolean;
  readonly failures: CapabilityFailure[];
}

/** Required generic seams for global orchestration to be authoritative. */
export const REQUIRED_CAPABILITIES = {
  admissionProtocol: "delegation-admission",
  admissionVersion: 2,
  taskClaim: 2,
  agentRole: true,
} as const;

/**
 * Build a fail-closed compatibility report. Any missing or mismatched
 * required capability produces a visible failure and supported=false.
 */
export function compatibilityReport(
  probe: CompatibilityProbe,
  dshVersion: string,
  now = new Date(),
): CompatibilityReport {
  const capabilities = probe.capabilities();
  const failures: CapabilityFailure[] = [];
  if (
    capabilities.admissionProtocol !== REQUIRED_CAPABILITIES.admissionProtocol
  ) {
    failures.push({
      code: "ADMISSION_PROTOCOL",
      message: "delegation admission protocol is unavailable or unsupported",
    });
  }
  if (
    capabilities.admissionVersion !== REQUIRED_CAPABILITIES.admissionVersion
  ) {
    failures.push({
      code: "ADMISSION_VERSION",
      message: "delegation admission version is not supported",
    });
  }
  if (capabilities.taskClaim !== REQUIRED_CAPABILITIES.taskClaim) {
    failures.push({
      code: "TASK_CLAIM",
      message: "Agent Teams task-claim admission is unavailable",
    });
  }
  if (capabilities.agentRole !== REQUIRED_CAPABILITIES.agentRole) {
    failures.push({
      code: "AGENT_ROLE",
      message: "immutable delegation roles are unavailable",
    });
  }
  return {
    dshVersion,
    checkedAt: now.toISOString(),
    capabilities,
    supported: failures.length === 0,
    failures,
  };
}
