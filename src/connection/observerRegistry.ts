import { off, onValue } from "firebase/database";

import {
  decrementLifecycleCounter,
  incrementLifecycleCounter,
} from "../lifecycle/lifecycleDiagnostics";

type ObserverContext = {
  contextId: number;
  sessionEpoch: number;
};

type ContextActiveCheck = (contextId: number, sessionEpoch: number) => boolean;
type ContextDisposedHandler = (reason: string, contextId: number) => void;

export class ObserverRegistry {
  private cleanupByContext = new Map<number, Map<string, () => void>>();
  private readonly isContextActive: ContextActiveCheck;
  private readonly onContextDisposed: ContextDisposedHandler;

  constructor(
    isContextActive: ContextActiveCheck,
    onContextDisposed: ContextDisposedHandler,
  ) {
    this.isContextActive = isContextActive;
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

  observe(
    context: ObserverContext,
    key: string,
    targetRef: any,
    onData: (snapshot: any) => void,
    onError?: (error: unknown) => void,
    onCleanup?: () => void,
  ): (() => void) | null {
    const contextCleanup = () => {
      off(targetRef);
      decrementLifecycleCounter("connectionObservers");
      onCleanup?.();
    };
    if (!this.register(context.contextId, key, contextCleanup)) {
      return null;
    }
    incrementLifecycleCounter("connectionObservers");
    onValue(
      targetRef,
      (snapshot) => {
        if (!this.isContextActive(context.contextId, context.sessionEpoch)) {
          return;
        }
        onData(snapshot);
      },
      (error) => {
        if (!this.isContextActive(context.contextId, context.sessionEpoch)) {
          return;
        }
        onError?.(error);
      },
    );
    return () => {
      contextCleanup();
      this.unregister(context.contextId, key);
    };
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
