import { AgentStatus } from '../core/types.js';
import type { Agent } from '../core/types.js';
import type { AgentRepository, CreateAgentInput, UpdateAgentInput } from '../repositories/interfaces.js';
import type { AgentProfileManager } from './agent-profile-manager.js';

export class AgentRegistry {
  public constructor(
    private readonly repository: AgentRepository,
    private readonly profiles: AgentProfileManager,
  ) {}

  public createAgent(input: CreateAgentInput, userRules = ''): Agent {
    const agent = this.repository.create(input);
    this.profiles.writeProfile(agent, userRules);
    return agent;
  }

  public getAgent(id: string): Agent | null {
    return this.repository.findById(id);
  }

  public listAgents(): Agent[] {
    return this.repository.list();
  }

  public updateAgent(id: string, input: UpdateAgentInput, userRules?: string): Agent {
    const agent = this.repository.update(id, input);
    const rules = userRules ?? this.profiles.userRules(id);
    this.profiles.writeProfile(agent, rules);
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
