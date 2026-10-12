export type V2Event =
  | { type: "session.created"; data: { sessionID: string; parentID?: string; location: { directory: string } } }
  | { type: "session.deleted"; data: { sessionID: string } }
  | { type: "session.step.started"; data: { sessionID: string } }
  | { type: "session.text.ended"; data: { sessionID: string; assistantMessageID: string; ordinal: number; text: string } }
  | { type: "session.step.ended"; data: { sessionID: string; assistantMessageID: string; finish: string; tokens: { input: number; output?: number; reasoning?: number; cache: { read: number; write: number } } } }

type Hook = (event: any) => unknown

export function createPluginHarness() {
  const queue: V2Event[] = []
  const waiters: Array<() => void> = []
  const hooks = new Map<string, Hook>()
  const messages = new Map<string, unknown[]>()
  const diagnostics: string[] = []
  const chains: Promise<void>[] = []
  let modelLimit = 1000
  let disposed = 0
  let aborted = false

  const context = {
    options: {}, location: { directory: "/project" },
    session: {
      hook: async (name: string, callback: Hook) => { hooks.set(name, callback); return { dispose: () => { disposed++ } } },
      context: async ({ sessionID }: { sessionID: string }) => {
        // The durable message may become visible after step.ended is delivered.
        await Promise.resolve()
        return messages.get(sessionID) ?? []
      },
    },
    model: { list: async () => ({ data: [{ providerID: "provider", id: "model", limit: { context: modelLimit } }] }) },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const event = queue.shift()
          if (event) { yield event; continue }
          await new Promise<void>(resolve => waiters.push(() => resolve()))
        }
      },
    }) },
  }

  return {
    context,
    emit(event: V2Event) { const waiter = waiters.shift(); if (waiter) { queue.push(event); waiter() } else queue.push(event) },
    async flush() { for (let i = 0; i < 32; i++) await Promise.resolve() },
    async runHook(name: string, event: any) { await hooks.get(name)?.(event) },
    setModelLimit(value: number) { modelLimit = value },
    setMessage(sessionID: string, message: unknown) { messages.set(sessionID, [...(messages.get(sessionID) ?? []), message]) },
    appendMessage(sessionID: string, message: unknown) { messages.set(sessionID, [...(messages.get(sessionID) ?? []), message]) },
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
    markAborted() { aborted = true },
  }
}

export const childCreated = (sessionID = "child"): V2Event => ({ type: "session.created", data: { sessionID, parentID: "parent", location: { directory: "/project" } } })
export const completedStep = (sessionID = "child", assistantMessageID = "message", input = 700): V2Event => ({ type: "session.step.ended", data: { sessionID, assistantMessageID, finish: "stop", tokens: { input, output: 900, reasoning: 100, cache: { read: 0, write: 0 } } } })
