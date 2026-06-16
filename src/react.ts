import { useCallback, useEffect, useRef, useState } from "react";
import { Mnemo } from "getmnemo";
import type { SearchHit } from "getmnemo";

export interface UseMnemoOptions {
  apiKey?: string;
  workspaceId?: string;
  client?: Mnemo;
  /**
   * Container tag (tenant boundary) threaded into every `search`/`add`/`remove`
   * call — e.g. `"user:jane"`. DEVELOPER-supplied; it scopes the hook to a
   * single tenant. Falls back to the client's `defaultContainerTag` when
   * omitted.
   */
  containerTag?: string;
  /** Initial query to run on mount; pass `undefined` to skip. */
  initialQuery?: string;
  initialLimit?: number;
}

export interface UseMnemoResult<T = SearchHit> {
  results: T[];
  loading: boolean;
  error: Error | null;
  search: (query: string, limit?: number) => Promise<T[]>;
  add: (content: string, metadata?: Record<string, unknown>) => Promise<unknown>;
  remove: (memoryId: string) => Promise<void>;
}

/**
 * Tiny React hook for direct Mnemo access from client components.
 *
 * For tool-use inside `useChat`, prefer wiring `getmnemoTools` into the
 * server route instead — this hook is for sidebars / memory inspectors.
 */
export function useMnemo<T = SearchHit>(
  options: UseMnemoOptions = {},
): UseMnemoResult<T> {
  const [client] = useState(() => resolveClient(options));
  // Resolved once. The container tag is the tenant boundary — supplied by
  // the developer through options, never derived from rendered/model data.
  const [containerTag] = useState(() => options.containerTag);
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Last-wins guard: every search() bumps the counter and only the most
  // recent call is allowed to write to state. Without this, two rapid
  // searches let the slower one overwrite the fresher one (the classic
  // "stale request wins" race), and unmounting mid-flight wrote state on
  // a torn-down component.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const search = useCallback(
    async (query: string, limit = 5): Promise<T[]> => {
      const myId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        // `query` → `q` (core 0.2.0). `containerTag` injected here, not by
        // the caller's rendered data.
        const { results } = await client.search({
          q: query,
          limit,
          ...(containerTag ? { containerTag } : {}),
        });
        // confirmed against prod 2026-06-16. Core returns
        // `{ results: SearchHit[], ... }` (each hit keyed by `memoryId`).
        const r = results as unknown as T[];
        if (mountedRef.current && myId === requestIdRef.current) {
          setResults(r);
        }
        return r;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (mountedRef.current && myId === requestIdRef.current) {
          setError(err);
        }
        throw err;
      } finally {
        if (mountedRef.current && myId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [client, containerTag],
  );

  const add = useCallback(
    async (content: string, metadata: Record<string, unknown> = {}) => {
      // Bump the request id BEFORE awaiting so any in-flight ``search``
      // started earlier loses the last-wins race and cannot wipe the
      // memory we are about to prepend. Without this, a fast
      // ``add()`` immediately after a slow ``search()`` would see the
      // search resolve last and clobber the freshly-added entry.
      const myId = ++requestIdRef.current;
      // `containerTag` injected server-side — the tenant boundary.
      const result = await client.add({
        content,
        metadata,
        ...(containerTag ? { containerTag } : {}),
      });
      // confirmed against prod 2026-06-16. Core `add` returns an
      // `AddResponse` ({ scopeKey, scope, items: Memory[] }), NOT a SearchHit,
      // so it cannot be prepended into a SearchHit-shaped list verbatim. Map
      // the first stored item into a hit-like row so the inspector reflects
      // the write.
      const firstItem = result?.items?.[0];
      if (
        firstItem &&
        mountedRef.current &&
        myId === requestIdRef.current
      ) {
        const optimistic = {
          memoryId: firstItem.id,
          content: firstItem.content,
          scopeKey: result.scopeKey,
        } as unknown as T;
        setResults((prev) => [optimistic, ...prev]);
      }
      return result;
    },
    [client, containerTag],
  );

  const remove = useCallback(
    async (memoryId: string) => {
      const myId = ++requestIdRef.current;
      await client.delete(memoryId);
      // Same last-wins guard as ``add`` — a slow concurrent ``search``
      // could otherwise resolve after the delete and re-introduce the
      // just-removed row into the rendered list.
      if (mountedRef.current && myId === requestIdRef.current) {
        // confirmed against prod 2026-06-16. SearchHit keys by `memoryId`;
        // filter on that field accordingly.
        setResults((prev) =>
          prev.filter((r) => (r as { memoryId?: string })?.memoryId !== memoryId),
        );
      }
    },
    [client],
  );

  useEffect(() => {
    if (options.initialQuery) {
      void search(options.initialQuery, options.initialLimit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { results, loading, error, search, add, remove };
}

function resolveClient(opts: UseMnemoOptions): Mnemo {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env.NEXT_PUBLIC_GETMNEMO_API_KEY;
  const workspaceId =
    opts.workspaceId ?? process.env.NEXT_PUBLIC_GETMNEMO_WORKSPACE_ID;
  if (!apiKey || !workspaceId) {
    throw new Error(
      "useMnemo: missing apiKey/workspaceId. For client-exposed contexts, mint a scoped read-only key (or proxy through a server route) — never ship a full-access key in a browser bundle.",
    );
  }
  return new Mnemo({ apiKey, workspaceId });
}
