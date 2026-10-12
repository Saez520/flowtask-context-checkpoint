import { Plugin } from "@opencode/plugin"
import { checkpointInstruction } from "./lib/checkpoint-instruction"
import { parseOptions } from "./lib/config"
import { findContextLimit, readContextWindow, type ModelReference, type TokenUsage } from "./lib/context-window"
import { SessionState } from "./lib/session-state"

export default Plugin.define({
  id: "flowtask-context-checkpoint",
  async setup(ctx) {
    const log = (cause: string) => { try { console.warn(`[flowtask-context-checkpoint] ${cause}`) } catch {} }
    const options = parseOptions(ctx.options as Record<string, unknown>, key => log(`invalid-option:${key}`))
    const state = new SessionState()
    const controller = new AbortController()
    const contextHook = await ctx.session.hook("context", async event => {
      if (!options.enabled) return
      try {
        if (!state.isChild(event.sessionID)) return
        const reading = readContextWindow(state.getUsage(event.sessionID))
        if (reading.tokens === undefined) { state.reset(event.sessionID); log(`measurement-unavailable:${event.sessionID}:${reading.reason ?? "missing-token-data"}`); return }
        const limit = findContextLimit((await ctx.model.list()).data, event.model as ModelReference) ?? options.assumedContextLimit
        if (limit === options.assumedContextLimit) log(`assumed-context-limit:${event.sessionID}`)
        const ratio = reading.tokens / limit
        if (ratio < options.checkpointThreshold) { state.reset(event.sessionID); return }
        event.system.push({ type: "text", text: checkpointInstruction(reading.tokens, limit, ratio) })
        state.markEmitted(event.sessionID)
      } catch { log(`context-hook-failed:${event.sessionID}`) }
    })
    const compactionHook = await ctx.session.hook("compaction", event => {
      state.invalidateUsage(event.sessionID)
    })
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.deleted") {
            const sessionID = event.data.sessionID
            if (sessionID) state.delete(sessionID)
            continue
          }
          if (event.type === "session.created") {
            if (event.data.parentID && event.data.location.directory === ctx.location.directory) state.addChild(event.data.sessionID)
            continue
          }
          if (event.type !== "session.step.ended") continue
          const { sessionID, assistantMessageID, tokens } = event.data
          if (state.isChild(sessionID)) state.setUsage(sessionID, tokens as TokenUsage)
          const dedupeID = `${sessionID}:${assistantMessageID}`
          let hasTag = false
          try {
            const result = await ctx.session.context({ sessionID })
            const candidate = result.find(item => item.id === assistantMessageID)
            if (!candidate || candidate.type !== "assistant") { state.reset(sessionID); log(`assistant-message-unavailable:${sessionID}`); continue }
            const message = candidate
            hasTag = message.content.filter(part => part.type === "text").map(part => part.text).join("\n").includes("[FLOWTASK_CHECKPOINT_CAPACITY:")
          } catch { state.reset(sessionID); log(`assistant-message-unavailable:${sessionID}`); continue }
          const count = state.consumeAssistant(sessionID, dedupeID, hasTag)
          if (count !== undefined && count >= 2) log(`consecutive-omissions:${sessionID}:${count}`)
        }
      } catch { if (!controller.signal.aborted) log("event-stream-failed") }
    })()
    return async () => { controller.abort(); state.clear(); await Promise.all([contextHook.dispose(), compactionHook.dispose()]) }
  },
})
