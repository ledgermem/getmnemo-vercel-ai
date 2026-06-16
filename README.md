# getmnemo-vercel-ai

[Mnemo](https://mnemohq.com) adapter for the [Vercel AI SDK](https://sdk.vercel.dev). Drop-in
`tool()` definitions that let any model search and write persistent memory,
plus a small React hook for client-side memory views.

## Install

```bash
npm install getmnemo-vercel-ai ai
```

`getmnemo` (the core SDK) is bundled as a dependency. Set `GETMNEMO_API_KEY`
and `GETMNEMO_WORKSPACE_ID` in your environment, or pass them explicitly.

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
`GETMNEMO_WORKSPACE_ID` from `process.env` the first time a tool runs.

## Per-user memory (route handler)

Use `createMnemoTools` when you need per-request scoping. The `metadata` you
pass is merged into every `memoryAdd` call (and cannot be overwritten by the
model), so it's the right place for a `userId`:

```ts
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { createMnemoTools } from "getmnemo-vercel-ai";

export async function POST(req: Request) {
  const { messages, userId } = await req.json();
  const tools = createMnemoTools({ metadata: { userId } });

  const result = streamText({
    model: openai("gpt-4o"),
    tools,
    maxSteps: 5,
    messages,
  });

  return result.toDataStreamResponse();
}
```

`createMnemoTools` also accepts `apiKey` / `workspaceId` (instead of env vars),
a pre-built `client`, and a `defaultLimit` for searches the model doesn't size:

```ts
const tools = createMnemoTools({
  apiKey: process.env.GETMNEMO_API_KEY,
  workspaceId: process.env.GETMNEMO_WORKSPACE_ID,
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

const memory = new Mnemo({
  apiKey: process.env.GETMNEMO_API_KEY!,
  workspaceId: process.env.GETMNEMO_WORKSPACE_ID!,
});

await memory.add({ content: "User prefers oat milk." });
const { hits } = await memory.search({ query: "what milk does the user like?" });
```

## React hook

For client-side memory views (sidebars, inspectors), use `useMnemo`. It reads
`NEXT_PUBLIC_GETMNEMO_API_KEY` / `NEXT_PUBLIC_GETMNEMO_WORKSPACE_ID` by default
— but note those keys are public, so prefer a server route for production
writes. The hook returns `SearchHit` objects, keyed by `memoryId`:

```tsx
"use client";
import { useMnemo } from "getmnemo-vercel-ai/react";
import type { SearchHit } from "getmnemo";

export function MemorySidebar() {
  const { results, search, loading } = useMnemo<SearchHit>({
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

## Docs

Full documentation at [mnemohq.com](https://mnemohq.com).

## License

MIT
