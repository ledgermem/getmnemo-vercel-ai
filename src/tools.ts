import { Mnemo } from "getmnemo";
import { tool } from "ai";
import { z } from "zod";
import { isContainerNotFound } from "./errors.js";

/**
 * Options for constructing a Mnemo toolset.
 *
 * Either pass `client` (a pre-built `Mnemo` instance) or `apiKey` and one
 * will be created for you.
 */
export interface MnemoToolsOptions {
  client?: Mnemo;
  apiKey?: string;
  /**
   * @deprecated Workspace identity is taken from the API key in core 0.6.
   * Accepted for backwards compatibility but ignored (a no-op in core 0.6).
   */
  workspaceId?: string;
  /**
   * Container tag (tenant boundary) threaded into every `search`/`add` call —
   * e.g. `"user:${userId}"`. DEVELOPER/SERVER-supplied ONLY; it is the
   * isolation key between tenants. This is NOT exposed in the model-facing
   * tool schema, so the model can never read or write across a tenant
   * boundary. Also set as the built client's `defaultContainerTag`. When
   * omitted, falls back to `GETMNEMO_CONTAINER_TAG`; with neither, core 0.6
   * throws "a container is required" on the first call.
   */
  containerTag?: string;
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
 *
 * SECURITY: `containerTag` is the tenant boundary. Set it here, server-side
 * (e.g. `createMnemoTools({ containerTag: \`user:${userId}\` })`). It is
 * deliberately absent from the model-facing schemas below — the model only
 * ever sees `query`/`content` (+ optional `limit`/`metadata`), never the
 * container — so a prompt-injected request cannot redirect a read or write
 * to another tenant.
 */
export function createMnemoTools(
  options: MnemoToolsOptions = {},
): MnemoToolset {
  const client = resolveClient(options);
  const defaultLimit = options.defaultLimit ?? 5;
  const baseMetadata = options.metadata ?? {};
  // Resolved once, server-side. Never derived from model output.
  const containerTag = resolveContainerTag(options.containerTag);

  const memorySearch: any = tool({
    description:
      "Search the user's long-term memory for facts, preferences, or past conversations relevant to the current query. Returns the most relevant snippets.",
    // .strict() emits additionalProperties:false so providers that honour
    // strict JSON schema (OpenAI, Anthropic) reject hallucinated keys
    // instead of silently dropping them at parse time.
    //
    // NOTE: `containerTag` is intentionally NOT a field here. The tenant
    // boundary is supplied server-side and merged in `execute` below.
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
      ,
    execute: async ({ query, limit }) => {
      // Clamp the limit defensively — the schema constrains the model,
      // but a non-conforming provider response could still smuggle a
      // huge value through and blow the context window.
      const requested = limit ?? defaultLimit;
      const safeLimit = Math.min(50, Math.max(1, Math.floor(requested)));
      // `query` → `q` (core 0.6.0). `containerTag` injected server-side.
      let results;
      try {
        ({ results } = await client.search({
          q: query,
          limit: safeLimit,
          ...(containerTag ? { containerTag } : {}),
        }));
      } catch (err: unknown) {
        // A brand-new container has no memories yet — the API answers a
        // search against a not-yet-written container with 404 "Container not
        // found". For recall that means "nothing remembered yet", not a fatal
        // error → same shape as the normal return, just empty.
        if (isContainerNotFound(err)) {
          return { results: [] };
        }
        throw err;
      }
      // confirmed against prod 2026-06-16. Core returns
      // `{ results: SearchHit[], ... }` (SearchHit: resultType, memoryId,
      // scopeKey, content, metadata, memoryType, polarity, score, createdAt,
      // updatedAt). Surface the primary results array to the model.
      return { results };
    },
  });

  const memoryAdd: any = tool({
    description:
      "Save a new fact, preference, or noteworthy detail about the user to long-term memory. Use sparingly — only for information worth remembering across sessions.",
    // NOTE: `containerTag` is intentionally NOT a field here either —
    // the model cannot choose which tenant a memory is written to.
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
      ,
    execute: async ({ content, metadata }) => {
      // Model-supplied metadata is merged FIRST so trusted baseMetadata
      // (e.g. userId, workspaceId) cannot be overwritten by prompt injection.
      const merged = { ...(metadata ?? {}), ...baseMetadata };
      // `containerTag` injected server-side — the tenant boundary, never
      // sourced from the model.
      const result = await client.add({
        content,
        metadata: merged,
        ...(containerTag ? { containerTag } : {}),
      });
      // confirmed against prod 2026-06-16. Core returns an
      // `AddResponse` ({ scopeKey, scope, items: Memory[] }).
      return { memory: result };
    },
  });

  return { memorySearch, memoryAdd };
}

const TOOL_NAMES = ["memorySearch", "memoryAdd"] as const;

/**
 * Pre-built default toolset using `GETMNEMO_API_KEY`,
 * (optionally) `GETMNEMO_WORKSPACE_ID` (deprecated), and (optionally)
 * `GETMNEMO_CONTAINER_TAG` from `process.env`.
 *
 * The container tag — the tenant boundary — is read from env/config, never
 * from the model. Lazy: the client isn't constructed until a tool is first
 * read (e.g. when the AI SDK enumerates the toolset).
 */
export const getmnemoTools: MnemoToolset = (() => {
  let cached: MnemoToolset | null = null;
  const get = () => (cached ??= createMnemoTools());
  const isToolName = (prop: string | symbol): prop is keyof MnemoToolset =>
    typeof prop === "string" && (TOOL_NAMES as readonly string[]).includes(prop);
  // ownKeys + getOwnPropertyDescriptor make the lazy proxy enumerable, so
  // Object.keys/entries and spreading see both tools (ai@4 checks
  // `Object.keys(tools).length > 0` before sending any tool definitions).
  return new Proxy({} as MnemoToolset, {
    get: (_target, prop) => (isToolName(prop) ? get()[prop] : undefined),
    has: (_target, prop) => isToolName(prop),
    ownKeys: () => [...TOOL_NAMES],
    getOwnPropertyDescriptor: (_target, prop) =>
      isToolName(prop)
        ? { value: get()[prop], writable: false, enumerable: true, configurable: true }
        : undefined,
  });
})();

function resolveClient(opts: MnemoToolsOptions): Mnemo {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env.GETMNEMO_API_KEY;
  // Deprecated in core 0.6 (workspace identity comes from the API key);
  // accepted for backwards compatibility but ignored by the core.
  const workspaceId = opts.workspaceId ?? process.env.GETMNEMO_WORKSPACE_ID;
  const defaultContainerTag = resolveContainerTag(opts.containerTag);
  if (!apiKey) {
    throw new Error(
      "createMnemoTools: missing apiKey. Pass it explicitly or set GETMNEMO_API_KEY.",
    );
  }
  return new Mnemo({
    apiKey,
    ...(workspaceId ? { workspaceId } : {}),
    ...(defaultContainerTag ? { defaultContainerTag } : {}),
  });
}

function resolveContainerTag(explicit: string | undefined): string | undefined {
  return explicit ?? process.env.GETMNEMO_CONTAINER_TAG ?? undefined;
}
