type ContextDisposedHandler = (reason: string, contextId: number) => void;

export class ObserverRegistry {
  private cleanupByContext = new Map<number, Map<string, () => void>>();
  private readonly onContextDisposed: ContextDisposedHandler;

  constructor(onContextDisposed: ContextDisposedHandler) {
    this.onContextDisposed = onContextDisposed;
  }

  register(contextId: number, key: string, cleanup: () => void): boolean {
    let cleanupByKey = this.cleanupByContext.get(contextId);
    if (!cleanupByKey) {
      cleanupByKey = new Map();
      this.cleanupByContext.set(contextId, cleanupByKey);
    }
    if (cleanupByKey.has(key)) {
      return false;
    }
    cleanupByKey.set(key, cleanup);
    return true;
  }

  unregister(contextId: number, key: string): void {
    const cleanupByKey = this.cleanupByContext.get(contextId);
    if (cleanupByKey) {
      cleanupByKey.delete(key);
      if (cleanupByKey.size === 0) {
        this.cleanupByContext.delete(contextId);
      }
    }
  }

  cleanupContext(contextId: number, reason: string): void {
    const cleanupByKey = this.cleanupByContext.get(contextId);
    if (!cleanupByKey) {
      return;
    }
    cleanupByKey.forEach((cleanup) => {
      try {
        cleanup();
      } catch {}
    });
    this.cleanupByContext.delete(contextId);
    this.onContextDisposed(reason, contextId);
  }

  clear(reason: string): void {
    const contextIds = Array.from(this.cleanupByContext.keys());
    contextIds.forEach((contextId) => {
      this.cleanupContext(contextId, reason);
    });
  }
}
