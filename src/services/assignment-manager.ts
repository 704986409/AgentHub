import { AssignmentStatus, AgentStatus, TaskStatus, type Assignment } from '../core/types.js';
import type { AssignmentRepository, CreateAssignmentInput } from '../repositories/interfaces.js';
import type { AgentRegistry } from './agent-registry.js';
import type { TaskManager } from './task-manager.js';
import type { EventBus } from '../events/event-bus.js';
import { DomainEventType } from '../core/types.js';

export class AssignmentManager {
  public constructor(
    private readonly repository: AssignmentRepository,
    private readonly tasks: TaskManager,
    private readonly agents: AgentRegistry,
    private readonly profileHashes: (agentId: string) => string,
    private readonly eventBus?: EventBus,
  ) {}

  public createAssignment(input: Omit<CreateAssignmentInput, 'profileHash' | 'status'> & { profileHash?: string }): Assignment {
    const agent = this.agents.getAgent(input.agentId);
    if (agent === null) throw new Error(`Agent ${input.agentId} was not found`);
    if (!agent.enabled || agent.status !== AgentStatus.IDLE) {
      throw new Error(`Agent ${input.agentId} is not available for assignment`);
    }
    const task = this.tasks.getTask(input.taskId);
    if (task === null) throw new Error(`Task ${input.taskId} was not found`);
    if (task.assignedAgentId !== null) throw new Error(`Task ${input.taskId} is already assigned`);
    if (task.status === TaskStatus.CREATED) this.tasks.transitionTask(task.id, TaskStatus.QUEUED);
    if (this.tasks.getTask(task.id)?.status === TaskStatus.QUEUED) this.tasks.transitionTask(task.id, TaskStatus.ASSIGNED);
    const assignment = this.repository.create({
      ...input,
      profileHash: input.profileHash ?? this.profileHashes(input.agentId),
      status: AssignmentStatus.DISPATCHING,
    });
    this.tasks.updateTask(input.taskId, { assignedAgentId: input.agentId, assignmentId: assignment.id });
    this.eventBus?.publish({
      eventType: DomainEventType.ASSIGNMENT_CREATED,
      assignmentId: assignment.id,
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      payload: assignment,
    });
    return assignment;
  }

  public acceptAssignment(id: string): Assignment {
    const assignment = this.changeStatus(id, AssignmentStatus.ACCEPTED);
    this.eventBus?.publish({
      eventType: DomainEventType.ASSIGNMENT_ACCEPTED,
      assignmentId: assignment.id,
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      oldStatus: AssignmentStatus.DISPATCHING,
      newStatus: assignment.status,
    });
    return assignment;
  }

  public activateAssignment(id: string): Assignment {
    const assignment = this.requireAssignment(id);
    if (assignment.status !== AssignmentStatus.ACCEPTED) {
      throw new Error(`Only ACCEPTED assignments can be activated; got ${assignment.status}`);
    }
    const agent = this.agents.getAgent(assignment.agentId);
    if (agent === null || agent.status !== AgentStatus.IDLE || !agent.enabled) {
      throw new Error(`Agent ${assignment.agentId} is not available for activation`);
    }
    const task = this.tasks.getTask(assignment.taskId);
    if (task === null) throw new Error(`Task ${assignment.taskId} was not found`);
    this.tasks.transitionTask(task.id, TaskStatus.IMPLEMENTING);
    this.agents.updateAgent(agent.id, { status: AgentStatus.BUSY });
    return this.repository.update(id, { status: AssignmentStatus.ACTIVE });
  }

  public completeAssignment(id: string): Assignment {
    const assignment = this.requireAssignment(id);
    if (assignment.status !== AssignmentStatus.ACTIVE) {
      throw new Error(`Only ACTIVE assignments can be completed; got ${assignment.status}`);
    }
    this.tasks.transitionTask(assignment.taskId, TaskStatus.COMPLETED);
    const result = this.repository.update(id, { status: AssignmentStatus.COMPLETED });
    this.releaseAgent(assignment.agentId);
    this.eventBus?.publish({
      eventType: DomainEventType.ASSIGNMENT_COMPLETED,
      assignmentId: result.id,
      taskId: result.taskId,
      agentId: result.agentId,
      oldStatus: AssignmentStatus.ACTIVE,
      newStatus: result.status,
    });
    return result;
  }

  public failAssignment(id: string): Assignment {
    const assignment = this.requireAssignment(id);
    if (assignment.status !== AssignmentStatus.ACTIVE) {
      throw new Error(`Only ACTIVE assignments can fail; got ${assignment.status}`);
    }
    this.tasks.transitionTask(assignment.taskId, TaskStatus.FAILED);
    const result = this.repository.update(id, { status: AssignmentStatus.RELEASED });
    this.releaseAgent(assignment.agentId);
    return result;
  }

  public cancelAssignment(id: string): Assignment {
    const assignment = this.requireAssignment(id);
    if (assignment.status !== AssignmentStatus.ACTIVE && assignment.status !== AssignmentStatus.ACCEPTED) {
      throw new Error(`Only ACCEPTED or ACTIVE assignments can be cancelled; got ${assignment.status}`);
    }
    const task = this.tasks.getTask(assignment.taskId);
    if (task !== null && task.status !== TaskStatus.CANCELLED) this.tasks.transitionTask(task.id, TaskStatus.CANCELLED);
    const result = this.repository.update(id, { status: AssignmentStatus.RELEASED });
    this.releaseAgent(assignment.agentId);
    return result;
  }

  public releaseAssignment(id: string): Assignment {
    const assignment = this.requireAssignment(id);
    if ([AssignmentStatus.COMPLETED, AssignmentStatus.RELEASED, AssignmentStatus.STALE].includes(assignment.status)) {
      throw new Error(`Assignment ${id} cannot be released from ${assignment.status}`);
    }
    const task = this.tasks.getTask(assignment.taskId);
    if (task !== null && task.status !== TaskStatus.CANCELLED) this.tasks.transitionTask(task.id, TaskStatus.QUEUED);
    const result = this.repository.update(id, { status: AssignmentStatus.RELEASED });
    this.releaseAgent(assignment.agentId);
    return result;
  }

  public markStale(id: string): Assignment {
    const assignment = this.requireAssignment(id);
    if ([AssignmentStatus.COMPLETED, AssignmentStatus.RELEASED, AssignmentStatus.STALE].includes(assignment.status)) {
      throw new Error(`Assignment ${id} cannot be marked STALE from ${assignment.status}`);
    }
    const task = this.tasks.getTask(assignment.taskId);
    if (task !== null && task.status !== TaskStatus.CANCELLED) this.tasks.transitionTask(task.id, TaskStatus.QUEUED);
    const result = this.repository.update(id, { status: AssignmentStatus.STALE });
    this.releaseAgent(assignment.agentId);
    return result;
  }

  private changeStatus(id: string, status: AssignmentStatus): Assignment {
    const assignment = this.requireAssignment(id);
    if (status === AssignmentStatus.ACCEPTED && assignment.status !== AssignmentStatus.DISPATCHING) {
      throw new Error(`Only DISPATCHING assignments can be accepted; got ${assignment.status}`);
    }
    return this.repository.update(id, { status });
  }

  private releaseAgent(agentId: string): void {
    const agent = this.agents.getAgent(agentId);
    if (agent?.status === AgentStatus.BUSY) this.agents.updateAgent(agentId, { status: AgentStatus.IDLE });
  }

  private requireAssignment(id: string): Assignment {
    const assignment = this.repository.findById(id);
    if (assignment === null) throw new Error(`Assignment ${id} was not found`);
    return assignment;
  }
}
