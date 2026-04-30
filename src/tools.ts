import { Mnemo } from "@mnemo/memory";
import { tool } from "ai";
import { z } from "zod";

/**
 * Options for constructing a Mnemo toolset.
 *
 * Either pass `client` (a pre-built `Mnemo` instance) or `apiKey` +
 * `workspaceId` and one will be created for you.
 */
export interface MnemoToolsOptions {
  client?: Mnemo;
  apiKey?: string;
  workspaceId?: string;
  /** Default `limit` passed to `search` when the model omits it. */
  defaultLimit?: number;
  /** Static metadata merged into every `add` call (e.g. `{ userId }`). */
  metadata?: Record<string, unknown>;
}

export interface MnemoToolset {
  memorySearch: ReturnType<typeof tool>;
  memoryAdd: ReturnType<typeof tool>;
}

/**
 * Build a pair of Vercel AI SDK tools backed by Mnemo.
 *
 * Drop the returned object into `streamText({ tools })` or
 * `generateText({ tools })` and the model can search and write
 * persistent memory.
 */
export function createMnemoTools(
  options: MnemoToolsOptions = {},
): MnemoToolset {
  const client = resolveClient(options);
  const defaultLimit = options.defaultLimit ?? 5;
  const baseMetadata = options.metadata ?? {};

  const memorySearch = tool({
    description:
      "Search the user's long-term memory for facts, preferences, or past conversations relevant to the current query. Returns the most relevant snippets.",
    // .strict() emits additionalProperties:false so providers that honour
    // strict JSON schema (OpenAI, Anthropic) reject hallucinated keys
    // instead of silently dropping them at parse time.
    parameters: z
      .object({
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
      })
      .strict(),
    execute: async ({ query, limit }) => {
      // Clamp the limit defensively — the schema constrains the model,
      // but a non-conforming provider response could still smuggle a
      // huge value through and blow the context window.
      const requested = limit ?? defaultLimit;
      const safeLimit = Math.min(50, Math.max(1, Math.floor(requested)));
      const results = await client.search(query, { limit: safeLimit });
      return { results };
    },
  });

  const memoryAdd = tool({
    description:
      "Save a new fact, preference, or noteworthy detail about the user to long-term memory. Use sparingly — only for information worth remembering across sessions.",
    parameters: z
      .object({
        content: z
          .string()
          .min(1)
          .describe("The fact or note to remember, written in plain text."),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe("Optional structured tags (e.g. { topic, source })."),
      })
      .strict(),
    execute: async ({ content, metadata }) => {
      // Model-supplied metadata is merged FIRST so trusted baseMetadata
      // (e.g. userId, workspaceId) cannot be overwritten by prompt injection.
      const merged = { ...(metadata ?? {}), ...baseMetadata };
      const memory = await client.add(content, { metadata: merged });
      return { memory };
    },
  });

  return { memorySearch, memoryAdd };
}

/**
 * Pre-built default toolset using `GETMNEMO_API_KEY` and
 * `GETMNEMO_WORKSPACE_ID` from `process.env`.
 *
 * Lazy — the client isn't constructed until a tool actually runs.
 */
export const getmnemoTools: MnemoToolset = (() => {
  let cached: MnemoToolset | null = null;
  const get = () => (cached ??= createMnemoTools());
  return new Proxy({} as MnemoToolset, {
    get: (_target, prop: string) => get()[prop as keyof MnemoToolset],
  });
})();

function resolveClient(opts: MnemoToolsOptions): Mnemo {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env.GETMNEMO_API_KEY;
  const workspaceId = opts.workspaceId ?? process.env.GETMNEMO_WORKSPACE_ID;
  if (!apiKey || !workspaceId) {
    throw new Error(
      "createMnemoTools: missing apiKey/workspaceId. Pass them explicitly or set GETMNEMO_API_KEY and GETMNEMO_WORKSPACE_ID.",
    );
  }
  return new Mnemo({ apiKey, workspaceId });
}
