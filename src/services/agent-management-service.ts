import { AgentStatus, type Agent } from '../core/types.js';
import type { ProjectRepository, AssignmentRepository, UpdateAgentInput } from '../repositories/interfaces.js';
import type { AgentPool, AgentPoolRegistration } from '../runtime/AgentPool.js';
import type { AgentProviderFactory } from '../runtime/providers/AgentProviderFactory.js';
import type { AgentRegistry } from './agent-registry.js';
import type { TaskManager } from './task-manager.js';

export interface CreateManagedAgentInput {
  readonly projectId: string | null;
  readonly name: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly position: string;
  readonly allowedComplexities: readonly Agent['allowedComplexities'][number][];
  readonly allowedRiskLevels: readonly Agent['allowedRiskLevels'][number][];
  readonly capabilities: readonly string[];
  readonly specialties: readonly string[];
  readonly authority: Agent['authority'];
  readonly routingPriority: number;
  readonly enabled: boolean;
}

export interface UpdateManagedAgentInput {
  readonly name: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly position: string;
  readonly allowedComplexities: readonly Agent['allowedComplexities'][number][];
  readonly allowedRiskLevels: readonly Agent['allowedRiskLevels'][number][];
  readonly capabilities: readonly string[];
  readonly specialties: readonly string[];
  readonly authority: Agent['authority'];
  readonly routingPriority: number;
}

export interface AgentDeleteResult {
  readonly agentId: string;
  readonly deleted: true;
}

export interface AgentManagementServiceOptions {
  readonly agentRegistry: AgentRegistry;
  readonly agentPool: AgentPool;
  readonly providerFactory: AgentProviderFactory;
  readonly projects: ProjectRepository;
  readonly assignments: AssignmentRepository;
  readonly tasks: TaskManager;
}

export class AgentManagementError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AgentManagementError';
  }
}

export class AgentManagementService {
  readonly #agents: AgentRegistry;
  readonly #pool: AgentPool;
  readonly #providers: AgentProviderFactory;
  readonly #projects: ProjectRepository;
  readonly #assignments: AssignmentRepository;
  readonly #tasks: TaskManager;

  public constructor(options: AgentManagementServiceOptions) {
    this.#agents = options.agentRegistry;
    this.#pool = options.agentPool;
    this.#providers = options.providerFactory;
    this.#projects = options.projects;
    this.#assignments = options.assignments;
    this.#tasks = options.tasks;
  }

