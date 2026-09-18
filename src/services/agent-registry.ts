import { AgentStatus } from '../core/types.js';
import type { Agent } from '../core/types.js';
import type { AgentRepository, CreateAgentInput, UpdateAgentInput } from '../repositories/interfaces.js';
import type { AgentProfileManager } from './agent-profile-manager.js';
import type { EventBus } from '../events/event-bus.js';
import { DomainEventType } from '../core/types.js';

export interface AgentMutationOptions {
  readonly publishEvents?: boolean;
}

export class AgentRegistry {
  public constructor(
    private readonly repository: AgentRepository,
    private readonly profiles: AgentProfileManager,
    private readonly eventBus?: EventBus,
  ) {}

  public get eventBusInstance(): EventBus | undefined {
    return this.eventBus;
  }

  public createAgent(input: CreateAgentInput, userRules = '', options?: AgentMutationOptions): Agent {
    const agent = this.repository.create(input);
    try {
      this.profiles.writeProfile(agent, userRules);
    } catch (error) {
      try {
        this.repository.delete(agent.id);
      } catch {
        throw reconciliationRequired();
      }
      throw error;
    }
    if (options?.publishEvents !== false) {
      this.eventBus?.publish({ eventType: DomainEventType.AGENT_CREATED, agentId: agent.id, projectId: agent.projectId, payload: agent });
    }
    return agent;
  }

  public getAgent(id: string): Agent | null {
    return this.repository.findById(id);
  }

  public listAgents(): Agent[] {
    return this.repository.list();
  }

  public updateAgent(id: string, input: UpdateAgentInput, userRules?: string, options?: AgentMutationOptions): Agent {
    const previous = this.repository.findById(id);
    if (previous === null) throw new Error(`Agent ${id} was not found`);
    const previousRules = this.profiles.userRules(id);
    const agent = this.repository.update(id, input);
    const rules = userRules ?? previousRules;
    try {
      this.profiles.writeProfile(agent, rules);
    } catch (error) {
      try {
        this.repository.update(id, {
          name: previous.name,
          provider: previous.provider,
          model: previous.model,
          position: previous.position,
          status: previous.status,
          allowedComplexities: previous.allowedComplexities,
          allowedRiskLevels: previous.allowedRiskLevels,
          capabilities: previous.capabilities,
          specialties: previous.specialties,
          authority: previous.authority,
          routingPriority: previous.routingPriority,
          enabled: previous.enabled,
        });
        this.profiles.writeProfile(previous, previousRules);
      } catch {
        throw reconciliationRequired();
      }
      throw error;
    }
    if (options?.publishEvents !== false) {
      this.eventBus?.publish({
        eventType: DomainEventType.AGENT_UPDATED,
        agentId: agent.id,
        projectId: agent.projectId,
        oldStatus: input.status === undefined ? undefined : previous.status,
        newStatus: input.status,
        payload: { changes: input },
      });
      if (input.status !== undefined && input.status !== previous.status) {
        this.eventBus?.publish({
          eventType: input.status === AgentStatus.BUSY ? DomainEventType.AGENT_LOCKED : DomainEventType.AGENT_UNLOCKED,
          agentId: agent.id,
          oldStatus: previous.status,
          newStatus: input.status,
        });
      }
    }
    return agent;
  }

  public deleteAgent(id: string, options?: AgentMutationOptions): void {
    const previous = this.repository.findById(id);
    if (previous === null) throw new Error(`Agent ${id} was not found`);
    let previousRules = '';
    try {
      previousRules = this.profiles.userRules(id);
    } catch {
      previousRules = '';
    }
    this.repository.delete(id);
    try {
      this.profiles.removeProfile(id);
    } catch (error) {
      try {
        this.repository.create({
          id: previous.id,
          projectId: previous.projectId,
          name: previous.name,
          provider: previous.provider,
          model: previous.model,
          position: previous.position,
          status: previous.status,
          allowedComplexities: previous.allowedComplexities,
          allowedRiskLevels: previous.allowedRiskLevels,
          capabilities: previous.capabilities,
          specialties: previous.specialties,
          authority: previous.authority,
          routingPriority: previous.routingPriority,
          enabled: previous.enabled,
        });
        this.profiles.writeProfile(previous, previousRules);
      } catch {
        throw reconciliationRequired();
      }
      throw error;
    }
    if (options?.publishEvents !== false) {
      this.eventBus?.publish({
        eventType: DomainEventType.AGENT_DELETED,
        agentId: previous.id,
        projectId: previous.projectId,
        payload: { deleted: true },
      });
    }
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

  public calculateExecutionProfileHash(id: string): string {
    const agent = this.repository.findById(id);
    if (agent === null) throw new Error(`Agent ${id} was not found`);
    return this.profiles.calculateExecutionProfileHash(agent);
  }
}

function reconciliationRequired(): Error {
  const error = new Error('Agent registry requires reconciliation') as Error & { code: string };
  error.code = 'AGENT_REGISTRY_RECONCILIATION_REQUIRED';
  return error;
}
