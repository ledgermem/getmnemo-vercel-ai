# @ledgermem/vercel-ai

LedgerMem adapter for the [Vercel AI SDK](https://sdk.vercel.dev). Drop-in
`tool()` definitions that let any model search and write persistent memory,
plus a small React hook for client-side memory views.

## Install

```bash
npm install @ledgermem/vercel-ai @ledgermem/memory ai
```

Set `LEDGERMEM_API_KEY` and `LEDGERMEM_WORKSPACE_ID` in your environment, or
pass them explicitly.

## Quickstart (30 seconds)

```ts
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { ledgermemTools } from "@ledgermem/vercel-ai";

const result = await streamText({
  model: openai("gpt-4o"),
  tools: ledgermemTools, // memorySearch + memoryAdd
  maxSteps: 5,
  messages: [{ role: "user", content: "What did I tell you about my coffee?" }],
});

for await (const chunk of result.textStream) process.stdout.write(chunk);
```

## Per-user memory (route handler)

```ts
import { createLedgerMemTools } from "@ledgermem/vercel-ai";

export async function POST(req: Request) {
  const { messages, userId } = await req.json();
  const tools = createLedgerMemTools({ metadata: { userId } });
  return streamText({ model: openai("gpt-4o"), tools, messages }).toDataStreamResponse();
}
```

## React hook

```tsx
"use client";
import { useLedgerMem } from "@ledgermem/vercel-ai/react";

export function MemorySidebar() {
  const { results, search, loading } = useLedgerMem({ initialQuery: "preferences" });
  return (
    <ul>
      {results.map((m: any) => <li key={m.id}>{m.content}</li>)}
    </ul>
  );
}
```

## License

MIT
