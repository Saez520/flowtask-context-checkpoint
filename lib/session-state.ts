import type { TokenUsage } from "./context-window"

export class SessionState {
  private readonly children = new Set<string>()
  private readonly usage = new Map<string, TokenUsage>()
  private readonly pending = new Set<string>()
  private readonly seenMessages = new Set<string>()
  private readonly omissions = new Map<string, number>()

  addChild(id: string): void { this.children.add(id) }
  isChild(id: string): boolean { return this.children.has(id) }
  setUsage(id: string, usage: TokenUsage): void { this.usage.set(id, usage) }
  getUsage(id: string): TokenUsage | undefined { return this.usage.get(id) }
  invalidateUsage(id: string): void { this.usage.delete(id); this.reset(id) }
  markEmitted(id: string): void { this.pending.add(id) }

  consumeAssistant(sessionID: string, messageID: string, hasTag: boolean): number | undefined {
    if (!this.pending.has(sessionID) || this.seenMessages.has(messageID)) return undefined
    this.seenMessages.add(messageID)
    const count = hasTag ? 0 : (this.omissions.get(sessionID) ?? 0) + 1
    this.omissions.set(sessionID, count)
    if (hasTag) this.pending.delete(sessionID)
    return count
  }
  reset(sessionID: string): void { this.pending.delete(sessionID); this.omissions.delete(sessionID) }
  delete(sessionID: string): void {
    this.children.delete(sessionID); this.usage.delete(sessionID); this.reset(sessionID)
    for (const id of this.seenMessages) if (id.startsWith(`${sessionID}:`)) this.seenMessages.delete(id)
  }
  clear(): void {
    this.children.clear(); this.usage.clear(); this.pending.clear(); this.seenMessages.clear(); this.omissions.clear()
  }
}
