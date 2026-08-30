export type Confidence = "high" | "medium" | "low";
export interface QuotaSnapshot {
  supported: boolean;
  usedPercent?: number;
  resetsAt?: number;
  observedAt: number;
  confidence: Confidence;
}
export type CircuitState = "closed" | "open" | "half-open";
export interface WorkerCandidate {
  routeId: string;
  provider: string;
  account: string;
  model: string;
  taskClass: string;
  authenticated: boolean;
  enabled: boolean;
  capabilityIds: string[];
  tools: string[];
  modalities: string[];
  capabilityFit: number;
  healthConfidence: number;
  expectedLatencyMs: number;
  maximumContextTokens: number;
  quotaSnapshots: QuotaSnapshot[];
  health: { circuit: CircuitState; accountDisabled?: boolean };
}
export interface RouteRequirements {
  enabled: boolean;
  taskClass: string;
  requiredCapabilityIds: string[];
  requiredToolIds: string[];
  requiredModalities: string[];
  minimumContextTokens: number;
  sensitive: boolean;
  allowedModelIds: string[];
}
export type RouteResult =
  | {
      kind: "route";
      routeId: string;
      score: number;
      reasonCodes: string[];
      decidedAt: number;
    }
  | { kind: "no-route"; reasonCodes: string[] };
export interface Clock {
  now(): number;
}
export interface HealthOutcome {
  success: boolean;
  rateLimited: boolean;
  latencyMs?: number;
  at: number;
}
export interface HealthState {
  safeSlots: number;
  circuit: CircuitState;
  accountDisabled: boolean;
  cooldownUntil?: number;
  failureSequence: number;
  outcomes: HealthOutcome[];
  latencyBaseline?: number;
  consecutiveSuccesses: number;
  lastIncreaseAt?: number;
}
export type HealthEvent =
  | { kind: "http"; status: number; retryAfterMs?: number; at: number }
  | { kind: "success"; latencyMs: number; at: number }
  | { kind: "tick"; at: number };
