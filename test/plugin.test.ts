import { describe, expect, test } from "bun:test"
import { parseOptions } from "../lib/config"
import { SessionState } from "../lib/session-state"

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
