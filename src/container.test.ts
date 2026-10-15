import { afterEach, describe, expect, it, vi } from "vitest";
import { createMnemoTools } from "./tools.js";

// Real core (no getmnemo mock): proves the container actually reaches the
// wire, and that a container-less setup fails with core's clear error.
describe("container threading against real getmnemo core", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GETMNEMO_CONTAINER_TAG;
  });

  it("a container-less call works when GETMNEMO_CONTAINER_TAG is set", async () => {
    process.env.GETMNEMO_CONTAINER_TAG = "user:env";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = createMnemoTools({ apiKey: "k" });
    const out = await tools.memorySearch.execute!(
      { query: "x" },
      { messages: [], toolCallId: "c1" },
    );
    expect(out).toEqual({ results: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("user:env");
  });

  it("a missing container gives core's clear error", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tools = createMnemoTools({ apiKey: "k" });
    await expect(
      tools.memorySearch.execute!({ query: "x" }, { messages: [], toolCallId: "c2" }),
    ).rejects.toThrow(/a container is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
