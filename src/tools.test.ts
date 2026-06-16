import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMnemoTools } from "./tools.js";

const searchMock = vi.fn();
const addMock = vi.fn();

vi.mock("getmnemo", () => {
  return {
    Mnemo: vi.fn().mockImplementation(() => ({
      // Core 0.2.0 contract (confirmed prod 2026-06-16):
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
});
