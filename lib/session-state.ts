export class SessionState {
  private readonly emitted = new Set<string>()
  private readonly seenMessages = new Set<string>()
  private readonly omissions = new Map<string, number>()
  markEmitted(sessionID: string): void { this.emitted.add(sessionID) }
  consumeAssistant(sessionID: string, messageID: string, hasTag: boolean): number | undefined {
    if (!this.emitted.has(sessionID) || this.seenMessages.has(messageID)) return undefined
    this.seenMessages.add(messageID)
    const count = hasTag ? 0 : (this.omissions.get(sessionID) ?? 0) + 1
    this.omissions.set(sessionID, count)
    if (hasTag) this.emitted.delete(sessionID)
    return count
  }
  reset(sessionID: string): void { this.emitted.delete(sessionID); this.omissions.delete(sessionID) }
  delete(sessionID: string): void { this.reset(sessionID) }
  clear(): void { this.emitted.clear(); this.seenMessages.clear(); this.omissions.clear() }
}
