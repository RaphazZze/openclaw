import { describe, expect, it } from "vitest";
import {
  createWorkerPreparationIdentity,
  readWorkerPreparation,
  readWorkerProjectPreparation,
} from "./preparation-identity.js";
import type { WorkerLocalProjectSnapshot } from "./workspace-git-base.js";

const input: Omit<Parameters<typeof createWorkerPreparationIdentity>[0], "project"> & {
  project: WorkerLocalProjectSnapshot;
} = {
  namespace: "gateway-one",
  providerId: "fake",
  profileId: "development",
  profileSnapshot: {
    install: "bundle",
    settings: { region: "test", disk: 20 },
    executionMode: "worker-turn",
  },
  project: { key: "a".repeat(64), root: "/source/first-worktree", baseCommit: "b".repeat(40) },
  target: { machineClass: "small", platform: "linux", arch: "x64" },
  artifacts: {
    nodeBootstrapSha256: "c".repeat(64),
    enabledPluginIds: ["second", "first"],
    workerBundleHash: "d".repeat(64),
    workerArchiveSha256: "e".repeat(64),
    openclawVersion: "2026.8.1",
    protocolFeatures: ["worker-inference-v1"],
  },
  setupRecipe: "f".repeat(40),
};

describe("worker preparation identity", () => {
  it("keeps empty runtime preparation separate from project content", () => {
    const { project: _project, setupRecipe: _setupRecipe, ...runtime } = input;
    const preparation = createWorkerPreparationIdentity(runtime);
    expect(preparation.key).not.toBe(createWorkerPreparationIdentity(input).key);
    expect(preparation).not.toHaveProperty("setupRecipe");
    expect(
      readWorkerPreparation({
        ...runtime.profileSnapshot,
        runtimePreparation: { source: "empty", ...preparation },
      }),
    ).toEqual({ source: "empty", ...preparation });
    expect(() =>
      readWorkerPreparation({
        project: input.project,
        runtimePreparation: { source: "empty", ...preparation },
      }),
    ).toThrow("runtime preparation identity is invalid");
  });

  it("shares identity across linked source paths, JSON field order and plugin order", () => {
    const equivalent = structuredClone(input);
    equivalent.project.root = "/source/second-worktree";
    equivalent.profileSnapshot = {
      executionMode: "worker-turn",
      settings: { disk: 20, region: "test" },
      install: "bundle",
      machineClass: "small",
    };
    equivalent.artifacts.enabledPluginIds.reverse();
    expect(createWorkerPreparationIdentity(equivalent)).toEqual(
      createWorkerPreparationIdentity(input),
    );
  });

  it("separates skipped setup caches while preserving the default identity", () => {
    const original = createWorkerPreparationIdentity(input);
    const enabled = createWorkerPreparationIdentity({ ...input, runSetupScript: true });
    expect(enabled).toEqual(original);
    expect(enabled).not.toHaveProperty("runSetupScript");
    const skipped = createWorkerPreparationIdentity({ ...input, runSetupScript: false });
    expect(skipped.setupRecipe).toBe(original.setupRecipe);
    expect(skipped.runSetupScript).toBe(false);
    expect(skipped.key).not.toBe(original.key);
    expect(skipped.cacheKey).not.toBe(original.cacheKey);
    expect(readWorkerProjectPreparation({ preparation: skipped })).toEqual(skipped);
  });

  it.each<[string, Partial<typeof input>]>([
    ["namespace", { namespace: "gateway-two" }],
    ["provider", { providerId: "another-provider" }],
    ["profile id", { profileId: "another-profile" }],
    ["commit", { project: { ...input.project, baseCommit: "1".repeat(40) } }],
    ["recipe", { setupRecipe: "2".repeat(40) }],
    [
      "profile",
      { profileSnapshot: { ...input.profileSnapshot, settings: { region: "elsewhere" } } },
    ],
    ["target", { target: { ...input.target, arch: "arm64" } }],
    ["OS", { target: { ...input.target, platform: "darwin" } }],
    ["mode", { profileSnapshot: { ...input.profileSnapshot, executionMode: "remote-exec" } }],
    ["runtime", { artifacts: { ...input.artifacts, nodeBootstrapSha256: "3".repeat(64) } }],
    [
      "plugins",
      {
        artifacts: {
          ...input.artifacts,
          enabledPluginIds: [...input.artifacts.enabledPluginIds, "third"],
        },
      },
    ],
    ["bundle", { artifacts: { ...input.artifacts, workerBundleHash: "4".repeat(64) } }],
    [
      "protocol",
      {
        artifacts: {
          ...input.artifacts,
          protocolFeatures: [...input.artifacts.protocolFeatures, "worker-computer-v1"],
        },
      },
    ],
  ])("invalidates a changed %s before allocation", (label, change) => {
    const original = createWorkerPreparationIdentity(input);
    const next = createWorkerPreparationIdentity({ ...input, ...change });
    expect(next.key).not.toBe(original.key);
    expect(next.cacheKey).toMatch(/^[a-f0-9]{64}$/u);
    if (label === "commit") {
      expect(next.cacheKey).toBe(original.cacheKey);
    } else {
      expect(next.cacheKey).not.toBe(original.cacheKey);
      const { project: _project, setupRecipe: _setupRecipe, ...runtime } = input;
      const { project: _changedProject, setupRecipe: _changedRecipe, ...runtimeChange } = change;
      if (label !== "recipe") {
        expect(createWorkerPreparationIdentity({ ...runtime, ...runtimeChange }).key).not.toBe(
          createWorkerPreparationIdentity(runtime).key,
        );
      }
    }
  });
});
