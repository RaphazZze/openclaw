import { definePluginEntry, type PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { createAdvisorController, type AdvisorSchedule } from "./src/controller.js";
import {
  DELIVERY_PREFIX,
  parseReviewOutput,
  REVIEW_MESSAGE,
  REVIEW_TIMEOUT_MS,
} from "./src/review.js";

const DEFAULT_SCHEDULE: AdvisorSchedule = { everyToolCalls: 10, everyMinutes: 20 };
const ADVICE_TTL_MS = 24 * 60 * 60 * 1000;

function resolveSchedule(config: Record<string, unknown> | undefined): AdvisorSchedule {
  const read = (key: keyof AdvisorSchedule) => {
    const value = config?.[key];
    return typeof value === "number" ? value : DEFAULT_SCHEDULE[key];
  };
  return { everyToolCalls: read("everyToolCalls"), everyMinutes: read("everyMinutes") };
}

export default definePluginEntry({
  id: "advisor",
  name: "Advisor",
  description:
    "Experimental: reviews ongoing agent work on the session's own model and offers one short correction.",
  register(api) {
    const schedule = resolveSchedule(api.pluginConfig);
    if (schedule.everyToolCalls === 0 && schedule.everyMinutes === 0) {
      api.logger.warn(
        "advisor: both everyToolCalls and everyMinutes are 0, so no reviews will run. Set either to a positive value.",
      );
      return;
    }
    // Background reviews belong to the plugin service, not the triggering tool or turn.
    let scheduler: PluginServiceSchedulerV1 | undefined;
    const controller = createAdvisorController({
      schedule,
      logger: api.logger,
      runInBackground: (sessionKey, run) => {
        if (!scheduler || scheduler.signal.aborted) {
          return false;
        }
        scheduler.schedule({ id: `review:${sessionKey}`, delayMs: 0, run });
        return true;
      },
      review: async ({ sessionKey, signal }) => {
        const result = await api.runtime.subagent.forkSession({
          sessionKey,
          message: REVIEW_MESSAGE,
          timeoutMs: REVIEW_TIMEOUT_MS,
          signal: scheduler ? AbortSignal.any([signal, scheduler.signal]) : signal,
        });
        api.logger.info(
          `advisor: review usage for session ${sessionKey}: input=${result.usage?.inputTokens ?? "unknown"} cacheRead=${result.usage?.cacheReadTokens ?? "unknown"} cacheWrite=${result.usage?.cacheWriteTokens ?? "unknown"} output=${result.usage?.outputTokens ?? "unknown"}`,
        );
        return parseReviewOutput(result.text);
      },
      deliver: async ({ agentId, sessionKey, finding, reviewId, signal }) => {
        const text = `${DELIVERY_PREFIX}\n\n${finding}`;
        const idempotencyKey = `advisor:${reviewId}`;
        const result = await api.session.workflow.steerActiveRun({
          sessionKey,
          text,
          idempotencyKey,
        });
        if (result.steered) {
          api.logger.info(`advisor: steered active run for session ${sessionKey}`);
          return;
        }
        if (signal.aborted || !scheduler || scheduler.signal.aborted) {
          return;
        }
        const fallback = await api.session.workflow.enqueueNextTurnInjection({
          sessionKey,
          agentId,
          text,
          idempotencyKey,
          ttlMs: ADVICE_TTL_MS,
        });
        api.logger.info(
          `advisor: ${fallback.enqueued ? "queued correction for next turn" : "next-turn correction rejected"} for session ${sessionKey} (steering unavailable: ${result.reason})`,
        );
      },
    });

    api.registerService({
      apiVersion: 2,
      id: "advisor",
      start: (ctx) => {
        scheduler = ctx.scheduler;
      },
      stop: () => {
        scheduler = undefined;
        controller.forget();
      },
    });

    api.on("llm_input", (_event, ctx) => {
      if (
        ctx.sessionKey &&
        ctx.agentId &&
        ctx.runId &&
        (ctx.trigger === undefined || ctx.trigger === "user" || ctx.trigger === "manual")
      ) {
        controller.runStarted({
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          runId: ctx.runId,
        });
      }
    });
    // Tool starts, not after_tool_call: Codex fires post-tool hooks only for calls that finish
    // inside the turn, so stalled or backgrounded commands (the waste worth catching) never count.
    api.agent.events.registerAgentEventSubscription({
      id: "advisor-tool-starts",
      description: "Counts tool calls started in admitted runs for the review trigger.",
      streams: ["tool"],
      handle: (event) => {
        if (event.sessionKey && event.runId && event.data.phase === "start") {
          controller.toolStarted({ sessionKey: event.sessionKey, runId: event.runId });
        }
      },
    });
    api.on("agent_end", (event, ctx) => {
      if (
        !ctx.sessionKey ||
        !ctx.agentId ||
        (ctx.trigger !== undefined && ctx.trigger !== "user" && ctx.trigger !== "manual")
      ) {
        return;
      }
      controller.turnEnded({
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        runId: ctx.runId,
        durationMs: event.durationMs,
      });
    });
    api.registerRuntimeLifecycle({
      id: "advisor",
      description: "Cancels in-flight advisor reviews when sessions or the plugin go away.",
      cleanup: ({ sessionKey }) => controller.forget(sessionKey),
      dispose: () => controller.forget(),
    });
  },
});
