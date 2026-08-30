export * from "./persistence/index.js";

export const name = "adaptive-orchestrator";

export interface Config {
  enabled?: boolean;
}

export const Config = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: false },
  },
} as const;

export function apply(): void {
  // Host integration is implemented after the RED contract tests land.
}
