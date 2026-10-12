import { describe, expect, spyOn, test } from "bun:test"
import { parseOptions } from "../lib/config"
import { SessionState } from "../lib/session-state"
import { findContextLimit, readContextWindow } from "../lib/context-window"
import plugin from "../index"
import { childCreated, completedStep, createPluginHarness, executionFailed, executionInterrupted, stepFailed, stepStarted, textEnded } from "./fixtures"

async function startHarness(harness: ReturnType<typeof createPluginHarness>) {
  const setup = (plugin as unknown as { setup(ctx: unknown): Promise<() => Promise<void>> }).setup
  return setup(harness.context)
}

async function withImmediateTimers<T>(work: () => Promise<T>, delays: number[] = []): Promise<T> {
  const original = globalThis.setTimeout
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    delays.push(Number(delay ?? 0))
    if (typeof callback === "function") callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  try { return await work() } finally { globalThis.setTimeout = original }
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
  test("tracks terminal response windows and epochs", () => {
    const state = new SessionState()
    state.addChild("child"); state.arm("child"); expect(state.start("child")).toBe(true)
    state.appendText("child", "m1", 0, "answer")
    expect(state.finish("child", "m1")?.text).toBe("answer")
    const epoch=state.getEpoch("child")
    expect(state.apply("child",epoch,false)).toBe(1)
    state.invalidateUsage("child")
    expect(state.apply("child",epoch,false)).toBeUndefined()
    for(let i=0;i<34;i++){state.arm("child");state.start("child");state.finish("child",`m${i}`)}
    expect(state.isFinished("child","m0")).toBe(false)
    state.clear()
  })

  test("invalidates armed usage and omissions on a stream cut without an open window", () => {
    const state = new SessionState()
    state.addChild("child")
    state.setUsage("child", { input: 70, cache: { read: 0, write: 0 } })
    state.arm("child")
    const epoch = state.getEpoch("child")
    expect(state.apply("child", epoch, false)).toBe(1)

    state.cutStream()

    expect(state.getUsage("child")).toBeUndefined()
    expect(state.isArmed("child")).toBe(false)
    expect(state.getEpoch("child")).toBe(epoch + 1)
    expect(state.apply("child", epoch, false)).toBeUndefined()
    expect(state.apply("child", epoch + 1, false)).toBe(1)
    expect(state.start("child")).toBe(false)
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
    harness.appendMessage("child", { id: "step-2", type: "assistant", content: [{ type: "text", text: "answer" }] })
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

  test("integrates omission warnings, tag reset, duplicate IDs, and unavailable-message fallback", async () => {
    const harness = createPluginHarness()
    const cleanup = await startHarness(harness)
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    const productWarnings = () => warning.mock.calls.map(call => String(call[0])).filter(message => message.startsWith("[flowtask-context-checkpoint] consecutive-omissions:") || message.startsWith("[flowtask-context-checkpoint] assistant-message-unavailable:"))
    const model = { providerID: "provider", id: "model" }
    const checkpoint = async (suffix: string) => {
      harness.emit(completedStep("child", `measure-${suffix}`, 700))
      await harness.flush()
      await harness.runHook("context", { sessionID: "child", model, system: [] })
    }
    const reply = async (id: string, text: string | undefined) => {
      harness.emit({ type: "session.step.started", data: { sessionID: "child" } })
      if (text !== undefined) {
        harness.emit({ type: "session.text.ended", data: { sessionID: "child", assistantMessageID: id, ordinal: 0, text } })
        harness.appendMessage("child", { id, type: "assistant", content: [{ type: "text", text }] })
      }
      harness.emit(completedStep("child", id, 700))
      await harness.flush()
    }

    try {
      harness.emit(childCreated())
      await harness.flush()
      await checkpoint("first")
      await checkpoint("reply-1")
      await reply("reply-1", "No checkpoint")
      await checkpoint("reply-2")
      await reply("reply-2", "Still no checkpoint")
      await harness.settle()
      expect(productWarnings()).toEqual(["[flowtask-context-checkpoint] consecutive-omissions:child:2"])

      await checkpoint("tag-request")
      await reply("tagged-reply", "[FLOWTASK_CHECKPOINT_CAPACITY: completed]")
      await harness.settle()
      await checkpoint("after-tag-request")
      await reply("after-tag", "No tag")
      await harness.settle()
      expect(productWarnings()).toEqual(["[flowtask-context-checkpoint] consecutive-omissions:child:2"])

      await checkpoint("unavailable-request")
      await reply("unavailable-reply", undefined)
      await harness.settle()
      expect(productWarnings()).toEqual(["[flowtask-context-checkpoint] consecutive-omissions:child:2", "[flowtask-context-checkpoint] assistant-message-unavailable:child"])
      // Re-delivery of the same unavailable assistant ID is ignored.
      harness.emit(completedStep("child", "unavailable-reply", 700))
      await harness.flush()
      expect(productWarnings()).toHaveLength(2)

    } finally {
      warning.mockRestore()
      await cleanup()
    }
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

  test("keeps tool-call steps in one response window until a terminal finish", async () => {
    const harness = createPluginHarness()
    const cleanup = await startHarness(harness)
    try {
      harness.emit(childCreated())
      await harness.flush()
      harness.emit(completedStep("child", "measure", 700))
      await harness.flush()
      await harness.runHook("context", { sessionID: "child", model: { providerID: "provider", id: "model" }, system: [] })

      harness.emit(stepStarted())
      harness.emit(textEnded("child", "reply", "first part"))
      harness.appendMessage("child", { id: "reply", type: "assistant", content: [{ type: "text", text: "first part\nsecond part" }] })
      harness.emit(completedStep("child", "reply", 700, "tool-calls"))
      await harness.flush()
      expect(harness.contextReads).toBe(0)

      // The next step continues the same armed response in the event contract.
      harness.emit(textEnded("child", "reply", "second part", 1))
      harness.emit(completedStep("child", "reply", 700, "stop"))
      await harness.flush()
      await harness.waitFor(() => harness.contextReads === 1)
      expect(harness.contextReads).toBe(1)
    } finally {
      await cleanup()
    }
  })

  for (const [name, failure] of [
    ["step.failed", stepFailed],
    ["execution.failed", executionFailed],
    ["execution.interrupted", executionInterrupted],
  ] as const) {
    test(`resets an armed response without verifying after ${name}`, async () => {
      const harness = createPluginHarness()
      const cleanup = await startHarness(harness)
      try {
        harness.emit(childCreated())
        await harness.flush()
        harness.emit(completedStep("child", "measure", 700))
        await harness.flush()
        await harness.runHook("context", { sessionID: "child", model: { providerID: "provider", id: "model" }, system: [] })
        harness.emit(stepStarted())
        harness.emit(textEnded("child", "reply", "partial"))
        harness.emit(failure())
        await harness.flush()
        harness.emit(completedStep("child", "late-reply", 700))
        await harness.flush()
        expect(harness.contextReads).toBe(0)
      } finally {
        await cleanup()
      }
    })
  }

  test("retries visibility without counting unknown when history is late", async () => {
    const harness = createPluginHarness()
    const cleanup = await startHarness(harness)
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      harness.emit(childCreated())
      await harness.flush()
      const model = { providerID: "provider", id: "model" }
      const checkpoint = async (measurement: string) => {
        harness.emit(completedStep("child", measurement, 700))
        await harness.flush()
        const request = { sessionID: "child", model, system: [] as unknown[] }
        await harness.runHook("context", request)
        return request.system.length
      }
      const reply = async (id: string, text: string) => {
        harness.emit(stepStarted())
        harness.emit(textEnded("child", id, text))
        harness.appendMessage("child", { id, type: "assistant", content: [{ type: "text", text }] }, 3)
        harness.emit(completedStep("child", id, 700))
        await harness.flush()
      }

      expect(await checkpoint("measurement-1")).toBe(1)
      await reply("late-plain", "No checkpoint")
      await harness.waitFor(() => harness.contextReads === 3)
      await harness.settle()
      expect(harness.contextReads).toBe(3)
      expect(warning.mock.calls.map(call => String(call[0])).filter(message => message.includes("consecutive-omissions"))).toEqual([])
    } finally {
      warning.mockRestore()
      await cleanup()
    }
  })

  test("discards a verification result after an epoch change", async () => {
    const harness = createPluginHarness()
    const cleanup = await startHarness(harness)
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      harness.emit(childCreated())
      await harness.flush()
      harness.emit(completedStep("child", "measure", 700))
      await harness.flush()
      await harness.runHook("context", { sessionID: "child", model: { providerID: "provider", id: "model" }, system: [] })
      const release = harness.blockNextContextRead()
      harness.emit(stepStarted())
      harness.emit(textEnded("child", "reply", "No checkpoint"))
      harness.appendMessage("child", { id: "reply", type: "assistant", content: [{ type: "text", text: "No checkpoint" }] })
      harness.emit(completedStep("child", "reply", 700))
      await harness.waitFor(() => harness.contextReads === 1)
      await harness.runHook("compaction", { sessionID: "child" })
      release()
      await harness.settle()
      expect(warning.mock.calls.map(call => String(call[0])).filter(message => message.includes("consecutive-omissions") || message.includes("assistant-message-unavailable"))).toEqual([])
    } finally {
      warning.mockRestore()
      await cleanup()
    }
  })

  test("cancels a pending verification during plugin cleanup", async () => {
    const harness = createPluginHarness()
    const cleanup = await startHarness(harness)
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      harness.emit(childCreated())
      await harness.flush()
      harness.emit(completedStep("child", "measure", 700))
      await harness.flush()
      await harness.runHook("context", { sessionID: "child", model: { providerID: "provider", id: "model" }, system: [] })
      const release = harness.blockNextContextRead()
      harness.emit(stepStarted())
      harness.emit(textEnded("child", "reply", "No checkpoint"))
      harness.appendMessage("child", { id: "reply", type: "assistant", content: [{ type: "text", text: "No checkpoint" }] })
      harness.emit(completedStep("child", "reply", 700))
      await harness.waitFor(() => harness.contextReads === 1)
      await cleanup()
      release()
      await harness.settle()
      const cancellationWarnings = warning.mock.calls.map(call => String(call[0])).filter(message => message.includes("consecutive-omissions") || message.includes("assistant-message-unavailable"))
      expect(cancellationWarnings.filter(message => message.includes("consecutive-omissions"))).toEqual([])
      expect(cancellationWarnings.filter(message => message.includes("assistant-message-unavailable"))).toHaveLength(1)
    } finally {
      warning.mockRestore()
    }
  })

  test("invalidates active windows on stream cuts and recovers after an event", async () => {
    const delays: number[] = []
    await withImmediateTimers(async () => {
      const harness = createPluginHarness()
      const cleanup = await startHarness(harness)
      try {
        harness.emit(childCreated())
        await harness.flush()
        harness.emit(completedStep("child", "measure", 700))
        await harness.flush()
        await harness.runHook("context", { sessionID: "child", model: { providerID: "provider", id: "model" }, system: [] })
        harness.emit(stepStarted())
        harness.emit(textEnded("child", "reply", "partial"))
        await harness.flush()

        harness.closeStream()
        await harness.waitFor(() => harness.subscribeAttempts >= 2)
        harness.emit(completedStep("child", "lost-reply", 700))
        await harness.flush()
        expect(harness.contextReads).toBe(0)

        // A received event resets the consecutive stream-failure backoff.
        harness.emit({ type: "session.created", data: { sessionID: "unrelated", location: { directory: "/project" } } })
        await harness.flush()
        harness.closeStream()
        await harness.waitFor(() => harness.subscribeAttempts >= 3)
        expect(harness.subscribeAttempts).toBe(3)
        expect(delays.filter(delay => delay !== 10)).toEqual([250, 250])
      } finally {
        await cleanup()
      }
    }, delays)
  })

  test("stops after ten consecutive stream failures and logs once", async () => {
    const delays: number[] = []
    await withImmediateTimers(async () => {
      const harness = createPluginHarness()
      const cleanup = await startHarness(harness)
      const warning = spyOn(console, "warn").mockImplementation(() => {})
      try {
        await harness.waitFor(() => harness.subscribeAttempts >= 1)
        for (let failure = 0; failure < 10; failure++) {
          harness.closeStream()
          await harness.waitFor(() => harness.subscribeAttempts >= failure + 2 || warning.mock.calls.some(call => String(call[0]).includes("event-stream-failed")))
        }
        const streamWarnings = warning.mock.calls.map(call => String(call[0])).filter(message => message.includes("event-stream-failed"))
        expect(streamWarnings).toHaveLength(1)
        expect(harness.subscribeAttempts).toBe(10)
        expect(delays.filter(delay => delay !== 10)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000, 5000])
      } finally {
        warning.mockRestore()
        await cleanup()
      }
    }, delays)
  })
})
