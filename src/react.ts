import { useCallback, useEffect, useState } from "react";
import { LedgerMem } from "@ledgermem/memory";

export interface UseLedgerMemOptions {
  apiKey?: string;
  workspaceId?: string;
  client?: LedgerMem;
  /** Initial query to run on mount; pass `undefined` to skip. */
  initialQuery?: string;
  initialLimit?: number;
}

export interface UseLedgerMemResult<T = unknown> {
  results: T[];
  loading: boolean;
  error: Error | null;
  search: (query: string, limit?: number) => Promise<T[]>;
  add: (content: string, metadata?: Record<string, unknown>) => Promise<T>;
  remove: (id: string) => Promise<void>;
}

/**
 * Tiny React hook for direct LedgerMem access from client components.
 *
 * For tool-use inside `useChat`, prefer wiring `ledgermemTools` into the
 * server route instead — this hook is for sidebars / memory inspectors.
 */
export function useLedgerMem<T = unknown>(
  options: UseLedgerMemOptions = {},
): UseLedgerMemResult<T> {
  const [client] = useState(() => resolveClient(options));
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const search = useCallback(
    async (query: string, limit = 5): Promise<T[]> => {
      setLoading(true);
      setError(null);
      try {
        const r = (await client.search(query, { limit })) as T[];
        setResults(r);
        return r;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  const add = useCallback(
    async (content: string, metadata: Record<string, unknown> = {}) => {
      const memory = (await client.add(content, { metadata })) as T;
      setResults((prev) => [memory, ...prev]);
      return memory;
    },
    [client],
  );

  const remove = useCallback(
    async (id: string) => {
      await client.delete(id);
      setResults((prev) =>
        prev.filter((r) => (r as { id?: string })?.id !== id),
      );
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

function resolveClient(opts: UseLedgerMemOptions): LedgerMem {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env.NEXT_PUBLIC_LEDGERMEM_API_KEY;
  const workspaceId =
    opts.workspaceId ?? process.env.NEXT_PUBLIC_LEDGERMEM_WORKSPACE_ID;
  if (!apiKey || !workspaceId) {
    throw new Error(
      "useLedgerMem: missing apiKey/workspaceId. Note: client-side keys are public — prefer a server route in production.",
    );
  }
  return new LedgerMem({ apiKey, workspaceId });
}
