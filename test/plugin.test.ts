import { describe, expect, test } from "bun:test"
import { parseOptions } from "../lib/config"
import { SessionState } from "../lib/session-state"
import { findContextLimit, readContextWindow } from "../lib/context-window"

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
