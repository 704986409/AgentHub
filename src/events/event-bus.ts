import { randomUUID } from 'node:crypto';

import type { DomainEventType } from '../core/types.js';
import { redactEventValue } from './event-redaction.js';

export interface DomainEvent {
  eventId: string;
  eventType: DomainEventType | string;
  agentId?: string | null | undefined;
  taskId?: string | null | undefined;
  assignmentId?: string | null | undefined;
  projectId?: string | null | undefined;
  payload?: unknown;
  actor?: string | null | undefined;
  oldStatus?: string | null | undefined;
  newStatus?: string | null | undefined;
  timestamp: string;
}

export type EventHandler = (event: DomainEvent) => void;

export class EventBus {
  readonly #handlers = new Set<EventHandler>();

  public subscribe(handler: EventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  public publish(event: Omit<DomainEvent, 'eventId' | 'timestamp'> & Partial<Pick<DomainEvent, 'eventId' | 'timestamp'>>): DomainEvent {
    const complete: DomainEvent = {
      ...event,
      ...(event.payload === undefined ? {} : { payload: redactEventValue(event.payload) }),
      eventId: event.eventId ?? randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
      actor: event.actor ?? 'system',
    };
    for (const handler of this.#handlers) handler(complete);
    return complete;
  }

  public publishSystemError(error: unknown, payload: unknown = {}): DomainEvent {
    return this.publish({
      eventType: 'SystemError',
      actor: 'system',
      payload: { error: error instanceof Error ? error.message : String(error), context: payload },
    });
  }
}
