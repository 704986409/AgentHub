import type { EventBus, EventStore } from '../events/index.js';
import type { AgentScheduler, AssignmentDispatcher, TaskLifecycleOrchestrator } from '../orchestration/index.js';
import type { AssignmentRepository, ProjectRepository } from '../repositories/index.js';
import type { AgentRegistry, AssignmentManager, TaskManager } from '../services/index.js';
import type { BuildTestEvidencePlan, MergeGatePolicy } from '../workspace/index.js';

/** The single authoritative object graph exposed to transport adapters. */
export interface AgentHubApplication {
  readonly projects: ProjectRepository;
  readonly agents: AgentRegistry;
  readonly tasks: TaskManager;
  readonly assignments: AssignmentManager;
  readonly assignmentQueries: AssignmentRepository;
  readonly events: EventStore;
  readonly eventBus: EventBus;
  readonly scheduler: AgentScheduler;
  readonly dispatcher: AssignmentDispatcher;
  readonly lifecycle: TaskLifecycleOrchestrator;
  readonly buildTestPlan: BuildTestEvidencePlan;
  readonly targetBranch: string;
  readonly mergePolicy?: MergeGatePolicy;
}
