import { useCallback, useEffect, useRef, useState } from "react";
import { Mnemo } from "@getmnemo/memory";

export interface UseMnemoOptions {
  apiKey?: string;
  workspaceId?: string;
  client?: Mnemo;
  /** Initial query to run on mount; pass `undefined` to skip. */
  initialQuery?: string;
  initialLimit?: number;
}

export interface UseMnemoResult<T = unknown> {
  results: T[];
  loading: boolean;
  error: Error | null;
  search: (query: string, limit?: number) => Promise<T[]>;
  add: (content: string, metadata?: Record<string, unknown>) => Promise<T>;
  remove: (id: string) => Promise<void>;
}

/**
 * Tiny React hook for direct Mnemo access from client components.
 *
 * For tool-use inside `useChat`, prefer wiring `getmnemoTools` into the
 * server route instead — this hook is for sidebars / memory inspectors.
 */
export function useMnemo<T = unknown>(
  options: UseMnemoOptions = {},
): UseMnemoResult<T> {
  const [client] = useState(() => resolveClient(options));
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
        const r = (await client.search(query, { limit })) as T[];
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
    [client],
  );

  const add = useCallback(
    async (content: string, metadata: Record<string, unknown> = {}) => {
      // Bump the request id BEFORE awaiting so any in-flight ``search``
      // started earlier loses the last-wins race and cannot wipe the
      // memory we are about to prepend. Without this, a fast
      // ``add()`` immediately after a slow ``search()`` would see the
      // search resolve last and clobber the freshly-added entry.
      const myId = ++requestIdRef.current;
      const memory = (await client.add(content, { metadata })) as T;
      if (mountedRef.current && myId === requestIdRef.current) {
        setResults((prev) => [memory, ...prev]);
      }
      return memory;
    },
    [client],
  );

  const remove = useCallback(
    async (id: string) => {
      const myId = ++requestIdRef.current;
      await client.delete(id);
      // Same last-wins guard as ``add`` — a slow concurrent ``search``
      // could otherwise resolve after the delete and re-introduce the
      // just-removed row into the rendered list.
      if (mountedRef.current && myId === requestIdRef.current) {
        setResults((prev) =>
          prev.filter((r) => (r as { id?: string })?.id !== id),
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
      "useMnemo: missing apiKey/workspaceId. Note: client-side keys are public — prefer a server route in production.",
    );
  }
  return new Mnemo({ apiKey, workspaceId });
}
