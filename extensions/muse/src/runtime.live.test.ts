import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { MusePool, openMuseSession } from "./runtime.js";

const describeHost = isLiveTestEnabled(["OPENCLAW_MUSE_LIVE_HOST"]) ? describe : describe.skip;

describeHost("real Muse MSP host", () => {
  it("negotiates, starts, resumes, reports invalid-key auth, interrupts and disposes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openclaw-muse-live-"));
    const pool = new MusePool(process.env.OPENCLAW_MUSE_BIN ?? "muse");
    const lease = await pool.acquire(workspace, "dummy-not-a-secret", true);
    const { runtime } = lease;
    try {
      expect(runtime.host.initializeResult.serverInfo.name).toBe("muse");
      expect(runtime.host.initializeResult.schema.fingerprint).toMatch(/^sha256:/);
      if (runtime.host.fingerprintWarning) {
        expect(runtime.host.fingerprintWarning.kind).toBe("schemaFingerprintMismatch");
      }
      expect(runtime.host.initializeResult.grantedCapabilities).toEqual(expect.any(Array));
      const session = await openMuseSession(runtime, {
        workspace,
        modelId: "muse-spark-1.3",
        approvalMode: "denyUnmatched",
        mcpServers: {},
      });
      const resumed = await runtime.host.connection.command("session/resume", {
        sessionId: session.sessionId,
        excludeItems: true,
      });
      expect(resumed.session).toMatchObject({ sessionId: session.sessionId });
      const turn = await session.sendUserTurn({
        input: [{ type: "text", text: "Reply with MSP-OK. Do not use tools." }],
      });
      const outcome = await turn.completed;
      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed") {
        throw new Error("Muse did not deliver its terminal auth failure");
      }
      expect(outcome.params.terminal).toBe("failed");
      expect(outcome.params.error?.message).toMatch(/not logged in|auth|login|API key/i);
      expect(runtime.host.child.stderrTail.join("\n")).toMatch(
        /API key|authentication|logged.out/i,
      );
      const interrupted = await session.sendUserTurn({
        input: [{ type: "text", text: "Wait for interruption." }],
      });
      await runtime.host.connection.command("turn/interrupt", {
        sessionId: session.sessionId,
        turnId: interrupted.turnId,
      });
      const terminal = await interrupted.completed;
      expect(terminal.kind).toBe("completed");
    } finally {
      lease.release();
      await pool.dispose();
      await runtime.host.exited;
      expect(runtime.dead).toBe(true);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

const describeModel = isLiveTestEnabled(["OPENCLAW_MUSE_LIVE_TEST"]) ? describe : describe.skip;
describeModel("real Muse model", () => {
  it("completes a short streaming model turn", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openclaw-muse-model-"));
    const pool = new MusePool(process.env.OPENCLAW_MUSE_BIN ?? "muse");
    // The test runner isolates XDG_CONFIG_HOME, so a file-backed Muse login
    // (`TBH_CREDENTIAL_BACKEND=file muse login`) is staged from its config dir.
    const loginConfigHome = process.env.OPENCLAW_MUSE_LIVE_CONFIG_HOME;
    if (loginConfigHome && process.env.XDG_CONFIG_HOME) {
      await mkdir(join(process.env.XDG_CONFIG_HOME, "muse"), { recursive: true });
      await copyFile(
        join(loginConfigHome, "muse", "auth.json"),
        join(process.env.XDG_CONFIG_HOME, "muse", "auth.json"),
      );
      process.env.TBH_CREDENTIAL_BACKEND = "file";
    }
    const lease = await pool.acquire(workspace, process.env.OPENCLAW_MUSE_LIVE_KEY, true);
    try {
      const session = await openMuseSession(lease.runtime, {
        workspace,
        modelId: process.env.OPENCLAW_MUSE_LIVE_MODEL ?? "muse-spark-1.3",
        approvalMode: "denyUnmatched",
        mcpServers: {},
      });
      const turn = await session.sendUserTurn({
        input: [{ type: "text", text: "Reply with exactly MSP-OK. Do not use tools." }],
      });
      let text = "";
      for await (const item of turn.items()) {
        if (item.kind === "agentMessage" && item.status === "completed") {
          text += item.text ?? "";
        }
      }
      const outcome = await turn.completed;
      expect(outcome).toMatchObject({ kind: "completed", params: { terminal: "completed" } });
      expect(text).toContain("MSP-OK");
    } finally {
      lease.release();
      await pool.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
