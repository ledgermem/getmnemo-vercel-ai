#!/usr/bin/env node
/**
 * CI prod smoke gate for the `getmnemo-vercel-ai` adapter.
 *
 * A REAL round-trip against PRODUCTION with NO LLM in the loop. It builds the
 * local adapter's tools (`./dist` → `createMnemoTools`) and invokes their
 * `execute` handlers directly — exactly the code path the AI SDK runs when a
 * model calls the tool — so the gate proves tool code → core `getmnemo`
 * add/search → prod API, without depending on any model provider's credits.
 *
 * The publish workflow gates `publish` on `needs: smoke`, so a red run here
 * blocks the release.
 *
 * Steps:
 *   (0) Both tools are enumerable via Object.keys (ai@4 requires it).
 *   (1) memorySearch on a never-written container returns { results: [] }
 *       (404 "Container not found" tolerance).
 *   (2) memoryAdd stores a unique nonce fact; returns created item ids.
 *   (3) memorySearch round-trips the nonce back via `results[].content`.
 *   (4) Cross-container isolation: a sibling container does not see it.
 *
 * Cleanup (delete with containerTag) is best-effort and NEVER fatal.
 *
 * Required env:
 *   MNEMO_API_KEY        scoped test key (needs delete scope for cleanup)
 *   MNEMO_WORKSPACE_ID   throwaway test workspace id
 *   MNEMO_TEST_CONTAINER base container id, e.g. "ci-smoke"
 */

import { createMnemoTools } from '../dist/index.js'
import { Mnemo } from 'getmnemo'

const SEARCH_ATTEMPTS = 5
const SEARCH_RETRY_MS = 2_000

/** Minimal ToolExecutionOptions-shaped second arg for `execute`. */
const execOpts = (id) => ({ toolCallId: `smoke-${id}`, messages: [] })

function fail(msg) {
  console.error(`\n[smoke] FAIL: ${msg}`)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function searchUntil(tools, query, nonce) {
  let last
  for (let i = 0; i < SEARCH_ATTEMPTS; i++) {
    last = await tools.memorySearch.execute({ query, limit: 10 }, execOpts(`search-${i}`))
    const hit = (last?.results ?? []).some((r) => String(r?.content ?? '').includes(nonce))
    if (hit) return { hit: true, last }
    await sleep(SEARCH_RETRY_MS)
  }
  return { hit: false, last }
}

async function main() {
  const apiKey = process.env.MNEMO_API_KEY
  const workspaceId = process.env.MNEMO_WORKSPACE_ID
  const base = process.env.MNEMO_TEST_CONTAINER

  if (!apiKey) fail('MNEMO_API_KEY is not set')
  if (!workspaceId) fail('MNEMO_WORKSPACE_ID is not set')
  if (!base) fail('MNEMO_TEST_CONTAINER is not set')

  // Unique per-run nonce keeps concurrent / re-run smokes from colliding.
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const containerTag = `user:${base}-${nonce}`
  const otherTag = `user:${base}-${nonce}-other`

  const tools = createMnemoTools({ containerTag, apiKey, workspaceId })
  const otherTools = createMnemoTools({ containerTag: otherTag, apiKey, workspaceId })
  const cleanupClient = new Mnemo({ apiKey, workspaceId, defaultContainerTag: containerTag })

  console.log('[smoke] run nonce:', nonce)
  console.log('[smoke] container:', containerTag)

  const createdIds = []

  try {
    // ---- (0) toolset enumerates both tools ---------------------------
    const keys = Object.keys(tools).sort()
    if (JSON.stringify(keys) !== JSON.stringify(['memoryAdd', 'memorySearch'])) {
      fail(`(0) toolset keys = ${JSON.stringify(keys)}`)
    }
    for (const k of keys) {
      if (typeof tools[k]?.execute !== 'function') fail(`(0) ${k}.execute is not a function`)
    }
    console.log('[smoke] OK (0): toolset enumerates memoryAdd + memorySearch')

    // ---- (1) never-written container → { results: [] } ---------------
    const empty = await otherTools.memorySearch.execute({ query: 'anything' }, execOpts('empty'))
    if (!Array.isArray(empty?.results) || empty.results.length !== 0) {
      fail(`(1) expected { results: [] } on a fresh container, got ${JSON.stringify(empty)}`)
    }
    console.log('[smoke] OK (1): fresh-container search returned { results: [] }')

    // ---- (2) memoryAdd ----------------------------------------------
    const added = await tools.memoryAdd.execute(
      { content: `My lucky number is ${nonce}.`, metadata: { source: 'ci-smoke' } },
      execOpts('add'),
    )
    const items = added?.memory?.items
    if (!Array.isArray(items) || items.length === 0) {
      fail(`(2) memoryAdd returned no items: ${JSON.stringify(added)}`)
    }
    for (const item of items) if (item?.id) createdIds.push(item.id)
    console.log(`[smoke] OK (2): memoryAdd created ${createdIds.length} item(s)`)

    // ---- (3) memorySearch round-trips the nonce ----------------------
    const { hit, last } = await searchUntil(tools, "What's my lucky number?", nonce)
    if (!hit) {
      fail(`(3) nonce "${nonce}" not found in memorySearch results: ${JSON.stringify(last)}`)
    }
    console.log('[smoke] OK (3): memorySearch round-tripped the written content')

    // ---- (4) cross-container isolation -------------------------------
    const leak = await otherTools.memorySearch.execute(
      { query: "What's my lucky number?", limit: 10 },
      execOpts('isolation'),
    )
    if ((leak?.results ?? []).some((r) => String(r?.content ?? '').includes(nonce))) {
      fail('(4) sibling container saw the nonce — tenant isolation broken')
    }
    console.log('[smoke] OK (4): sibling container did not see the write')
  } finally {
    for (const id of createdIds) {
      try {
        await cleanupClient.delete(id, { containerTag })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[smoke] WARN: cleanup delete failed for memory ${id}: ${msg}`)
      }
    }
  }

  console.log('\n[smoke] PASS: direct tool add + search round-trip green (no LLM).')
  process.exit(0)
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  fail(`unexpected error during smoke run:\n${msg}`)
})
