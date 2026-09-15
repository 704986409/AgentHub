import { AgentStatus, AssignmentStatus, TaskStatus } from '../../core/types.js';
import type { AgentPool, AgentPoolEntrySnapshot } from '../../runtime/AgentPool.js';
import type { AgentRegistry } from '../../services/agent-registry.js';
import type { AssignmentManager } from '../../services/assignment-manager.js';
import type { TaskManager } from '../../services/task-manager.js';
import type { AssignmentDispatchResult } from '../AssignmentDispatcher.js';
import { lifecycleError, type TaskReviewBundle } from './TaskLifecycleContract.js';

type RuntimeBinding = Pick<AssignmentDispatchResult, 'agentId' | 'assignmentId'>;
type Pool = Pick<AgentPool, 'shutdown' | 'getSnapshot'>;
type Assignments = Pick<AssignmentManager, 'getAssignment'>;
type Tasks = Pick<TaskManager, 'getTask'>;

/** Verifies runtime cleanup and persistent ownership without mutating lifecycle state. */
export class RuntimeGuard {
  readonly #pool: Pool;
  readonly #assignments: Assignments;
  readonly #tasks: Tasks;
  readonly #agents: AgentRegistry;

  public constructor(options: { readonly pool: Pool; readonly assignments: Assignments;
    readonly tasks: Tasks; readonly agents: AgentRegistry }) {
    this.#pool = options.pool;
    this.#assignments = options.assignments;
    this.#tasks = options.tasks;
    this.#agents = options.agents;
  }

  public async shutdown(value: RuntimeBinding): Promise<void> {
    try { await this.#pool.shutdown(value.agentId, value.assignmentId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED'); }
    this.#requireCleanPool(value);
  }

  public requirePersistentAfterShutdown(bundle: TaskReviewBundle): void {
    const assignment = this.#assignments.getAssignment(bundle.assignmentId);
    const task = this.#tasks.getTask(bundle.taskId);
    const agent = this.#agents.getAgent(bundle.agentId);
    let hash: string;
    try { hash = this.#agents.calculateExecutionProfileHash(bundle.agentId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_STALE_PROFILE'); }
    if (assignment === null || assignment.status !== AssignmentStatus.ACTIVE || task === null ||
      task.status !== TaskStatus.REVIEWING || task.assignmentId !== bundle.assignmentId ||
      task.assignedAgentId !== bundle.agentId || agent === null || agent.status !== AgentStatus.BUSY ||
      !agent.enabled || hash !== bundle.executionProfileSha256) throw lifecycleError('TASK_LIFECYCLE_STALE_EXECUTION');
  }

  #requireCleanPool(value: RuntimeBinding): void {
    let pool: Readonly<AgentPoolEntrySnapshot>;
    try { pool = this.#pool.getSnapshot(value.agentId); }
    catch { throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED'); }
    if (pool.state !== 'IDLE' || pool.busy || pool.active || pool.reserved || pool.taskId !== undefined ||
      pool.assignmentId !== undefined || pool.specVersion !== undefined || pool.profileHash !== undefined ||
      pool.sessionId !== undefined) throw lifecycleError('TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED');
  }
}