/** Bridge from the DSH delegation-admission seams to the plugin scheduler. */

/** Minimal scheduler lease surface used by the bridge (inject the real scheduler). */
export interface SchedulerGateway {
  acquire(request: {
    requestId: string;
    attemptId: string;
    lane: "interactive" | "background";
    routeId: string;
    payloadHash: string;
    createdAt: number;
    settingsRevision: number;
    modelRevision: number;
    capabilityRevision: number;
  }): Promise<{ leaseId: string }>;
  release(leaseId: string, attemptId: string): Promise<void>;
}

/** One releaseable lease handed to DSH. */
export interface AdmissionLeaseLike {
  release(): void | Promise<void>;
}

/** Resolve a stable route id for a provider (unknown providers fail closed). */
export type RouteResolver = (provider: string) => string | undefined;

export interface AdmissionBridgeOptions {
  readonly gateway: SchedulerGateway;
  readonly resolveRoute: RouteResolver;
  readonly now?: () => number;
}

/**
 * Build the ordinary delegation-admission handler (subagent spawn). Every
 * acquire maps to one scheduler lease; every release maps to one scheduler
 * release, exactly once.
 */
export function createDelegationHandler(
  options: AdmissionBridgeOptions,
): (
  request: { provider: string },
  signal: AbortSignal,
) => AdmissionLeaseLike | Promise<AdmissionLeaseLike> {
  const { gateway, resolveRoute, now = Date.now } = options;
  return async (request) => {
    const routeId = resolveRoute(request.provider);
    if (routeId === undefined)
      throw new Error(`no eligible route for provider "${request.provider}"`);
    const attemptId = crypto.randomUUID();
    const lease = await gateway.acquire({
      requestId: attemptId,
      attemptId,
      lane: "background",
      routeId,
      payloadHash: "delegation-admission",
      createdAt: now(),
      settingsRevision: 0,
      modelRevision: 0,
      capabilityRevision: 0,
    });
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await gateway.release(lease.leaseId, attemptId);
      },
    };
  };
}

/** Durable task-claim preparation mapped to the same scheduler gateway. */
export function createTaskClaimHandler(options: AdmissionBridgeOptions): {
  prepare(
    request: {
      teamId: string;
      taskId: string;
      attemptId: string;
      ownerId: string;
    },
    signal: AbortSignal,
  ): Promise<{
    commit(): void | Promise<void>;
    rollback(): void | Promise<void>;
  }>;
  reacquire(
    request: {
      teamId: string;
      taskId: string;
      attemptId: string;
      ownerId: string;
    },
    signal: AbortSignal,
  ): Promise<{
    commit(): void | Promise<void>;
    rollback(): void | Promise<void>;
  }>;
} {
  const { gateway, resolveRoute, now = Date.now } = options;
  const acquireFor = async (request: {
    teamId: string;
    taskId: string;
    attemptId: string;
    ownerId: string;
  }) => {
    const routeId = resolveRoute("task-claim");
    if (routeId === undefined)
      throw new Error(`no eligible route for task claim "${request.taskId}"`);
    return gateway.acquire({
      // Request identity equals the attempt so pre-dispatch cancel(requestId)
      // targets this lease; reacquire after a terminal/rollback is admitted
      // again with the same attempt id.
      requestId: request.attemptId,
      attemptId: request.attemptId,
      lane: "background",
      routeId,
      payloadHash: "task-claim-admission",
      createdAt: now(),
      settingsRevision: 0,
      modelRevision: 0,
      capabilityRevision: 0,
    });
  };
  const makePreparation = (lease: { leaseId: string }, attemptId: string) => {
    let committed = false;
    let rolledBack = false;
    return {
      commit: async () => {
        committed = true;
      },
      rollback: async () => {
        if (committed || rolledBack) return;
        rolledBack = true;
        await gateway.release(lease.leaseId, attemptId);
      },
    };
  };
  return {
    prepare: async (request) =>
      makePreparation(await acquireFor(request), request.attemptId),
    reacquire: async (request) =>
      makePreparation(await acquireFor(request), request.attemptId),
  };
}
