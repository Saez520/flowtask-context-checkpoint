import { describe, expect, test } from "bun:test"
import { parseOptions } from "../lib/config"
import { SessionState } from "../lib/session-state"
import { findContextLimit, readContextWindow } from "../lib/context-window"
import plugin from "../index"
import { childCreated, completedStep, createPluginHarness } from "./fixtures"

async function startHarness(harness: ReturnType<typeof createPluginHarness>) {
  const setup = (plugin as unknown as { setup(ctx: unknown): Promise<() => Promise<void>> }).setup
  return setup(harness.context)
}

describe("configuration", () => {
  test("defaults and rejects invalid options", () => {
    const warnings: string[] = []
    expect(parseOptions({}, key => warnings.push(key))).toEqual({ enabled: true, checkpointThreshold: 0.7, assumedContextLimit: 128000 })
    expect(parseOptions({ enabled: "yes", checkpointThreshold: 0, assumedContextLimit: 2.5 }, key => warnings.push(key))).toEqual({ enabled: true, checkpointThreshold: 0.7, assumedContextLimit: 128000 })
    expect(warnings).toEqual(["enabled", "checkpointThreshold", "assumedContextLimit"])
  })
})
describe("session lifecycle", () => {
  test("tracks emitted checkpoints, deduplicates, resets on tag, and cleans up", () => {
    const state = new SessionState()
    state.markEmitted("child")
    expect(state.consumeAssistant("child", "m1", false)).toBe(1)
    expect(state.consumeAssistant("child", "m1", false)).toBeUndefined()
    expect(state.consumeAssistant("child", "m2", false)).toBe(2)
    expect(state.consumeAssistant("child", "m3", true)).toBe(0)
    expect(state.consumeAssistant("child", "m4", false)).toBeUndefined()
    state.markEmitted("child")
    state.delete("child")
    expect(state.consumeAssistant("child", "m5", false)).toBeUndefined()
    state.clear()
  })
})

describe("V2 usage events", () => {
  test("uses non-cached input and cache read/write once; ignores output and reasoning", () => {
    expect(readContextWindow({ input: 100, cache: { read: 20, write: 5 } })).toEqual({ tokens: 125 })
    expect(readContextWindow({ input: -1, cache: { read: 20, write: 5 } })).toEqual({ reason: "invalid-token-data" })
    expect(readContextWindow(undefined)).toEqual({ reason: "missing-token-data" })
  })

  test("matches model variant and validates dynamic context limits", () => {
    const ref = { providerID: "p", id: "m", variant: "v" }
    expect(findContextLimit([{ ...ref, limit: { context: 1000 } }], ref)).toBe(1000)
    expect(findContextLimit([{ ...ref, limit: { context: Infinity } }], ref)).toBeUndefined()
    expect(findContextLimit([{ providerID: "p", id: "m", limit: { context: 2000 } }], ref)).toBeUndefined()
  })

  test("tracks child eligibility and invalidates stale usage after compaction", () => {
    const state = new SessionState()
    state.addChild("child")
    state.setUsage("child", { input: 70, cache: { read: 0, write: 0 } })
    expect(state.isChild("child")).toBe(true)
    state.invalidateUsage("child")
    expect(state.getUsage("child")).toBeUndefined()
    state.delete("child")
    expect(state.isChild("child")).toBe(false)
  })
})

describe("V2 event-driven plugin", () => {
  test("requires matching child creation, injects at threshold, and uses the current model limit", async () => {
    const harness = createPluginHarness()
    const cleanup = await startHarness(harness)
    harness.emit({ type: "session.created", data: { sessionID: "not-child", location: { directory: "/project" } } })
    harness.emit(childCreated("child"))
    await harness.flush()
    harness.emit(completedStep("child", "step-1", 700))
    await harness.flush()
    const event = { sessionID: "child", model: { providerID: "provider", id: "model" }, system: [] as unknown[] }
    await harness.runHook("context", event)
    expect(event.system).toHaveLength(1)
    harness.setModelLimit(2000)
    const next = { ...event, system: [] as unknown[] }
    await harness.runHook("context", next)
    expect(next.system).toHaveLength(0)
    const unrelated = { sessionID: "missed", model: event.model, system: [] as unknown[] }
    await harness.runHook("context", unrelated)
    expect(unrelated.system).toHaveLength(0)
    await cleanup()
    expect(harness.disposed).toBe(2)
  })

  test("invalidates after compaction, accepts a fresh step, deduplicates messages, and deletes sessions", async () => {
    const harness = createPluginHarness()
    const cleanup = await startHarness(harness)
    harness.emit(childCreated())
    await harness.flush()
    harness.emit(completedStep("child", "step-1", 700))
    await harness.flush()
    await harness.runHook("context", { sessionID: "child", model: { providerID: "provider", id: "model" }, system: [] })
    await harness.runHook("compaction", { sessionID: "child" })
    const stale = { sessionID: "child", model: { providerID: "provider", id: "model" }, system: [] as unknown[] }
    await harness.runHook("context", stale)
    expect(stale.system).toHaveLength(0)
    harness.emit(completedStep("child", "step-2", 700))
    await harness.flush()
    const fresh = { ...stale, system: [] as unknown[] }
    await harness.runHook("context", fresh)
    expect(fresh.system).toHaveLength(1)
    harness.setMessage("child", { id: "step-2", type: "assistant", content: [{ type: "text", text: "answer" }] })
    harness.emit(completedStep("child", "step-2", 701))
    await harness.flush()
    harness.emit({ type: "session.deleted", data: { sessionID: "child" } })
    await harness.flush()
    const deleted = { ...stale, system: [] as unknown[] }
    await harness.runHook("context", deleted)
    expect(deleted.system).toHaveLength(0)
    await cleanup()
    expect(harness.disposed).toBe(2)
  })

  test("does not inject without a measurement and uses exact, unrounded threshold", async () => {
    const harness = createPluginHarness()
    const cleanup = await startHarness(harness)
    harness.emit(childCreated())
    await harness.flush()
    const model = { providerID: "provider", id: "model" }
    const absent = { sessionID: "child", model, system: [] as unknown[] }
    await harness.runHook("context", absent)
    expect(absent.system).toHaveLength(0)
    harness.emit(completedStep("child", "below", 699.5))
    await harness.flush()
    const below = { ...absent, system: [] as unknown[] }
    await harness.runHook("context", below)
    expect(below.system).toHaveLength(0)
    harness.emit(completedStep("child", "at", 700))
    await harness.flush()
    const at = { ...absent, system: [] as unknown[] }
    await harness.runHook("context", at)
    expect(at.system).toHaveLength(1)
    await cleanup()
  })
})
