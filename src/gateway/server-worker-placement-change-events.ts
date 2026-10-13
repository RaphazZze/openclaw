import { formatErrorMessage } from "../infra/errors.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { WorkerPlacementRunnerAvailabilityReader } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementChangeSnapshot } from "./worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

export function createGatewayWorkerPlacementChangePublisher(params: {
  placements: Pick<WorkerSessionPlacementStore, "readChangeSnapshot">;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
  warn: (message: string) => void;
}) {
  const warnPlacementChangeFailure = (error: unknown): void => {
    try {
      params.warn(`Worker placement session change reporting failed: ${formatErrorMessage(error)}`);
    } catch {
      // Reporting failures must never replace a committed placement outcome.
    }
  };
  const snapshotPlacements = async () =>
    new Map(
      (await params.placements.readChangeSnapshot()).map((placement) => [
        placement.sessionId,
        placement,
      ]),
    );
  return async <T>(
    operation: () => Promise<T>,
    preparedBefore?: readonly WorkerSessionPlacementChangeSnapshot[],
  ): Promise<T> => {
    let context: ReturnType<NonNullable<typeof params.getSessionChangeContext>>;
    let before: Awaited<ReturnType<typeof snapshotPlacements>> | undefined;
    try {
      context = params.getSessionChangeContext?.();
      if (context) {
        before = preparedBefore
          ? new Map(preparedBefore.map((placement) => [placement.sessionId, placement]))
          : await snapshotPlacements();
      }
    } catch (error) {
      warnPlacementChangeFailure(error);
    }
    if (!context || !before) {
      return await operation();
    }
    try {
      return await operation();
    } finally {
      try {
        const after = await snapshotPlacements();
        for (const [sessionId, previous] of before) {
          const current = after.get(sessionId);
          if (
            current &&
            current.state === previous.state &&
            current.generation === previous.generation &&
            current.updatedAtMs === previous.updatedAtMs &&
            current.sessionKey === previous.sessionKey &&
            current.agentId === previous.agentId
          ) {
            after.delete(sessionId);
            continue;
          }
          if (!current) {
            after.set(sessionId, previous);
          }
        }
        for (const placement of after.values()) {
          try {
            emitSessionsChanged(context, {
              reason: "placement",
              sessionKey: placement.sessionKey,
              agentId: placement.agentId,
            });
          } catch (error) {
            warnPlacementChangeFailure(error);
          }
        }
      } catch (error) {
        warnPlacementChangeFailure(error);
      }
    }
  };
}

export function subscribeGatewayWorkerPlacementMetadataChanges(params: {
  placements: Pick<
    WorkerSessionPlacementStore,
    "readChangeSnapshot" | "readProjection" | "registerTurnClaimClosedHandler"
  >;
  environments: Pick<WorkerEnvironmentService, "subscribeMachineShapeChanged">;
  runnerAvailability: WorkerPlacementRunnerAvailabilityReader;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
  warn: (message: string) => void;
}) {
  const profiles = new Set<string>();
  const nodes = new Set<string>();
  const closedSessions = new Set<string>();
  let stopped = false;
  let pending: Promise<void> | undefined;
  const schedule = () => {
    if (stopped || !params.getSessionChangeContext?.()) {
      return;
    }
    if (pending) {
      return;
    }
    // Claim closure ends caller work; this Gateway batch reads the committed snapshot.
    pending = runOutsideAsyncWorkScope(() =>
      Promise.resolve().then(async () => {
        let retryClosed = true;
        try {
          while (profiles.size || nodes.size || closedSessions.size) {
            const batch = [...profiles];
            const changedNodes = new Set(nodes);
            const closed = new Set(closedSessions);
            profiles.clear();
            nodes.clear();
            closedSessions.clear();
            try {
              const placements = new Map(
                (batch.length ? await params.placements.readChangeSnapshot(batch) : []).map(
                  (placement) => [placement.sessionId, placement],
                ),
              );
              if (changedNodes.size || closed.size) {
                const identities = changedNodes.size
                  ? await params.placements.readChangeSnapshot()
                  : [];
                const projection = await params.placements.readProjection(
                  [
                    ...closed,
                    ...identities
                      .filter((row) => row.state === "active")
                      .map((row) => row.sessionId),
                  ],
                  { current: true },
                );
                for (const placement of projection.placements.values()) {
                  const runner = params.runnerAvailability.read(
                    placement,
                    projection.environments.get(placement.environmentId ?? "") ?? null,
                  );
                  if (
                    closed.has(placement.sessionId) ||
                    (runner?.deviceId && changedNodes.has(runner.deviceId))
                  ) {
                    placements.set(placement.sessionId, placement);
                  }
                }
              }
              const context = params.getSessionChangeContext?.();
              if (stopped || !context) {
                return;
              }
              for (const placement of placements.values()) {
                emitSessionsChanged(
                  context,
                  {
                    reason: "placement",
                    sessionKey: placement.sessionKey,
                    sessionId: placement.sessionId,
                    agentId: placement.agentId,
                  },
                  { accessChanged: false },
                );
              }
              retryClosed = true;
            } catch (error) {
              try {
                params.warn(
                  `Worker placement metadata change reporting failed: ${formatErrorMessage(error)}`,
                );
              } catch {
                // Best-effort reporting must not leak a rejected background operation.
              }
              if (stopped) {
                return;
              }
              // Retry once; later failures wait for a real change, including one queued during this read.
              const queuedChanges = profiles.size || nodes.size || closedSessions.size;
              closed.forEach((sessionId) => closedSessions.add(sessionId));
              if (!retryClosed && !queuedChanges) {
                return;
              }
              retryClosed = Boolean(queuedChanges);
            }
          }
        } finally {
          pending = undefined;
        }
      }),
    );
  };
  const unsubscribe = params.environments.subscribeMachineShapeChanged((profileId) => {
    profiles.add(profileId);
    schedule();
  });
  const unsubscribeClaims = params.placements.registerTurnClaimClosedHandler((claim) => {
    if (claim.owner.kind === "worker" || claim.owner.environmentId !== undefined) {
      closedSessions.add(claim.sessionId);
      schedule();
    }
  });
  return {
    runnerChanged(nodeId: string) {
      if (stopped) {
        return;
      }
      nodes.add(nodeId);
      schedule();
    },
    async stop() {
      stopped = true;
      profiles.clear();
      nodes.clear();
      closedSessions.clear();
      unsubscribe();
      unsubscribeClaims();
      await pending;
    },
  };
}
