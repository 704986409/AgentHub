import type { AgentHubEvent } from '../core/types.js';
import type { EventRepository } from '../repositories/interfaces.js';
import type { DomainEvent } from './event-bus.js';
import type { EventBus } from './event-bus.js';

export class EventStore {
  readonly #unsubscribe: () => void;

  public constructor(
    private readonly repository: EventRepository,
    eventBus: EventBus,
  ) {
    this.#unsubscribe = eventBus.subscribe((event) => this.append(event));
  }

  public append(event: DomainEvent): AgentHubEvent {
    return this.repository.create({
      id: event.eventId,
      eventId: event.eventId,
      eventType: event.eventType,
      projectId: event.projectId,
      agentId: event.agentId,
      taskId: event.taskId,
      assignmentId: event.assignmentId,
      entityType: event.agentId ? 'agent' : event.taskId ? 'task' : event.assignmentId ? 'assignment' : 'system',
      entityId: event.agentId ?? event.taskId ?? event.assignmentId ?? null,
      payload: event.payload,
      actor: event.actor,
      oldStatus: event.oldStatus,
      newStatus: event.newStatus,
      timestamp: event.timestamp,
    });
  }

  public list(): AgentHubEvent[] {
    return this.repository.list();
  }

  public close(): void {
    this.#unsubscribe();
  }
}
