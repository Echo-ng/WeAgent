/** 同一会话串行执行 Claude 查询，避免并发 --resume 导致回复串台 */
export class ConversationMutex {
  private chains = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => gate);
    this.chains.set(key, next);
    await prev;
    return () => {
      release();
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    };
  }
}
