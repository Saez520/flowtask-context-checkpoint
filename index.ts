import { Plugin } from "@opencode/plugin"
import { checkpointInstruction } from "./lib/checkpoint-instruction"
import { parseOptions } from "./lib/config"
import { readContextWindow } from "./lib/context-window"
import { SessionState } from "./lib/session-state"

export default Plugin.define({
  id: "flowtask-context-checkpoint",
  async setup(ctx) {
    const log = (cause: string) => { try { console.warn(`[flowtask-context-checkpoint] ${cause}`) } catch {} }
    const options = parseOptions(ctx.options as Record<string, unknown>, key => log(`invalid-option:${key}`))
    const state = new SessionState()
    const controller = new AbortController()
    const hook = await ctx.session.hook("context", async (rawEvent: unknown) => {
      const event = rawEvent as any
      if (!options.enabled) return
      try {
        const session = await ctx.session.get({ sessionID: event.sessionID })
        if (!(session as any).parentID || (session as any).directory !== (ctx.location as any).directory) return
        const limits = (event as any).model?.limit?.context
        const limit = typeof limits === "number" && Number.isFinite(limits) && limits > 0 ? limits : options.assumedContextLimit
        const reading = readContextWindow(event.sessionID)
        if (!reading.tokens) { state.reset(event.sessionID); log(`measurement-unavailable:${event.sessionID}:${reading.reason ?? "zero-tokens"}`); return }
        const ratio = reading.tokens / limit
        if (ratio < options.checkpointThreshold) { state.reset(event.sessionID); return }
        (event as any).system.push({ type: "text", text: checkpointInstruction(reading.tokens, limit, ratio) })
        state.markEmitted(event.sessionID)
      } catch { log(`context-hook-failed:${event.sessionID}`) }
    })
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal }) as AsyncIterable<any>) {
          if (event.type === "session.deleted") {
            const sessionID = (event.properties as { info?: { id?: string } }).info?.id
            if (sessionID) state.delete(sessionID)
          }
          if (event.type !== "message.updated") continue
          const props = event.properties as { info?: { id?: string; role?: string; time?: { completed?: number }; summary?: string }; sessionID?: string }
          const info = props.info, sessionID = props.sessionID
          if (!info || !sessionID || info.role !== "assistant" || !info.time?.completed || !info.id) continue
          const count = state.consumeAssistant(sessionID, info.id, Boolean(info.summary?.includes("[FLOWTASK_CHECKPOINT_CAPACITY:")))
          if (count !== undefined && count >= 2) log(`consecutive-omissions:${sessionID}:${count}`)
        }
      } catch { if (!controller.signal.aborted) log("event-stream-failed") }
    })()
    return async () => { controller.abort(); state.clear(); await hook.dispose() }
  },
})
