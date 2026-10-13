/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep this complete mock in the dedicated unit-mock-registry project.
vi.mock("./chat-pane.ts", () => ({}));

import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createSessionTitleSource,
  createSplitLayout,
  setLayout,
  setNavigationContext,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";

describe("chat page session refresh", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("leaves roster presentation updates with mounted panes", async () => {
    const page = new ChatPage();
    const source = createSessionTitleSource();
    const navigation = setNavigationContext(page);
    Object.assign(navigation.context, { sessions: source.sessions });
    page.data = { sessionKey: "agent:main:current" };
    document.body.append(page);
    setLayout(page, createSplitLayout(page.data.sessionKey));
    await page.updateComplete;
    const panes = [...page.querySelectorAll("openclaw-chat-pane")];
    const render = vi.spyOn(page, "render");
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );

    for (const key of ["agent:main:other", page.data.sessionKey]) {
      source.publish(key, "Updated conversation");
      for (const frame of frames.splice(0)) {
        frame(0);
      }
      await page.updateComplete;
    }

    expect(render).not.toHaveBeenCalled();
    expect([...page.querySelectorAll("openclaw-chat-pane")]).toEqual(panes);
    page.remove();
    expect(source.listeners.size).toBe(0);
  });

  it("refreshes route defaults on hello changes while leaving profile updates with children", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    const listeners = new Set<(snapshot: typeof navigation.context.gateway.snapshot) => void>();
    const gateway = {
      ...navigation.context.gateway,
      subscribe: (listener: (snapshot: typeof navigation.context.gateway.snapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    Object.assign(navigation.context, { gateway });
    page.data = { sessionKey: "agent:main:current" };
    document.body.append(page);
    await page.updateComplete;
    const render = vi.spyOn(page, "render");
    const publish = (patch: Partial<typeof gateway.snapshot>) => {
      gateway.snapshot = { ...gateway.snapshot, ...patch };
      for (const listener of listeners) {
        listener(gateway.snapshot);
      }
    };

    publish({
      selfUser: { id: "riley", name: "Riley", identity: { type: "profile", id: "riley" } },
    });
    await page.updateComplete;
    expect(render).not.toHaveBeenCalled();
    publish({
      hello: {
        ...gatewayHelloForMethods([]),
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "dev",
            mainKey: "main",
            mainSessionKey: "agent:dev:main",
          },
        },
      },
    });
    await page.updateComplete;
    expect(render).toHaveBeenCalledOnce();
    page.remove();
    expect(listeners.size).toBe(0);
  });
});
