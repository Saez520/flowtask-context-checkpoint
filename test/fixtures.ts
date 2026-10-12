export type V2Event =
  | { type: "session.created"; data: { sessionID: string; parentID?: string; location: { directory: string } } }
  | { type: "session.deleted"; data: { sessionID: string } }
  | { type: "session.step.started"; data: { sessionID: string } }
  | { type: "session.text.ended"; data: { sessionID: string; assistantMessageID: string; ordinal: number; text: string } }
  | { type: "session.step.failed"; data: { sessionID: string } }
  | { type: "session.execution.failed"; data: { sessionID: string } }
  | { type: "session.execution.interrupted"; data: { sessionID: string } }
  | { type: "session.step.ended"; data: { sessionID: string; assistantMessageID: string; finish: string; tokens: { input: number; output?: number; reasoning?: number; cache: { read: number; write: number } } } }

type Hook = (event: any) => unknown

export function createPluginHarness() {
  const queue: V2Event[] = []
  const waiters: Array<{ resolve: () => void; close: () => void }> = []
  const hooks = new Map<string, Hook>()
  const messages = new Map<string, Array<{ message: unknown; visibleAfter: number }>>()
  const diagnostics: string[] = []
  let modelLimit = 1000
  let disposed = 0
  let aborted = false
  let contextReads = 0
  let subscribeAttempts = 0
  let currentClose: (() => void) | undefined
  let blockNextRead = false
  let releaseBlockedRead: (() => void) | undefined

  const context = {
    options: {}, location: { directory: "/project" },
    session: {
      hook: async (name: string, callback: Hook) => { hooks.set(name, callback); return { dispose: () => { disposed++ } } },
      context: async ({ sessionID }: { sessionID: string }) => {
        contextReads++
        if (blockNextRead) {
          blockNextRead = false
          await new Promise<void>(resolve => { releaseBlockedRead = resolve })
        }
        await Promise.resolve()
        return (messages.get(sessionID) ?? [])
          .filter(item => item.visibleAfter <= contextReads)
          .map(item => item.message)
      },
    },
    model: { list: async () => ({ data: [{ providerID: "provider", id: "model", limit: { context: modelLimit } }] }) },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => {
      subscribeAttempts++
      let closed = false
      let waiter: { resolve: () => void; close: () => void } | undefined
      const close = () => {
        if (closed) return
        closed = true
        if (waiter) {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          const resolve = waiter.resolve
          waiter = undefined
          resolve()
        }
      }
      currentClose = close
      signal.addEventListener("abort", close, { once: true })
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted && !closed) {
            const event = queue.shift()
            if (event) { yield event; continue }
            await new Promise<void>(resolve => {
              waiter = { resolve, close }
              waiters.push(waiter)
            })
          }
        },
      }
    } },
  }

  return {
    context,
    emit(event: V2Event) {
      const waiter = waiters.shift()
      if (waiter) { queue.push(event); waiter.resolve() } else queue.push(event)
    },
    async flush() { for (let i = 0; i < 32; i++) await Promise.resolve() },
    async runHook(name: string, event: any) { await hooks.get(name)?.(event) },
    setModelLimit(value: number) { modelLimit = value },
    appendMessage(sessionID: string, message: unknown, visibleAfter = 1) {
      messages.set(sessionID, [...(messages.get(sessionID) ?? []), { message, visibleAfter }])
    },
    blockNextContextRead() {
      blockNextRead = true
      return () => { releaseBlockedRead?.(); releaseBlockedRead = undefined }
    },
    closeStream() { currentClose?.() },
    async waitFor(predicate: () => boolean, timeout = 1500) {
      const deadline = Date.now() + timeout
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for harness condition")
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    async settle(ms = 700) { await new Promise(resolve => setTimeout(resolve, ms)) },
    diagnostics,
    get disposed() { return disposed },
    get aborted() { return aborted },
    get registeredHooks() { return [...hooks.keys()] },
    get contextReads() { return contextReads },
    get subscribeAttempts() { return subscribeAttempts },
    markAborted() { aborted = true; currentClose?.() },
  }
}

export const childCreated = (sessionID = "child"): V2Event => ({ type: "session.created", data: { sessionID, parentID: "parent", location: { directory: "/project" } } })
export const stepStarted = (sessionID = "child"): V2Event => ({ type: "session.step.started", data: { sessionID } })
export const textEnded = (sessionID = "child", assistantMessageID = "message", text = "answer", ordinal = 0): V2Event => ({ type: "session.text.ended", data: { sessionID, assistantMessageID, ordinal, text } })
export const completedStep = (sessionID = "child", assistantMessageID = "message", input = 700, finish = "stop"): V2Event => ({ type: "session.step.ended", data: { sessionID, assistantMessageID, finish, tokens: { input, output: 900, reasoning: 100, cache: { read: 0, write: 0 } } } })
export const stepFailed = (sessionID = "child"): V2Event => ({ type: "session.step.failed", data: { sessionID } })
export const executionFailed = (sessionID = "child"): V2Event => ({ type: "session.execution.failed", data: { sessionID } })
export const executionInterrupted = (sessionID = "child"): V2Event => ({ type: "session.execution.interrupted", data: { sessionID } })
