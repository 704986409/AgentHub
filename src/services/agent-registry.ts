import { AgentStatus } from '../core/types.js';
import type { Agent } from '../core/types.js';
import type { AgentRepository, CreateAgentInput, UpdateAgentInput } from '../repositories/interfaces.js';
import type { AgentProfileManager } from './agent-profile-manager.js';
import type { EventBus } from '../events/event-bus.js';
import { DomainEventType } from '../core/types.js';

export class AgentRegistry {
  public constructor(
    private readonly repository: AgentRepository,
    private readonly profiles: AgentProfileManager,
    private readonly eventBus?: EventBus,
  ) {}

  public createAgent(input: CreateAgentInput, userRules = ''): Agent {
    const agent = this.repository.create(input);
    this.profiles.writeProfile(agent, userRules);
    this.eventBus?.publish({ eventType: DomainEventType.AGENT_CREATED, agentId: agent.id, projectId: agent.projectId, payload: agent });
    return agent;
  }

  public getAgent(id: string): Agent | null {
    return this.repository.findById(id);
  }

  public listAgents(): Agent[] {
    return this.repository.list();
  }

  public updateAgent(id: string, input: UpdateAgentInput, userRules?: string): Agent {
    const previous = this.repository.findById(id);
    const agent = this.repository.update(id, input);
    const rules = userRules ?? this.profiles.userRules(id);
    this.profiles.writeProfile(agent, rules);
    this.eventBus?.publish({
      eventType: DomainEventType.AGENT_UPDATED,
      agentId: agent.id,
      projectId: agent.projectId,
      oldStatus: input.status === undefined ? undefined : previous?.status,
      newStatus: input.status,
      payload: { changes: input },
    });
    if (input.status !== undefined && input.status !== previous?.status) {
      this.eventBus?.publish({
        eventType: input.status === AgentStatus.BUSY ? DomainEventType.AGENT_LOCKED : DomainEventType.AGENT_UNLOCKED,
        agentId: agent.id,
        oldStatus: previous?.status,
        newStatus: input.status,
      });
    }
    return agent;
  }

  public deleteAgent(id: string): void {
    this.repository.delete(id);
    this.profiles.removeProfile(id);
  }

  public enableAgent(id: string): Agent {
    const agent = this.repository.findById(id);
    if (agent === null) throw new Error(`Agent ${id} was not found`);
    return this.updateAgent(id, {
      enabled: true,
      status: agent.status === AgentStatus.DISABLED ? AgentStatus.IDLE : agent.status,
    });
  }

  public disableAgent(id: string): Agent {
    return this.updateAgent(id, { enabled: false, status: AgentStatus.DISABLED });
  }

  public calculateProfileHash(id: string): string {
    const agent = this.repository.findById(id);
    if (agent === null) throw new Error(`Agent ${id} was not found`);
    return this.profiles.calculateProfileHash(agent);
  }
}
