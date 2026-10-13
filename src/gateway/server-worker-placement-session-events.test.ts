import { describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { runtimeFactoryMocks } = getWorkerPlacementStartupMocks();

import { getRuntimeConfig } from "../config/config.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { subscribeGatewayWorkerPlacementMetadataChanges } from "./server-worker-placement-change-events.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { WorkerPlacementInventoryChangedError } from "./worker-environments/placement-inventory-changed-error.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-record.js";
import {
  prepareWorkerTurnClaimClosed,
  registerWorkerTurnClaimClosedHandler,
} from "./worker-environments/placement-turn-claim-events.js";

describe("worker placement session events", () => {
  it.for([
    { label: "after one failed read", failures: 1, duringRetry: false, secondClosure: null },
    {
      label: "on the next real signal after repeated failure",
      failures: 2,
      duringRetry: false,
      secondClosure: null,
    },
    {
      label: "when the next real signal arrives during the retry",
      failures: 2,
      duringRetry: true,
      secondClosure: null,
    },
    {
      label: "with another closure queued during a successful retry",
      failures: 2,
      duringRetry: false,
      secondClosure: "after-retry",
    },
    {
      label: "with another closure queued during the first failed read",
      failures: 2,
      duringRetry: false,
      secondClosure: "during-first",
    },
  ])(
    "publishes claim closures $label",
    async ({ failures, duringRetry, secondClosure }, { signal }) => {
      const sessionId = "closure-session";
      const sessionKey = "agent:main:closure-session";
      const path = "/synthetic/worker-closure-events";
      const placement: WorkerSessionPlacementRecord = {
        sessionId,
        sessionKey,
        agentId: "main",
        state: "active",
        generation: 1,
        executionMode: "worker-turn",
        turnClaim: null,
        environmentId: "worker-environment",
        activeOwnerEpoch: 1,
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: "/worker/workspace",
        workerBundleHash: "a".repeat(64),
        lastTranscriptAckCursor: 1,
        lastLiveEventAckCursor: 1,
        terminalReason: null,
        terminalAtMs: null,
        recoveryError: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
      };
      const claim: WorkerSessionTurnClaim = {
        sessionId,
        claimId: "closed-claim",
        runId: "closed-run",
        placementGeneration: 1,
        owner: { kind: "worker", environmentId: "worker-environment", ownerEpoch: 1 },
      };
      const nextPlacement: WorkerSessionPlacementRecord = {
        ...placement,
        sessionId: "next-closure-session",
        sessionKey: "agent:main:next-closure-session",
      };
      const nextClaim: WorkerSessionTurnClaim = {
        ...claim,
        sessionId: nextPlacement.sessionId,
        claimId: "next-closed-claim",
        runId: "next-closed-run",
      };
      const projection = {
        placements: new Map([
          [sessionId, placement],
          [nextPlacement.sessionId, nextPlacement],
        ]),
        environments: new Map(),
        moves: new Map(),
        pendingResults: new Map(),
        workspaceJournalOwnerSessionIds: new Set<string>(),
        workspaceResultReconcilingSessionIds: new Set<string>(),
        workspaceRecoveryPendingSessionIds: new Set<string>(),
      };
      const readProjection = vi
        .fn<
          Parameters<
            typeof subscribeGatewayWorkerPlacementMetadataChanges
          >[0]["placements"]["readProjection"]
        >()
        .mockResolvedValue(projection);
      const retryStarted = createDeferredCore();
      const releaseRetry = createDeferredCore();
      const failedRead = new WorkerPlacementInventoryChangedError(new Set([sessionId]));
      const heldRead = async () => {
        retryStarted.resolve();
        await releaseRetry.promise;
        if (secondClosure === "after-retry") {
          return projection;
        }
        throw failedRead;
      };
      if (secondClosure === "after-retry") {
        readProjection
          .mockRejectedValueOnce(failedRead)
          .mockImplementationOnce(heldRead)
          .mockRejectedValueOnce(failedRead);
      } else if (secondClosure === "during-first") {
        readProjection.mockImplementationOnce(heldRead).mockRejectedValueOnce(failedRead);
      } else {
        for (let attempt = 0; attempt < failures; attempt += 1) {
          if (duringRetry && attempt === 1) {
            readProjection.mockImplementationOnce(heldRead);
          } else {
            readProjection.mockRejectedValueOnce(failedRead);
          }
        }
      }
      const failureReported = createDeferredCore();
      let reported = 0;
      const warn = vi.fn(() => {
        if (++reported === failures) {
          failureReported.resolve();
        }
      });
      const expectedKeys = secondClosure ? [sessionKey, nextPlacement.sessionKey] : [sessionKey];
      const notifications: string[] = [];
      const published = createDeferredCore();
      const stopObserving = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && expectedKeys.includes(change.sessionKey)) {
          notifications.push(change.sessionKey);
          if (notifications.length === expectedKeys.length) {
            published.resolve();
          }
        }
      });
      const unsubscribeMachine = vi.fn();
      const unsubscribeClaims = vi.fn<() => void>();
      const changes = subscribeGatewayWorkerPlacementMetadataChanges({
        placements: {
          readChangeSnapshot: async () => [],
          readProjection,
          registerTurnClaimClosedHandler: (handler) => {
            unsubscribeClaims.mockImplementation(
              registerWorkerTurnClaimClosedHandler(path, handler),
            );
            return unsubscribeClaims;
          },
        },
        environments: { subscribeMachineShapeChanged: () => unsubscribeMachine },
        runnerAvailability: { read: () => undefined, version: () => 0 },
        getSessionChangeContext: () => ({
          getRuntimeConfig,
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getSessionEventSubscriberConnIds: () => new Set(),
        }),
        warn,
      });
      try {
        prepareWorkerTurnClaimClosed(path, claim)();
        if (duringRetry || secondClosure) {
          await withinTest(retryStarted.promise, signal);
          if (secondClosure) {
            prepareWorkerTurnClaimClosed(path, nextClaim)();
          } else {
            changes.runnerChanged("reconnected-runner");
          }
          releaseRetry.resolve();
        }
        await withinTest(failureReported.promise, signal);
        if (failures === 2 && !duringRetry && !secondClosure) {
          expect(notifications).toEqual([]);
          expect(readProjection).toHaveBeenCalledTimes(2);
          changes.runnerChanged("reconnected-runner");
        }
        await withinTest(published.promise, signal);
        expect(notifications.toSorted()).toEqual(expectedKeys.toSorted());
        expect(warn).toHaveBeenCalledTimes(failures);
      } finally {
        releaseRetry.resolve();
        await changes.stop();
        stopObserving();
      }
      expect(unsubscribeMachine).toHaveBeenCalledOnce();
      expect(unsubscribeClaims).toHaveBeenCalledOnce();
      const reads = readProjection.mock.calls.length;
      prepareWorkerTurnClaimClosed(path, claim)();
      changes.runnerChanged("stopped-runner");
      expect(readProjection).toHaveBeenCalledTimes(reads);
    },
  );

  it("reports a failed reconciliation queued by a session change without leaking rejection", async () => {
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const databaseIdentity = Symbol("worker-placement-database");
    const releaseReconcile = createDeferredCore();
    const reconcileStarted = createDeferredCore();
    const failureReported = createDeferredCore();
    const reconcileActive = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: () => 0,
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    runtimeFactoryMocks.createDispatch.mockReturnValue({
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn().mockResolvedValue(undefined),
      reconcileActive,
    });
    const warn = vi.fn(() => failureReported.resolve());
    const runtime = createGatewayWorkerPlacementRuntime({
      initialPlacements: [],
      scheduler,
      getCommittedRuntimeConfig: getRuntimeConfig,
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        registerTurnClaimClosedHandler: vi.fn(() => vi.fn()),
        getAsync: async () => undefined,
        getManyAsync: async () => new Map(),
        listAsync: async () => [],
        retireSessionPlacementAsync: vi.fn(async () => {}),
        pruneOrphanedWorkspaceReconciliations: async () => [],
        listWorkspaceReconciliationOwners: async () => [],
        listPendingWorkspaceResultsAsync: async () => [],
      } as never,
      environments: {
        subscribeMachineShapeChanged: vi.fn(() => vi.fn()),
        installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      } as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn,
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
      unregisterSidecar: vi.fn(),
    });
    let scheduledWake: void | Promise<void> = undefined;
    try {
      await time.advanceBy(60_000);
      expect(warn).not.toHaveBeenCalled();
      reconcileActive.mockClear();
      reconcileActive
        .mockImplementationOnce(() => {
          reconcileStarted.resolve();
          return releaseReconcile.promise;
        })
        .mockRejectedValue(new Error("Worker environment inventory has closed"));
      scheduledWake = time.advanceBy(60_000);
      await reconcileStarted.promise;
      expect(reconcileActive).toHaveBeenCalledOnce();
      emitSessionIdentityMutation({
        kind: "delete",
        agentId: "main",
        databaseIdentity,
        previous: { sessionId: "retired-session", sessionKeys: ["agent:main:retired"] },
      });
      releaseReconcile.resolve();
      await failureReported.promise;
      expect(reconcileActive).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "Worker placement reconcile sweep failed: Worker environment inventory has closed",
      );
    } finally {
      releaseReconcile.resolve();
      await sidecar?.stop();
      await scheduledWake;
    }
  });
});
