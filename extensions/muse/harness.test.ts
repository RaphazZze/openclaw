import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentHarnessAttemptParamsV2,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import type * as ProviderAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import type * as TranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMuseAgentHarness, type MuseSessionBinding } from "./harness.js";
import { selectApprovalChoice, type MuseApprovalRequest } from "./src/approvals.js";
import { MusePool, museEnvironment } from "./src/runtime.js";

const writes = vi.hoisted(() => ({
  append: vi.fn(async (params: { messages: unknown[] }) => params.messages),
  publish: vi.fn(async () => undefined),
}));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof TranscriptRuntime>()),
  appendSessionTranscriptMessagesByIdentity: writes.append,
  publishSessionTranscriptUpdateByIdentity: writes.publish,
}));
const auth = vi.hoisted(() => ({ resolve: vi.fn(async () => ({ apiKey: "profile-key" })) }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderAuthRuntime>()),
  resolveApiKeyForProvider: auth.resolve,
}));

let workspace: string;
const fixture = fileURLToPath(new URL("./src/test-support/fake-muse.mjs", import.meta.url));
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "muse-harness-test-"));
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function setup() {
  const bindings = new Map<string, MuseSessionBinding>();
  const sessionStore = {
    lookup: async (key: string) => bindings.get(key),
    register: async (key: string, value: MuseSessionBinding) => {
      bindings.set(key, value);
    },
    delete: async (key: string) => {
      return bindings.delete(key);
    },
  };
  const harness = createMuseAgentHarness({ binaryPath: fixture, sessionStore });
  const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const authStorage = AuthStorage.inMemory();
  const params: AgentHarnessAttemptParamsV2 = {
    runId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    sessionKey: "agent:main:muse-test",
    workspaceDir: workspace,
    agentDir: workspace,
    provider: "meta",
    modelId: "muse-spark-1.3",
    model: {
      id: "muse-spark-1.3",
      name: "Muse Spark",
      provider: "meta",
      api: "openai-responses",
      baseUrl: "https://api.meta.ai/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    },
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    thinkLevel: "off",
    sessionFile: join(workspace, "session.jsonl"),
    timeoutMs: 10_000,
    prompt: "hello",
    sessionTarget: {
      sessionId: "transcript-id",
      sessionKey: "agent:main:muse-test",
      storePath: join(workspace, "sessions.json"),
    },
    authProfileStore: { version: 1, profiles: {} },
    onAgentEvent: async (event: { stream: string; data: Record<string, unknown> }) => {
      events.push(event);
    },
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: () => undefined,
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
      requestApproval: vi.fn(async () => ({ decision: "allow-once" as const })),
      waitForApproval: vi.fn(async () => undefined),
    },
  };
  return { harness, params, events, sessionStore, bindings };
}

function terminal(result: AgentHarnessAttemptResult) {
  if (!("terminal" in result)) {
    throw new Error("Muse must return a canonical attempt terminal.");
  }
  return result.terminal;
}

