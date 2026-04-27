import { LedgerMem } from "@ledgermem/memory";
import { tool } from "ai";
import { z } from "zod";

/**
 * Options for constructing a LedgerMem toolset.
 *
 * Either pass `client` (a pre-built `LedgerMem` instance) or `apiKey` +
 * `workspaceId` and one will be created for you.
 */
export interface LedgerMemToolsOptions {
  client?: LedgerMem;
  apiKey?: string;
  workspaceId?: string;
  /** Default `limit` passed to `search` when the model omits it. */
  defaultLimit?: number;
  /** Static metadata merged into every `add` call (e.g. `{ userId }`). */
  metadata?: Record<string, unknown>;
}

export interface LedgerMemToolset {
  memorySearch: ReturnType<typeof tool>;
  memoryAdd: ReturnType<typeof tool>;
}

/**
 * Build a pair of Vercel AI SDK tools backed by LedgerMem.
 *
 * Drop the returned object into `streamText({ tools })` or
 * `generateText({ tools })` and the model can search and write
 * persistent memory.
 */
export function createLedgerMemTools(
  options: LedgerMemToolsOptions = {},
): LedgerMemToolset {
  const client = resolveClient(options);
  const defaultLimit = options.defaultLimit ?? 5;
  const baseMetadata = options.metadata ?? {};

  const memorySearch = tool({
    description:
      "Search the user's long-term memory for facts, preferences, or past conversations relevant to the current query. Returns the most relevant snippets.",
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .describe("Natural-language query describing what to recall."),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Max number of memories to return."),
    }),
    execute: async ({ query, limit }) => {
      const results = await client.search(query, {
        limit: limit ?? defaultLimit,
      });
      return { results };
    },
  });

  const memoryAdd = tool({
    description:
      "Save a new fact, preference, or noteworthy detail about the user to long-term memory. Use sparingly — only for information worth remembering across sessions.",
    parameters: z.object({
      content: z
        .string()
        .min(1)
        .describe("The fact or note to remember, written in plain text."),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe("Optional structured tags (e.g. { topic, source })."),
    }),
    execute: async ({ content, metadata }) => {
      const merged = { ...baseMetadata, ...(metadata ?? {}) };
      const memory = await client.add(content, { metadata: merged });
      return { memory };
    },
  });

  return { memorySearch, memoryAdd };
}

/**
 * Pre-built default toolset using `LEDGERMEM_API_KEY` and
 * `LEDGERMEM_WORKSPACE_ID` from `process.env`.
 *
 * Lazy — the client isn't constructed until a tool actually runs.
 */
export const ledgermemTools: LedgerMemToolset = (() => {
  let cached: LedgerMemToolset | null = null;
  const get = () => (cached ??= createLedgerMemTools());
  return new Proxy({} as LedgerMemToolset, {
    get: (_target, prop: string) => get()[prop as keyof LedgerMemToolset],
  });
})();

function resolveClient(opts: LedgerMemToolsOptions): LedgerMem {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env.LEDGERMEM_API_KEY;
  const workspaceId = opts.workspaceId ?? process.env.LEDGERMEM_WORKSPACE_ID;
  if (!apiKey || !workspaceId) {
    throw new Error(
      "createLedgerMemTools: missing apiKey/workspaceId. Pass them explicitly or set LEDGERMEM_API_KEY and LEDGERMEM_WORKSPACE_ID.",
    );
  }
  return new LedgerMem({ apiKey, workspaceId });
}