  public createAgent(input: CreateManagedAgentInput): Agent {
    if (input.projectId !== null && this.#projects.findById(input.projectId) === null) {
      throw new AgentManagementError('PROJECT_NOT_FOUND', 'Project was not found');
    }
    this.#requireSupportedProvider(input.providerId);
    const agent = this.#agents.createAgent({
      projectId: input.projectId,
      name: input.name,
      provider: input.providerId,
      model: input.modelId,
      position: input.position,
      status: input.enabled ? AgentStatus.IDLE : AgentStatus.DISABLED,
      allowedComplexities: [...input.allowedComplexities],
      allowedRiskLevels: [...input.allowedRiskLevels],
      capabilities: [...input.capabilities],
      specialties: [...input.specialties],
      authority: input.authority,
      routingPriority: input.routingPriority,
      enabled: input.enabled,
    });
    try {
      this.#register(agent);
      return agent;
    } catch (error) {
      this.#compensateCreate(agent.id);
      throw error;
    }
  }

  public updateAgent(agentId: string, input: UpdateManagedAgentInput): Agent {
    const previous = this.#requireAgent(agentId);
    this.#assertRuntimeClean(previous);
    this.#requireSupportedProvider(input.providerId);
    const rebind = previous.provider !== input.providerId || previous.model !== input.modelId;
    const previousRegistered = this.#pool.has(agentId);
    if (rebind && previousRegistered) this.#pool.unregister(agentId);
    try {
      const agent = this.#agents.updateAgent(agentId, this.#toUpdateInput(input));
      if (rebind || !this.#pool.has(agentId)) this.#register(agent);
      return agent;
    } catch (error) {
      this.#restorePrevious(previous);
      if (previousRegistered && !this.#pool.has(agentId)) {
        try { this.#register(previous); } catch { throw reconciliation(); }
      }
      throw error;
    }
  }

  public enableAgent(agentId: string): Agent {
    const agent = this.#requireAgent(agentId);
    this.#requireSupportedProvider(agent.provider);
    if (!this.#pool.has(agentId)) this.#register(agent);
    return this.#agents.enableAgent(agentId);
  }

  public disableAgent(agentId: string): Agent {
    const agent = this.#requireAgent(agentId);
    this.#assertRuntimeClean(agent);
    return this.#agents.disableAgent(agentId);
  }

  public deleteAgent(agentId: string): AgentDeleteResult {
    const previous = this.#requireAgent(agentId);
    this.#assertRuntimeClean(previous);
    if (this.#assignments.list().some((assignment) => assignment.agentId === agentId)) {
      throw new AgentManagementError('AGENT_DELETE_HISTORY_CONFLICT', 'Agent has assignment history');
    }
    if (this.#tasks.listTasks().some((task) => task.assignedAgentId === agentId)) {
      throw new AgentManagementError('AGENT_DELETE_TASK_CONFLICT', 'Agent is referenced by a task');
    }
    const wasRegistered = this.#pool.has(agentId);
    if (wasRegistered) this.#pool.unregister(agentId);
    try {
      this.#agents.deleteAgent(agentId);
    } catch (error) {
      if (wasRegistered && !this.#pool.has(agentId)) {
        try { this.#register(previous); } catch { throw reconciliation(); }
      }
      throw error;
    }
    return { agentId, deleted: true };
  }

  #requireAgent(agentId: string): Agent {
    const agent = this.#agents.getAgent(agentId);
    if (agent === null) throw new AgentManagementError('AGENT_NOT_FOUND', 'Agent was not found');
    return agent;
  }

  #requireSupportedProvider(providerId: string): void {
    if (!this.#providers.has(providerId)) {
      throw new AgentManagementError('AGENT_PROVIDER_UNAVAILABLE', 'Runtime provider is unavailable');
    }
  }

  #assertRuntimeClean(agent: Agent): void {
    if (agent.status === AgentStatus.BUSY) {
      throw new AgentManagementError('AGENT_RUNTIME_BUSY', 'Agent runtime is busy');
    }
    if (!this.#pool.has(agent.id)) return;
    const snapshot = this.#pool.getSnapshot(agent.id);
    if (snapshot.busy || snapshot.active || snapshot.reserved || snapshot.state !== 'IDLE' ||
      snapshot.taskId !== undefined || snapshot.assignmentId !== undefined) {
      throw new AgentManagementError('AGENT_RUNTIME_BUSY', 'Agent runtime is not clean');
    }
  }

  #register(agent: Agent): void {
    const registration: AgentPoolRegistration = {
      agentId: agent.id,
      providerId: agent.provider,
      providerConfig: { model: agent.model },
      ...(agent.projectId === null ? {} : { projectId: agent.projectId }),
    };
    this.#pool.register(registration);
  }

  #toUpdateInput(input: UpdateManagedAgentInput): UpdateAgentInput {
    return {
      name: input.name,
      provider: input.providerId,
      model: input.modelId,
      position: input.position,
      allowedComplexities: [...input.allowedComplexities],
      allowedRiskLevels: [...input.allowedRiskLevels],
      capabilities: [...input.capabilities],
      specialties: [...input.specialties],
      authority: input.authority,
      routingPriority: input.routingPriority,
    };
  }

  #compensateCreate(agentId: string): void {
    try {
      if (this.#pool.has(agentId)) this.#pool.unregister(agentId);
      this.#agents.deleteAgent(agentId);
    } catch {
      throw reconciliation();
    }
  }

  #restorePrevious(previous: Agent): void {
    try {
      this.#agents.updateAgent(previous.id, {
        name: previous.name,
        provider: previous.provider,
        model: previous.model,
        position: previous.position,
        status: previous.status,
        allowedComplexities: [...previous.allowedComplexities],
        allowedRiskLevels: [...previous.allowedRiskLevels],
        capabilities: [...previous.capabilities],
        specialties: [...previous.specialties],
        authority: previous.authority,
        routingPriority: previous.routingPriority,
        enabled: previous.enabled,
      });
    } catch {
      throw reconciliation();
    }
  }
}

function reconciliation(): AgentManagementError {
  return new AgentManagementError(
    'AGENT_REGISTRY_RECONCILIATION_REQUIRED',
    'Agent registry requires reconciliation',
  );
}
