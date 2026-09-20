import type { EventBus, EventStore } from '../events/index.js';
import type { AgentScheduler, AssignmentDispatcher, TaskLifecycleOrchestrator } from '../orchestration/index.js';
import type { AssignmentRepository, ProjectRepository } from '../repositories/index.js';
import type { AgentManagementService, AgentRegistry, AssignmentManager, ProviderCatalogService, TaskManager } from '../services/index.js';
import type { BuildTestEvidencePlan, MergeGatePolicy } from '../workspace/index.js';
import type { PlanLifecycleService } from '../lifecycle/plan-lifecycle.js';
import type { PlanExecutionCoordinator } from '../lifecycle/plan-execution-coordinator.js';
import type { ReviewTransitionCoordinator } from '../lifecycle/review-transition-coordinator.js';
import type { ReviewHandleStore } from '../api/ReviewHandleStore.js';

/** The single authoritative object graph exposed to transport adapters. */
export interface AgentHubApplication {
  readonly projects: ProjectRepository;
  readonly agents: AgentRegistry;
  readonly agentManagement: AgentManagementService;
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
  readonly providerCatalog?: ProviderCatalogService;
  readonly mergePolicy?: MergeGatePolicy;
  readonly planLifecycle?: PlanLifecycleService;
  readonly planExecution?: PlanExecutionCoordinator;
  readonly reviews?: ReviewHandleStore;
  readonly reviewTransitions?: ReviewTransitionCoordinator;
}
