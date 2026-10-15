import { describe, expect, it, vi, beforeEach } from "vitest";
import { Mnemo } from "getmnemo";
import { createMnemoTools, getmnemoTools } from "./tools.js";

const searchMock = vi.fn();
const addMock = vi.fn();

vi.mock("getmnemo", () => {
  return {
    Mnemo: vi.fn().mockImplementation(() => ({
      // Core 0.6.0 contract (unchanged from 0.2 for these calls):
      // search → { results, ... }, add → { scopeKey, scope, items }.
      search: searchMock,
      add: addMock,
      update: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    })),
  };
});

describe("createMnemoTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GETMNEMO_CONTAINER_TAG;
    searchMock.mockResolvedValue({
      results: [
        {
          resultType: "memory",
          memoryId: "m1",
          scopeKey: "user:u1",
          content: "user likes oat milk",
          metadata: null,
          memoryType: "fact",
          polarity: "positive",
          score: 0.9,
          createdAt: "2026-06-16T00:00:00.000Z",
          updatedAt: "2026-06-16T00:00:00.000Z",
        },
      ],
      positivePreferences: [],
      hardConstraints: [],
      searchMode: "hybrid",
      queryIntent: "recall",
      queryIntentConfidence: 0.9,
      abstained: false,
      reranked: true,
      rawBestVectorSim: 0.81,
      latency: { parallelMs: 1, strategyMs: 1, fusionMs: 1, rerankerMs: 1, totalMs: 4 },
    });
    addMock.mockResolvedValue({
      scopeKey: "user:u1",
      scope: { type: "user", id: "u1" },
      items: [{ id: "m2", content: "stored", contentHash: "h", container: { id: "c1", tag: "user:u1", containerType: "user", displayName: "u1" } }],
    });
  });

  it("builds memorySearch and memoryAdd tools", () => {
    const tools = createMnemoTools({ apiKey: "k", workspaceId: "w" });
    expect(tools.memorySearch).toBeDefined();
    expect(tools.memoryAdd).toBeDefined();
  });

  it("memorySearch.execute sends q (not query) with default limit and threads containerTag", async () => {
    const tools = createMnemoTools({
      apiKey: "k",
      workspaceId: "w",
      defaultLimit: 7,
      containerTag: "user:u1",
    });
    const out = await tools.memorySearch.execute!(
      { query: "oat milk" },
      { messages: [], toolCallId: "t1" },
    );
    expect(searchMock).toHaveBeenCalledWith({
      q: "oat milk",
      limit: 7,
      containerTag: "user:u1",
    });
    expect(out).toEqual({
      results: [
        {
          resultType: "memory",
          memoryId: "m1",
          scopeKey: "user:u1",
          content: "user likes oat milk",
          metadata: null,
          memoryType: "fact",
          polarity: "positive",
          score: 0.9,
          createdAt: "2026-06-16T00:00:00.000Z",
          updatedAt: "2026-06-16T00:00:00.000Z",
        },
      ],
    });
  });

  it("memoryAdd.execute merges base metadata, threads containerTag, returns AddResponse", async () => {
    const tools = createMnemoTools({
      apiKey: "k",
      workspaceId: "w",
      metadata: { userId: "u1" },
      containerTag: "user:u1",
    });
    const out = await tools.memoryAdd.execute!(
      { content: "likes oat milk", metadata: { topic: "drinks" } },
      { messages: [], toolCallId: "t2" },
    );
    expect(addMock).toHaveBeenCalledWith({
      content: "likes oat milk",
      metadata: { topic: "drinks", userId: "u1" },
      containerTag: "user:u1",
    });
    expect(out).toEqual({
      memory: {
        scopeKey: "user:u1",
        scope: { type: "user", id: "u1" },
        items: [{ id: "m2", content: "stored", contentHash: "h", container: { id: "c1", tag: "user:u1", containerType: "user", displayName: "u1" } }],
      },
    });
  });

  it("omits containerTag from the wire call when not configured (falls back to client default)", async () => {
    const tools = createMnemoTools({ apiKey: "k", workspaceId: "w" });
    await tools.memorySearch.execute!(
      { query: "x" },
      { messages: [], toolCallId: "t3" },
    );
    expect(searchMock).toHaveBeenCalledWith({ q: "x", limit: 5 });
  });

  it("throws if apiKey missing and env unset", () => {
    const orig = process.env.GETMNEMO_API_KEY;
    delete process.env.GETMNEMO_API_KEY;
    expect(() => createMnemoTools({})).toThrow(/missing apiKey/);
    if (orig) process.env.GETMNEMO_API_KEY = orig;
  });

  it("works without workspaceId (deprecated in core 0.6 — identity comes from the API key)", async () => {
    const tools = createMnemoTools({ apiKey: "k" });
    await tools.memorySearch.execute!(
      { query: "x" },
      { messages: [], toolCallId: "t4" },
    );
    expect(searchMock).toHaveBeenCalledWith({ q: "x", limit: 5 });
  });

  it("memorySearch.execute treats a 404 on an empty container as empty results", async () => {
    searchMock.mockRejectedValueOnce(
      Object.assign(new Error("[404] Container not found"), { status: 404 }),
    );
    const tools = createMnemoTools({ apiKey: "k", containerTag: "user:new" });
    const out = await tools.memorySearch.execute!(
      { query: "anything" },
      { messages: [], toolCallId: "t5" },
    );
    // Shape must match the normal return — `{ results: [] }`, not an error.
    expect(out).toEqual({ results: [] });
  });

  it("memorySearch.execute rethrows non-404 errors", async () => {
    searchMock.mockRejectedValueOnce(
      Object.assign(new Error("[500] boom"), { status: 500 }),
    );
    const tools = createMnemoTools({ apiKey: "k", containerTag: "user:new" });
    await expect(
      tools.memorySearch.execute!(
        { query: "anything" },
        { messages: [], toolCallId: "t6" },
      ),
    ).rejects.toThrow(/500/);
  });

  it("memorySearch.execute rethrows a 404 that is not container-not-found", async () => {
    searchMock.mockRejectedValueOnce(
      Object.assign(new Error("[404] Route not found"), { status: 404 }),
    );
    const tools = createMnemoTools({ apiKey: "k", containerTag: "user:new" });
    await expect(
      tools.memorySearch.execute!(
        { query: "anything" },
        { messages: [], toolCallId: "t7" },
      ),
    ).rejects.toThrow(/Route not found/);
  });

  it("threads containerTag into the client as defaultContainerTag", () => {
    createMnemoTools({ apiKey: "k", containerTag: "user:u1" });
    expect(Mnemo).toHaveBeenCalledWith({ apiKey: "k", defaultContainerTag: "user:u1" });
  });

  it("falls back to GETMNEMO_CONTAINER_TAG for the container", async () => {
    process.env.GETMNEMO_CONTAINER_TAG = "user:env";
    try {
      const tools = createMnemoTools({ apiKey: "k" });
      expect(Mnemo).toHaveBeenCalledWith({ apiKey: "k", defaultContainerTag: "user:env" });
      await tools.memorySearch.execute!(
        { query: "x" },
        { messages: [], toolCallId: "t8" },
      );
      expect(searchMock).toHaveBeenCalledWith({ q: "x", limit: 5, containerTag: "user:env" });
    } finally {
      delete process.env.GETMNEMO_CONTAINER_TAG;
    }
  });
});

describe("getmnemoTools (lazy default toolset)", () => {
  it("is enumerable so ai@4 sees both tools", () => {
    const orig = process.env.GETMNEMO_API_KEY;
    process.env.GETMNEMO_API_KEY = "k";
    try {
      expect(Object.keys(getmnemoTools).sort()).toEqual(["memoryAdd", "memorySearch"]);
      const spread = { ...getmnemoTools };
      expect(spread.memorySearch).toBeDefined();
      expect(spread.memoryAdd).toBeDefined();
      expect(Object.entries(getmnemoTools)).toHaveLength(2);
      expect("memorySearch" in getmnemoTools).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.GETMNEMO_API_KEY;
      else process.env.GETMNEMO_API_KEY = orig;
    }
  });
});
