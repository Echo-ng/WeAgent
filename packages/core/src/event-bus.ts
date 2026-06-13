import type { StreamEvent } from '@weagent/shared';

type StreamListener = (event: StreamEvent) => void;

export class EventBus {
  private listeners = new Set<StreamListener>();

  subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: StreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
