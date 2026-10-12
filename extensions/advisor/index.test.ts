import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  OpenClawPluginServiceV2,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

/** Waits for observable scheduler work rather than sleeping or polling. */
function createSignal<T>() {
  let waiters: ((value: T) => void)[] = [];
  return {
    next: () => {
      const { promise, resolve } = Promise.withResolvers<T>();
      waiters.push(resolve);
      return promise;
    },
    notify: (value: T) => {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) {
        resolve(value);
      }
    },
  };
}

type PendingReview = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  result: Promise<{ text: string }>;
};

// The plugin registers these through the typed `api.on`; tests only replay them.
type CapturedHook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function setup(pluginConfig: Record<string, unknown>) {
  const handlers: Partial<Record<"llm_input" | "agent_end", CapturedHook>> = {};
  let toolEvents: Parameters<OpenClawPluginApi["registerAgentEventSubscription"]>[0] | undefined;
  const services: OpenClawPluginServiceV2[] = [];
  const lifecycles: Parameters<OpenClawPluginApi["registerRuntimeLifecycle"]>[0][] = [];
  const started = createSignal<PendingReview>();
  const finished = createSignal<void>();
  const forkSession = vi.fn<OpenClawPluginApi["runtime"]["subagent"]["forkSession"]>((params) => {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    const review = {
      resolve,
      reject,
      signal: params.signal,
      result: promise.then((text) => ({
        text,
        usage: { inputTokens: 100, cacheReadTokens: 80, outputTokens: 10 },
      })),
    };
    started.notify(review);
    return review.result;
  });
  const enqueue = vi.fn<OpenClawPluginApi["enqueueNextTurnInjection"]>(async (injection) => ({
    enqueued: true,
    id: "queued",
    sessionKey: injection.sessionKey,
  }));
  const steer = vi.fn<OpenClawPluginApi["session"]["workflow"]["steerActiveRun"]>(async () => ({
    steered: true,
    runId: "run-1",
  }));
  const info = vi.fn((message: string) => {
    if (!message.includes("review usage")) {
      finished.notify();
    }
  });
  const warn = vi.fn(() => finished.notify());
  const api = createTestPluginApi({
    id: "advisor",
    pluginConfig,
    logger: { info, warn, error: vi.fn(), debug: vi.fn() },
    runtime: createPluginRuntimeMock({ subagent: { forkSession } }),
    enqueueNextTurnInjection: enqueue,
    steerActiveRun: steer,
    registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    registerService: (service) => {
      if (service.apiVersion === 2) {
        services.push(service);
      }
    },
    on: (name, handler) => {
      Object.assign(handlers, { [name]: handler });
    },
    registerAgentEventSubscription: (subscription) => {
      toolEvents = subscription;
    },
  });
  plugin.register(api);

  const clock = createGatewaySchedulerClock();
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const serviceContext: OpenClawPluginServiceContextV2 = {
    config: {},
    stateDir: "/tmp/advisor-test",
    logger: api.logger,
    scheduler,
  };
  const context = {
    sessionKey: "agent:main:main",
    agentId: "main",
    runId: "run-1",
    trigger: "user",
  };
  return {
    forkSession,
    enqueue,
    steer,
    info,
    warn,
    handlers,
    services,
    lifecycles,
    finished: finished.next,
    startService: () => services[0]!.start(serviceContext),
    stopService: () => services[0]!.stop?.(serviceContext),
    startRun: (overrides: Partial<typeof context> = {}) =>
      handlers.llm_input?.(
        {
          runId: overrides.runId ?? context.runId,
          sessionId: "session-1",
          provider: "openai",
          model: "example",
          prompt: "Fix the README typo",
          historyMessages: [],
          imagesCount: 0,
        },
        { ...context, ...overrides },
      ),
    toolStarted: (overrides: Partial<typeof context> = {}) =>
      toolEvents?.handle(
        {
          runId: overrides.runId ?? context.runId,
          sessionKey: overrides.sessionKey ?? context.sessionKey,
          seq: 1,
          ts: Date.now(),
          stream: "tool",
          data: { phase: "start", name: "exec" },
        },
        { getRunContext: () => undefined, setRunContext: () => {}, clearRunContext: () => {} },
      ),
    endRun: (durationMs = 1_000, overrides: Partial<typeof context> = {}) =>
      handlers.agent_end?.(
        { messages: [], success: true, durationMs },
        { ...context, ...overrides },
      ),
    dispatchReview: () => {
      const review = started.next();
      void clock.wake();
      return review;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("advisor", () => {
  it.each([true, false])(
    "reviews tool calls mid-run and delivers with active steering=%s",
    async (active) => {
      const run = setup({ everyToolCalls: 2, everyMinutes: 0 });
      if (!active) {
        run.steer.mockResolvedValue({ steered: false, reason: "not streaming" });
      }
      await run.startService();
      await run.startRun();
      await run.toolStarted();
      expect(run.forkSession).not.toHaveBeenCalled();
      await run.toolStarted();
      // Hooks only schedule; the service owns model work outside the tool's lifetime.
      expect(run.forkSession).not.toHaveBeenCalled();
      const review = await run.dispatchReview();
      expect(run.forkSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          message: expect.stringContaining("Reply with exactly NO_CHANGE"),
        }),
      );
      expect(run.forkSession.mock.calls[0]?.[0]).not.toHaveProperty("model");
      // A third completed tool does not start a second concurrent review.
      await run.toolStarted();
      expect(run.forkSession).toHaveBeenCalledOnce();
      const done = run.finished();
      review.resolve("Stop editing CI; the user asked only for the README typo.");
      await done;
      expect(run.steer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          text: expect.stringContaining("Stop editing CI"),
        }),
      );
      if (active) {
        expect(run.enqueue).not.toHaveBeenCalled();
      } else {
        expect(run.enqueue).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            sessionKey: "agent:main:main",
            agentId: "main",
            ttlMs: 24 * 60 * 60 * 1000,
            idempotencyKey: run.steer.mock.calls[0]?.[0].idempotencyKey,
            text: run.steer.mock.calls[0]?.[0].text,
          }),
        );
      }
      await run.stopService();
    },
  );

  it("accumulates elapsed run time without counting it twice and does nothing on NO_CHANGE", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const run = setup({ everyToolCalls: 0, everyMinutes: 1 });
    await run.startService();
    await run.startRun();
    now = 30_000;
    await run.toolStarted();
    await run.endRun(40_000);
    expect(run.forkSession).not.toHaveBeenCalled();
    now = 50_000;
    await run.startRun({ runId: "run-2" });
    now = 69_000;
    await run.toolStarted({ runId: "run-2" });
    expect(run.forkSession).not.toHaveBeenCalled();
    await run.endRun(20_000, { runId: "run-2" });
    const review = await run.dispatchReview();
    const done = run.finished();
    review.resolve("NO_CHANGE");
    await done;
    expect(run.steer).not.toHaveBeenCalled();
    expect(run.enqueue).not.toHaveBeenCalled();
    await run.stopService();
  });

  it("ignores non-user runs and cancels on reset, disable, and service stop", async () => {
    const run = setup({ everyToolCalls: 1, everyMinutes: 0 });
    await run.startService();
    for (const trigger of ["heartbeat", "cron", "memory", "overflow", "side_question", "btw"]) {
      await run.startRun({ trigger });
      await run.toolStarted();
      await run.endRun(120_000, { trigger });
    }
    expect(run.forkSession).not.toHaveBeenCalled();
    for (const cancel of [
      () => run.lifecycles[0]!.cleanup?.({ reason: "reset", sessionKey: "agent:main:main" }),
      () => run.lifecycles[0]!.dispose?.(),
      () => run.stopService(),
    ]) {
      await run.startRun();
      await run.toolStarted();
      const review = await run.dispatchReview();
      await cancel();
      expect(review.signal?.aborted).toBe(true);
      await expect(review.result).rejects.toThrow("aborted");
    }
    expect(run.steer).not.toHaveBeenCalled();
    expect(run.enqueue).not.toHaveBeenCalled();
    expect(run.warn).not.toHaveBeenCalled();
  });

  it("registers nothing when both triggers are off", () => {
    const run = setup({ everyToolCalls: 0, everyMinutes: 0 });
    expect(run.handlers).toEqual({});
    expect(run.services).toHaveLength(0);
    expect(run.warn).toHaveBeenCalledOnce();
  });
});