describe("Muse native MSP harness", () => {
  it.each([
    ["catalog default endpoint", { endpointOverrides: "none" }, true],
    [
      "official endpoint reported as authored",
      { endpointOverrides: "present", baseUrl: "https://api.meta.ai/v1/" },
      true,
    ],
    [
      "custom endpoint",
      { endpointOverrides: "present", baseUrl: "https://proxy.example/v1" },
      false,
    ],
    ["request transport overrides", { requestTransportOverrides: "present" }, false],
  ] as const)("routes meta models with %s", (_name, modelProvider, supported) => {
    const { harness } = setup();
    expect(
      harness.supports({
        provider: "meta",
        modelId: "muse-spark-1.3",
        requestedRuntime: "muse",
        modelProvider,
      }).supported,
    ).toBe(supported);
  });

  it("streams reasoning and text, journals native tool pairs, and resumes after restart", async () => {
    const first = setup();
    try {
      const result = await first.harness.runAttempt({ ...first.params, prompt: "tool" });
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["started: hello"]);
      expect(
        first.events
          .filter((event) => event.stream === "assistant")
          .map((event) => event.data.delta)
          .join(""),
      ).toBe("started: hello");
      expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
        "assistant",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      expect(result.toolMetas).toEqual([{ toolName: "read_file" }]);
      expect(writes.append).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({ role: "toolResult", toolCallId: "call-1" }),
            }),
          ]),
        }),
      );
    } finally {
      await first.harness.dispose?.();
    }
    const resumed = createMuseAgentHarness({
      binaryPath: fixture,
      sessionStore: first.sessionStore,
    });
    try {
      const result = await resumed.runAttempt(first.params);
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["resumed: hello"]);
      const changed = await resumed.runAttempt({ ...first.params, modelId: "muse-other" });
      expect(changed.assistantTexts).toEqual(["started: hello"]);
    } finally {
      await resumed.dispose?.();
    }
  });

  it.each([
    ["global mode", { config: { tools: { exec: { mode: "deny" } } } }],
    ["override mode", { execOverrides: { mode: "deny" } }],
    [
      "agent policy",
      {
        config: {
          tools: { exec: { mode: "full" } },
          agents: { entries: { main: { tools: { exec: { mode: "deny" } } } } },
        },
      },
    ],
  ] satisfies Array<[string, Partial<AgentHarnessAttemptParamsV2>]>)(
    "launches a read-only host for %s",
    async (_name, policy) => {
      const { harness, params } = setup();
      const log = join(workspace, `${params.runId}.jsonl`);
      vi.stubEnv("MUSE_REQUEST_LOG", log);
      try {
        await harness.runAttempt({ ...params, ...policy });
        const requests = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests).toContainEqual(
          expect.objectContaining({
            event: "spawn",
            args: ["serve", "--disable-shell", "--disable-write"],
          }),
        );
        expect(requests).toContainEqual(
          expect.objectContaining({
            method: "session/start",
            params: expect.objectContaining({ approvalMode: "denyUnmatched" }),
          }),
        );
      } finally {
        await harness.dispose?.();
        vi.unstubAllEnvs();
      }
    },
  );

  it("forwards prepared images to the native turn", async () => {
    const { harness, params } = setup();
    const log = join(workspace, `${params.runId}.jsonl`);
    vi.stubEnv("MUSE_REQUEST_LOG", log);
    try {
      await harness.runAttempt({
        ...params,
        images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      });
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: "turn/start",
          params: expect.objectContaining({
            input: [
              { type: "text", text: "hello" },
              { type: "image", mediaType: "image/png", base64Data: "aW1hZ2U=" },
            ],
          }),
        }),
      );
    } finally {
      await harness.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it("returns the terminal observer's unresolved native tool error", async () => {
    const { harness, params } = setup();
    const lastToolError = { toolName: "read_file", error: "file unavailable" };
    const observeToolTerminal = vi.fn<
      NonNullable<AgentHarnessAttemptParamsV2["observeToolTerminal"]>
    >(() => ({
      lastToolError,
      executionStarted: true,
      sideEffectEvidence: false,
      effectReceipt: { state: "failed_no_effect" },
    }));
    try {
      const result = await harness.runAttempt({
        ...params,
        prompt: "tool-failure",
        observeToolTerminal,
      });
      expect(observeToolTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failure" }),
      );
      expect(terminal(result).kind).toBe("ok");
      expect(result.lastToolError).toEqual(lastToolError);
    } finally {
      await harness.dispose?.();
    }
  });

  it.each(["callback", "transcript", "abort", "timeout", "approval"] as const)(
    "waits for native settlement after %s interruption",
    async (failure) => {
      const { harness, params } = setup();
      const log = join(workspace, `${params.runId}.jsonl`);
      vi.stubEnv("MUSE_REQUEST_LOG", log);
      const controller = new AbortController();
      if (failure === "transcript") {
        writes.append.mockRejectedValueOnce(new Error("transcript unavailable"));
      }
      if (failure === "approval") {
        params.hostCapabilities = {
          ...params.hostCapabilities,
          requestApproval: async () => {
            throw new Error("approval gateway unavailable");
          },
        };
      }
      try {
        const result = await harness.runAttempt({
          ...params,
          prompt: failure === "approval" ? "approval-settle" : "settle",
          timeoutMs: failure === "timeout" ? 150 : params.timeoutMs,
          abortSignal: controller.signal,
          onExecutionStarted: () => {
            if (failure === "callback") {
              throw new Error("callback failed");
            }
            if (failure === "abort") {
              controller.abort();
            }
          },
        });
        expect(terminal(result).kind).toBe(
          failure === "abort" ? "aborted" : failure === "timeout" ? "timeout" : "failed",
        );
        expect(await readFile(log, "utf8")).toContain('"event":"terminal","terminal":"cancelled"');
      } finally {
        await harness.dispose?.();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([true, false])(
    "invalidates context only after a committed history mutation (%s)",
    async (commit) => {
      const { harness, params, bindings, sessionStore } = setup();
      try {
        await harness.runAttempt(params);
        const reset = harness.withSessionContextReset!;
        const operation = reset(
          {
            agentId: "main",
            sessionId: params.sessionId,
            sessionKey: params.sessionKey!,
            assertCurrent: () => undefined,
          },
          async (mutation) => {
            if (!commit) {
              throw new Error("history mutation failed");
            }
            mutation.commit();
            return "committed";
          },
        );
        if (commit) {
          await expect(operation).resolves.toBe("committed");
          expect(bindings.has(params.sessionId)).toBe(false);
        } else {
          await expect(operation).rejects.toThrow("history mutation failed");
          expect(bindings.has(params.sessionId)).toBe(true);
        }
        await harness.dispose?.();
        const restarted = createMuseAgentHarness({ binaryPath: fixture, sessionStore });
        try {
          const next = await restarted.runAttempt(params);
          expect(next.assistantTexts).toEqual([commit ? "started: hello" : "resumed: hello"]);
        } finally {
          await restarted.dispose?.();
        }
      } finally {
        await harness.dispose?.();
      }
    },
  );

  it.each([
    ["off", "minimal"],
    ["low", "low"],
    ["high", "high"],
  ] as const)("sends the Meta-compatible reasoning effort for %s", async (thinkLevel, expected) => {
    const { harness, params } = setup();
    try {
      const result = await harness.runAttempt({ ...params, prompt: "effort", thinkLevel });
      expect(result.assistantTexts).toEqual([`effort:${expected}`]);
    } finally {
      await harness.dispose?.();
    }
  });

  it("does not retire a shared host when another attempt aborts before turn dispatch", async () => {
    const state = setup();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const secondId = crypto.randomUUID();
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const register = state.sessionStore.register;
    state.sessionStore.register = async (key, value) => {
      await register(key, value);
      if (key === secondId) {
        secondController.abort();
      }
    };
    const first = state.harness.runAttempt({
      ...state.params,
      prompt: "wait",
      abortSignal: firstController.signal,
      onExecutionStarted: started,
    });
    try {
      await firstStarted;
      const second = await state.harness.runAttempt({
        ...state.params,
        sessionId: secondId,
        sessionKey: "agent:main:second-muse",
        abortSignal: secondController.signal,
      });
      expect(terminal(second).kind).toBe("aborted");
      firstController.abort();
      const result = await first;
      expect(terminal(result)).toMatchObject({ kind: "aborted" });
      expect(terminal(result)).not.toHaveProperty("failure");
    } finally {
      firstController.abort();
      await first;
      await state.harness.dispose?.();
    }
  });

  it("routes approvals through the host and submits the offered server choice", async () => {
    const { harness, params } = setup();
    try {
      const result = await harness.runAttempt({ ...params, prompt: "approval" });
      expect(params.hostCapabilities.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "shell", allowedDecisions: ["allow-once", "deny"] }),
      );
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["started: hello"]);
    } finally {
      await harness.dispose?.();
    }
  });

  it("interrupts the real MSP transport when the caller aborts", async () => {
    const { harness, params } = setup();
    const controller = new AbortController();
    const onExecutionStarted = vi.fn(() => controller.abort());
    try {
      const result = await harness.runAttempt({
        ...params,
        prompt: "wait",
        abortSignal: controller.signal,
        onExecutionStarted,
      });
      expect(terminal(result).kind).toBe("aborted");
    } finally {
      await harness.dispose?.();
    }
  });

  it.each([
    ["fail", "fixture provider rejected authentication"],
    ["crash", "fixture: provider process crashed"],
  ])("surfaces %s failures without hanging", async (prompt, expected) => {
    const { harness, params } = setup();
    try {
      const result = await harness.runAttempt({ ...params, prompt });
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: expect.stringContaining(expected) }),
      });
      expect(result.replayMetadata?.replaySafe).toBe(false);
    } finally {
      await harness.dispose?.();
    }
  });

  it.each([
    ["missing", "missing-session"],
    ["refused", "refused-session"],
  ])(
    "starts a new native session when Muse definitively refuses a %s resume",
    async (_name, id) => {
      const state = setup();
      try {
        await state.harness.runAttempt(state.params);
      } finally {
        await state.harness.dispose?.();
      }
      const binding = state.bindings.get(state.params.sessionId)!;
      state.bindings.set(state.params.sessionId, { ...binding, sessionId: id });
      const warn = vi.fn();
      const next = createMuseAgentHarness({
        binaryPath: fixture,
        sessionStore: state.sessionStore,
        logger: { warn },
      });
      try {
        const result = await next.runAttempt(state.params);
        expect(terminal(result).kind).toBe("ok");
        expect(result.assistantTexts).toEqual(["started: hello"]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("started a new Muse session"));
      } finally {
        await next.dispose?.();
      }
    },
  );

  it("does not replace a session that is in use elsewhere", async () => {
    const state = setup();
    try {
      await state.harness.runAttempt(state.params);
    } finally {
      await state.harness.dispose?.();
    }
    const binding = state.bindings.get(state.params.sessionId)!;
    state.bindings.set(state.params.sessionId, { ...binding, sessionId: "busy-session" });
    const next = createMuseAgentHarness({ binaryPath: fixture, sessionStore: state.sessionStore });
    try {
      const result = await next.runAttempt(state.params);
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: expect.stringContaining("sessionInUse") }),
      });
      expect(state.bindings.get(state.params.sessionId)?.sessionId).toBe("busy-session");
    } finally {
      await next.dispose?.();
    }
  });

  it("denies native approval when the host denies it", async () => {
    const { harness, params } = setup();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      requestApproval: async () => ({ decision: "deny" }),
    };
    try {
      const result = await harness.runAttempt({ ...params, prompt: "approval" });
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: expect.stringContaining("denied") }),
      });
      expect(result.assistantTexts).toEqual([]);
    } finally {
      await harness.dispose?.();
    }
  });

  it("reports an approval transport failure as the turn error, not an abort", async () => {
    const { harness, params } = setup();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      requestApproval: async () => {
        throw new Error("approval gateway unavailable");
      },
    };
    try {
      const result = await harness.runAttempt({ ...params, prompt: "approval" });
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({
          message: expect.stringContaining("approval gateway unavailable"),
        }),
      });
    } finally {
      await harness.dispose?.();
    }
  });

  it("explains a missing Muse sign-in and logs it for operators", async () => {
    const { params, sessionStore } = setup();
    const warn = vi.fn();
    const harness = createMuseAgentHarness({ binaryPath: fixture, sessionStore, logger: { warn } });
    try {
      const result = await harness.runAttempt({ ...params, prompt: "loggedout" });
      expect(terminal(result)).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: expect.stringContaining("muse login") }),
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Muse Code is not signed in on the Gateway host"),
      );
    } finally {
      await harness.dispose?.();
    }
  });

  it("treats an unlimited Gateway budget as no deadline and bounds the approval wait", async () => {
    const { harness, params } = setup();
    try {
      const result = await harness.runAttempt({
        ...params,
        prompt: "approval",
        timeoutMs: 2 ** 31,
      });
      expect(terminal(result)).toMatchObject({ kind: "ok" });
      expect(params.hostCapabilities.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 120_000 }),
      );
    } finally {
      await harness.dispose?.();
    }
  });

  it("keeps prepared credentials ahead of profile resolution and CLI login", async () => {
    const { harness, params } = setup();
    try {
      const prepared = await harness.runAttempt({
        ...params,
        prompt: "credential",
        resolvedApiKey: "prepared-key",
        authProfileId: "meta:test",
      });
      expect(prepared.assistantTexts).toEqual(["credential:prepared-key"]);
      const profile = await harness.runAttempt({
        ...params,
        prompt: "credential",
        authProfileId: "meta:test",
      });
      expect(profile.assistantTexts).toEqual(["credential:profile-key"]);
      const login = await harness.runAttempt({ ...params, prompt: "credential" });
      expect(login.assistantTexts).toEqual(["credential:cli-login"]);
    } finally {
      await harness.dispose?.();
    }
  });

  it("rejects sandbox and restricted-tool attempts before starting native work", async () => {
    const { harness, params, bindings } = setup();
    try {
      await expect(
        harness.runAttempt({ ...params, pluginHarnessToolPolicyRestricted: true }),
      ).rejects.toThrow("cannot enforce");
      await expect(harness.runAttempt({ ...params, requireWorkspaceOnly: true })).rejects.toThrow(
        "cannot enforce",
      );
      await expect(
        harness.runAttempt({ ...params, execOverrides: { ask: "always" } }),
      ).rejects.toThrow("exec ask: always");
      await expect(harness.runAttempt({ ...params, thinkLevel: "adaptive" })).rejects.toThrow(
        "does not support adaptive reasoning",
      );
      expect(bindings.size).toBe(0);
    } finally {
      await harness.dispose?.();
    }
  });

  it("isolates pooled credentials, reuses matching hosts, and closes idle hosts", async () => {
    const pool = new MusePool(fixture);
    try {
      const first = await pool.acquire(workspace, "key-a", false);
      const same = await pool.acquire(workspace, "key-a", false);
      const other = await pool.acquire(workspace, "key-b", false);
      expect(same.runtime).toBe(first.runtime);
      expect(other.runtime).not.toBe(first.runtime);
      vi.useFakeTimers();
      first.release();
      same.release();
      other.release();
      await vi.advanceTimersByTimeAsync(300_000);
      vi.useRealTimers();
      await first.runtime.host.exited;
      expect(first.runtime.closing).toBe(true);
      await other.runtime.host.exited;
    } finally {
      vi.useRealTimers();
      await pool.dispose();
    }
  });

  it("prefers the OpenClaw-selected key and otherwise keeps Muse's own credential order", () => {
    vi.stubEnv("META_API_KEY", "ambient-meta");
    try {
      expect(museEnvironment().META_API_KEY).toBe("ambient-meta");
      expect(museEnvironment("selected").META_API_KEY).toBe("selected");
      expect(museEnvironment().MUSE_NO_AUTO_UPDATE).toBe("1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed rather than minting approval choices", () => {
    const request = {
      availableChoices: [{ choiceId: "server-only", decision: "denied", scope: "once" }],
    } as MuseApprovalRequest;
    expect(selectApprovalChoice(request, undefined)).toEqual({ choiceId: "server-only" });
    expect(() => selectApprovalChoice(request, "allow-once")).toThrow(
      "no safe approved approval choice",
    );
  });
});
