import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMnemoTools } from "./tools.js";

vi.mock("@getmnemo/memory", () => {
  return {
    Mnemo: vi.fn().mockImplementation(() => ({
      search: vi
        .fn()
        .mockResolvedValue([{ id: "m1", content: "user likes oat milk" }]),
      add: vi.fn().mockResolvedValue({ id: "m2", content: "stored" }),
      update: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    })),
  };
});

describe("createMnemoTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds memorySearch and memoryAdd tools", () => {
    const tools = createMnemoTools({ apiKey: "k", workspaceId: "w" });
    expect(tools.memorySearch).toBeDefined();
    expect(tools.memoryAdd).toBeDefined();
  });

  it("memorySearch.execute calls client.search with default limit", async () => {
    const tools = createMnemoTools({
      apiKey: "k",
      workspaceId: "w",
      defaultLimit: 7,
    });
    const out = await tools.memorySearch.execute!(
      { query: "oat milk" },
      { messages: [], toolCallId: "t1" },
    );
    expect(out).toEqual({
      results: [{ id: "m1", content: "user likes oat milk" }],
    });
  });

  it("memoryAdd.execute merges base metadata with per-call metadata", async () => {
    const tools = createMnemoTools({
      apiKey: "k",
      workspaceId: "w",
      metadata: { userId: "u1" },
    });
    const out = await tools.memoryAdd.execute!(
      { content: "likes oat milk", metadata: { topic: "drinks" } },
      { messages: [], toolCallId: "t2" },
    );
    expect(out).toEqual({ memory: { id: "m2", content: "stored" } });
  });

  it("throws if apiKey missing and env unset", () => {
    const orig = process.env.GETMNEMO_API_KEY;
    delete process.env.GETMNEMO_API_KEY;
    expect(() => createMnemoTools({})).toThrow(/missing apiKey/);
    if (orig) process.env.GETMNEMO_API_KEY = orig;
  });
});
