# getmnemo-vercel-ai

[Mnemo](https://mnemohq.com) adapter for the [Vercel AI SDK](https://sdk.vercel.dev). Drop-in
`tool()` definitions that let any model search and write persistent memory,
plus a small React hook for client-side memory views.

## Install

```bash
npm install getmnemo-vercel-ai ai
```

`getmnemo` (the core SDK, `^0.6`) is bundled as a dependency. Set
`GETMNEMO_API_KEY` in your environment, or pass it explicitly.
(`workspaceId` is deprecated — workspace identity now comes from the API key.
It is still accepted for backwards compatibility but ignored.)

This package targets `ai@^4` and `zod@^3`. AI SDK v5 is not supported yet —
pin `ai@^4` alongside it.

## Quickstart (30 seconds)

```ts
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { getmnemoTools } from "getmnemo-vercel-ai";

const result = await streamText({
  model: openai("gpt-4o"),
  tools: getmnemoTools, // memorySearch + memoryAdd
  maxSteps: 5,
  messages: [{ role: "user", content: "What did I tell you about my coffee?" }],
});

for await (const chunk of result.textStream) process.stdout.write(chunk);
```

`getmnemoTools` is lazy — it reads `GETMNEMO_API_KEY` and
`GETMNEMO_CONTAINER_TAG` from `process.env` the first time the toolset is read.
Core 0.6 requires a container on every read/write, so set
`GETMNEMO_CONTAINER_TAG` (e.g. `user:jane`) for this shared toolset, or use
`createMnemoTools({ containerTag })` per request (below). Without one, the
tool call fails with "a container is required".

## Containers and empty-container searches

Pass `containerTag` (e.g. `` `user:${userId}` ``) to `createMnemoTools` to
scope every read/write to one tenant. It is server-supplied only and absent
from the model-facing schemas, so a prompt-injected request can never redirect
a read or write to another tenant.

Searching a container that nothing has written to yet returns no matches:
`memorySearch` handles the API's 404 ("Container not found") for brand-new
containers and returns `{ results: [] }` instead of failing the tool call.

## Per-user memory (route handler)

Use `createMnemoTools` when you need per-request scoping. Pass the user's
container as `containerTag` (the tenant boundary). The `metadata` you
pass is merged into every `memoryAdd` call (and cannot be overwritten by the
model), so it's the right place for a `userId`:

```ts
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { createMnemoTools } from "getmnemo-vercel-ai";

export async function POST(req: Request) {
  const { messages, userId } = await req.json();
  const tools = createMnemoTools({
    containerTag: `user:${userId}`,
    metadata: { userId },
  });

  const result = streamText({
    model: openai("gpt-4o"),
    tools,
    maxSteps: 5,
    messages,
  });

  return result.toDataStreamResponse();
}
```

`createMnemoTools` also accepts `apiKey` (instead of the env var), a pre-built
`client`, and a `defaultLimit` for searches the model doesn't size:

```ts
const tools = createMnemoTools({
  apiKey: process.env.GETMNEMO_API_KEY,
  containerTag: "user:jane",
  defaultLimit: 8,
});
```

## One-shot generation

The same tools work with `generateText`:

```ts
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { getmnemoTools } from "getmnemo-vercel-ai";

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: getmnemoTools,
  maxSteps: 5,
  prompt: "Remember that I'm vegetarian, then suggest a dinner.",
});
```

## Direct SDK access

Need to read or write memory outside a model loop? Use the core client
directly:

```ts
import { Mnemo } from "getmnemo";

const memory = new Mnemo({ apiKey: process.env.GETMNEMO_API_KEY! });

await memory.add({ content: "User prefers oat milk.", containerTag: "user:jane" });
const { results } = await memory.search({
  q: "what milk does the user like?",
  containerTag: "user:jane",
});
```

## React hook

For client-side memory views (sidebars, inspectors), use `useMnemo`.

> **⚠️ Security: a default Mnemo `apiKey` is full-access.**
> A default key grants **read, write, and delete** over your entire workspace.
> **NEVER** ship a full-access key in a browser bundle or any `NEXT_PUBLIC_`
> variable — anything with that prefix is inlined into client-side JavaScript
> and exposed to every visitor, handing them a delete-capable credential.
>
> **Scoped keys do exist:** the dashboard mint dialog offers
> read/write/delete/billing scopes. For any client-exposed context, mint a
> **scoped read-only key** rather than exposing a full-access one. The safest
> path is still to proxy memory reads/writes through a server route (a Server
> Action or Route Handler) that holds the key server-side; `useMnemo` is for
> **trusted internal/admin dashboards** or a scoped read-only key.

The hook reads `NEXT_PUBLIC_GETMNEMO_API_KEY` by default and returns
`SearchHit` objects, keyed by `memoryId`. The example below is **internal/admin only — not for
public-facing apps**:

```tsx
"use client";
import { useMnemo } from "getmnemo-vercel-ai/react";
import type { SearchHit } from "getmnemo";

export function MemorySidebar() {
  const { results, search, loading } = useMnemo<SearchHit>({
    containerTag: "user:jane",
    initialQuery: "preferences",
  });

  if (loading) return <p>Loading…</p>;

  return (
    <ul>
      {results.map((m) => (
        <li key={m.memoryId}>{m.content}</li>
      ))}
    </ul>
  );
}
```

`useMnemo` also exposes `add(content, metadata?)`, `remove(id)`, and `error`.
All three (and `search`) are scoped to `containerTag`; a search against a
brand-new container resolves to `[]`.

## Docs

Full documentation at [mnemohq.com](https://mnemohq.com).

## License

MIT
