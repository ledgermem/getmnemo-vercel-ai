#!/usr/bin/env node
/**
 * CI prod smoke gate for the `getmnemo-vercel-ai` adapter.
 *
 * A REAL, LLM-driven round-trip against PRODUCTION. It wires the built local
 * adapter (`./dist` → `createMnemoTools`) into the Vercel AI SDK and lets an
 * actual model (`gpt-4o-mini`) decide to call the tools. This proves the whole
 * chain end to end: tool schemas the model can call → core `getmnemo` add/search
 * → results surfaced back into the model's answer.
 *
 * The publish workflow gates `publish` on `needs: smoke`, so a red run here
 * blocks the release.
 *
 * Two steps:
 *   (a) Prompt the model to STORE a fact ("remember my lucky number is <nonce>").
 *       Assert the model actually invoked the `memoryAdd` tool.
 *   (b) Prompt the model to RECALL it ("what's my lucky number?").
 *       Assert the stored value appears in the answer — which can only happen if
 *       `memorySearch` round-tripped the write back via `response.results`.
 *
 * Exit codes:
 *   0  both steps passed.
 *   1  missing env, or a step failed (no tool call, or value didn't round-trip).
 *
 * Cleanup is best-effort and NEVER fatal.
 *
 * Required env:
 *   MNEMO_API_KEY        scoped test key (needs delete scope for cleanup)
 *   MNEMO_WORKSPACE_ID   throwaway test workspace id
 *   MNEMO_TEST_CONTAINER base container id, e.g. "ci-smoke"
 *   OPENAI_API_KEY       drives the gpt-4o-mini model
 */

import { createMnemoTools } from '../dist/index.js'
import { Mnemo } from 'getmnemo'
import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'

const MODEL_ID = 'gpt-4o-mini'
const MAX_STEPS = 5
// Give the indexer a moment between write and read so the stored fact is
// searchable when step (b) runs.
const PROPAGATION_WAIT_MS = 3_000

function fail(msg) {
  console.error(`\n[smoke] FAIL: ${msg}`)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Flatten every tool call across all generation steps. */
function allToolCalls(result) {
  const fromSteps = (result?.steps ?? []).flatMap((s) => s?.toolCalls ?? [])
  // `result.toolCalls` is the last step's calls; `steps` covers every step.
  // Union them and de-dupe defensively in case the SDK populates only one.
  return fromSteps.length > 0 ? fromSteps : (result?.toolCalls ?? [])
}

/** Flatten every tool result across all generation steps. */
function allToolResults(result) {
  const fromSteps = (result?.steps ?? []).flatMap((s) => s?.toolResults ?? [])
  return fromSteps.length > 0 ? fromSteps : (result?.toolResults ?? [])
}

async function main() {
  const apiKey = process.env.MNEMO_API_KEY
  const workspaceId = process.env.MNEMO_WORKSPACE_ID
  const base = process.env.MNEMO_TEST_CONTAINER
  const openaiKey = process.env.OPENAI_API_KEY

  if (!apiKey) fail('MNEMO_API_KEY is not set')
  if (!workspaceId) fail('MNEMO_WORKSPACE_ID is not set')
  if (!base) fail('MNEMO_TEST_CONTAINER is not set')
  if (!openaiKey) fail('OPENAI_API_KEY is not set')

  // Unique per-run nonce: doubles as the "lucky number" the model stores and
  // recalls, and keeps concurrent / re-run smokes from colliding or reading a
  // prior run's leaked data.
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  // containerTag is SERVER-side (developer-supplied), never model-facing.
  const containerTag = `user:${base}-${nonce}`

  const tools = createMnemoTools({ containerTag, apiKey, workspaceId })

  // Core client used ONLY for best-effort cleanup at the end.
  const cleanupClient = new Mnemo({ apiKey, workspaceId, defaultContainerTag: containerTag })

  console.log('[smoke] model:', MODEL_ID)
  console.log('[smoke] run nonce:', nonce)
  console.log('[smoke] container:', containerTag)

  const createdIds = []

  try {
    // ---- STEP (a): model STORES a fact via memoryAdd --------------------
    const addRun = await generateText({
      model: openai(MODEL_ID),
      tools,
      maxSteps: MAX_STEPS,
      prompt:
        `Remember my lucky number is ${nonce}. ` +
        `Save it to memory so you can recall it for me later.`,
    })

    const addCalls = allToolCalls(addRun)
    const addedToMemory = addCalls.some((c) => c?.toolName === 'memoryAdd')
    if (!addedToMemory) {
      fail(
        'step (a): model did not call the memoryAdd tool. ' +
          `tool calls seen: ${JSON.stringify(addCalls.map((c) => c?.toolName))}. ` +
          `finishReason=${addRun?.finishReason}`,
      )
    }
    console.log('[smoke] OK step (a): model invoked memoryAdd')

    // Harvest created memory ids from the tool result for cleanup. The adapter
    // returns `{ memory: AddResponse }` where AddResponse.items[].id is the id.
    for (const tr of allToolResults(addRun)) {
      if (tr?.toolName !== 'memoryAdd') continue
      const items = tr?.result?.memory?.items
      if (Array.isArray(items)) {
        for (const item of items) if (item?.id) createdIds.push(item.id)
      }
    }

    // Let the indexer make the write searchable before we read it back.
    await sleep(PROPAGATION_WAIT_MS)

    // ---- STEP (b): model RECALLS it via memorySearch -------------------
    const recallRun = await generateText({
      model: openai(MODEL_ID),
      tools,
      maxSteps: MAX_STEPS,
      prompt: "What's my lucky number? Look it up in memory.",
    })

    const recallCalls = allToolCalls(recallRun)
    const searchedMemory = recallCalls.some((c) => c?.toolName === 'memorySearch')
    if (!searchedMemory) {
      fail(
        'step (b): model did not call the memorySearch tool. ' +
          `tool calls seen: ${JSON.stringify(recallCalls.map((c) => c?.toolName))}. ` +
          `finishReason=${recallRun?.finishReason}`,
      )
    }

    const answer = recallRun?.text ?? ''
    if (!answer.includes(nonce)) {
      fail(
        `step (b): the stored lucky number "${nonce}" did NOT appear in the ` +
          `model's answer — memorySearch did not round-trip the write via ` +
          `response.results. answer=${JSON.stringify(answer)}`,
      )
    }
    console.log('[smoke] OK step (b): memorySearch round-tripped the value into the answer')
  } finally {
    // ---- CLEANUP: best-effort delete; failure warns, never fatal -------
    for (const id of createdIds) {
      try {
        await cleanupClient.delete(id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[smoke] WARN: cleanup delete failed for memory ${id}: ${msg}`)
      }
    }
  }

  console.log('\n[smoke] PASS: LLM-driven add + search round-trip green.')
  process.exit(0)
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  fail(`unexpected error during smoke run:\n${msg}`)
})
