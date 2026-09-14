import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileManager, AgentRegistry, AgentStatus, AssignmentManager, Database,
  SqliteAgentRepository, SqliteAssignmentRepository, SqliteProjectRepository, SqliteTaskRepository,
  AssignmentStatus, TaskComplexity, TaskManager, TaskRisk, TaskStateMachine, TaskStatus,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function active() {
  const root = mkdtempSync(join(tmpdir(), 'agenthub-assignment-life-'));
  roots.push(root);
  const database = new Database(join(root, 'db.sqlite'));
  database.initialize();
  const agents = new AgentRegistry(new SqliteAgentRepository(database), new AgentProfileManager({ agentsDirectory: join(root, 'agents') }));
  const tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine());
  const assignments = new AssignmentManager(new SqliteAssignmentRepository(database), tasks, agents,
    (agentId) => agents.calculateProfileHash(agentId));
  const projectId = new SqliteProjectRepository(database).create({ name: 'Lifecycle' }).id;
  const agent = agents.createAgent({ projectId, name: 'Worker', provider: 'fake', model: 'm', position: 'Developer' });
  const task = tasks.createTask({ projectId, title: 'Task', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
  const assignment = assignments.createAssignment({ taskId: task.id, agentId: agent.id });
  assignments.acceptAssignment(assignment.id);
  assignments.activateAssignment(assignment.id);
  return { database, agents, tasks, assignments, agent, task, assignment };
}

describe('AssignmentManager lifecycle convergence', () => {
  it.each([TaskStatus.BLOCKED, TaskStatus.WAITING_INPUT] as const)('suspends to %s idempotently and clears pointers', (status) => {
    const h = active();
    const first = h.assignments.suspendActiveAssignment(h.assignment.id, status);
    const second = h.assignments.suspendActiveAssignment(h.assignment.id, status);
    expect(first.status).toBe('RELEASED');
    expect(second.status).toBe('RELEASED');
    expect(h.tasks.getTask(h.task.id)).toMatchObject({ status, assignedAgentId: null, assignmentId: null });
    expect(h.agents.getAgent(h.agent.id)?.status).toBe(AgentStatus.IDLE);
    h.database.close();
  });

  it('finalizes failure idempotently and clears pointers', () => {
    const h = active();
    expect(h.assignments.finalizeFailedAssignment(h.assignment.id).status).toBe('RELEASED');
    expect(h.assignments.finalizeFailedAssignment(h.assignment.id).status).toBe('RELEASED');
    expect(h.tasks.getTask(h.task.id)).toMatchObject({ status: 'FAILED', assignedAgentId: null, assignmentId: null });
    expect(h.agents.getAgent(h.agent.id)?.status).toBe(AgentStatus.IDLE);
    h.database.close();
  });

  it('finalizes completion idempotently and clears pointers', () => {
    const h = active();
    expect(h.assignments.finalizeCompletedAssignment(h.assignment.id).status).toBe('COMPLETED');
    expect(h.assignments.finalizeCompletedAssignment(h.assignment.id).status).toBe('COMPLETED');
    expect(h.tasks.getTask(h.task.id)).toMatchObject({ status: 'COMPLETED', assignedAgentId: null, assignmentId: null });
    expect(h.agents.getAgent(h.agent.id)?.status).toBe(AgentStatus.IDLE);
    h.database.close();
  });


  it.each([
    ['suspend', AssignmentStatus.RELEASED, TaskStatus.BLOCKED],
    ['fail', AssignmentStatus.RELEASED, TaskStatus.FAILED],
    ['complete', AssignmentStatus.COMPLETED, TaskStatus.COMPLETED],
  ] as const)('fails closed when historical %s convergence sees same-agent live ownership', (operation, oldStatus, oldTaskStatus) => {
    const h = active();
    h.database.connection.prepare('UPDATE assignments SET status = ? WHERE id = ?').run(oldStatus, h.assignment.id);
    h.tasks.transitionTask(h.task.id, oldTaskStatus);
    h.tasks.updateTask(h.task.id, { assignedAgentId: null, assignmentId: null });
    const newTask = h.tasks.createTask({ projectId: h.task.projectId, title: 'New task',
      complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    const newerId = `${h.assignment.id}-new-owner`;
    const now = new Date().toISOString();
    h.database.connection.prepare(`INSERT INTO assignments
      (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(newerId, newTask.id, h.agent.id, '1.0.0', 'new-profile',
      AssignmentStatus.ACTIVE, now, now);
    h.tasks.updateTask(newTask.id, { assignedAgentId: h.agent.id, assignmentId: newerId });
    h.agents.updateAgent(h.agent.id, { status: AgentStatus.BUSY });
    const beforeTask = h.tasks.getTask(h.task.id);
    const beforeNewTask = h.tasks.getTask(newTask.id);
    const beforeNewer = h.assignments.getAssignment(newerId);
    const beforeAgent = h.agents.getAgent(h.agent.id);
    const invoke = () => operation === 'complete'
      ? h.assignments.finalizeCompletedAssignment(h.assignment.id)
      : operation === 'fail'
        ? h.assignments.finalizeFailedAssignment(h.assignment.id)
        : h.assignments.suspendActiveAssignment(h.assignment.id, TaskStatus.BLOCKED);
    expect(invoke).toThrow(/owned by another live assignment/u);
    expect(h.tasks.getTask(h.task.id)).toEqual(beforeTask);
    expect(h.tasks.getTask(newTask.id)).toEqual(beforeNewTask);
    expect(h.assignments.getAssignment(newerId)).toEqual(beforeNewer);
    expect(h.agents.getAgent(h.agent.id)).toEqual(beforeAgent);
    h.database.close();
  });

  it.each([
    ['suspend', AssignmentStatus.RELEASED],
    ['fail', AssignmentStatus.STALE],
    ['complete', AssignmentStatus.COMPLETED],
  ] as const)('rejects non-active %s convergence when the task has not reached its target', (operation, oldStatus) => {
    const h = active();
    h.database.connection.prepare('UPDATE assignments SET status = ? WHERE id = ?').run(oldStatus, h.assignment.id);
    const beforeTask = h.tasks.getTask(h.task.id);
    const beforeAgent = h.agents.getAgent(h.agent.id);
    const invoke = () => operation === 'complete'
      ? h.assignments.finalizeCompletedAssignment(h.assignment.id)
      : operation === 'fail'
        ? h.assignments.finalizeFailedAssignment(h.assignment.id)
        : h.assignments.suspendActiveAssignment(h.assignment.id, TaskStatus.BLOCKED);
    expect(invoke).toThrow(/contradictory assignment pointers/u);
    expect(h.assignments.getAssignment(h.assignment.id)?.status).toBe(oldStatus);
    expect(h.tasks.getTask(h.task.id)).toEqual(beforeTask);
    expect(h.agents.getAgent(h.agent.id)).toEqual(beforeAgent);
    h.database.close();
  });
  it.each([
    ['suspend', AssignmentStatus.RELEASED],
    ['fail', AssignmentStatus.RELEASED],
    ['complete', AssignmentStatus.COMPLETED],
  ] as const)('rejects stale %s convergence before mutating a newer assignment lineage', (operation, oldStatus) => {
    const h = active();
    const newerAgent = h.agents.createAgent({ projectId: h.agent.projectId, name: 'New Worker', provider: 'fake',
      model: 'm', position: 'Developer' });
    const newerId = `${h.assignment.id}-new`;
    const now = new Date().toISOString();
    h.database.connection.prepare('UPDATE assignments SET status = ? WHERE id = ?').run(oldStatus, h.assignment.id);
    h.database.connection.prepare(`INSERT INTO assignments
      (id, task_id, agent_id, spec_version, profile_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(newerId, h.task.id, newerAgent.id, '1.0.0', 'new-profile',
      AssignmentStatus.ACTIVE, now, now);
    h.tasks.updateTask(h.task.id, { assignedAgentId: newerAgent.id, assignmentId: newerId });
    h.agents.updateAgent(newerAgent.id, { status: AgentStatus.BUSY });
    const beforeTask = h.tasks.getTask(h.task.id);
    const beforeNewer = h.assignments.getAssignment(newerId);
    const beforeAgent = h.agents.getAgent(newerAgent.id);
    const invoke = () => operation === 'complete'
      ? h.assignments.finalizeCompletedAssignment(h.assignment.id)
      : operation === 'fail'
        ? h.assignments.finalizeFailedAssignment(h.assignment.id)
        : h.assignments.suspendActiveAssignment(h.assignment.id, TaskStatus.BLOCKED);
    expect(invoke).toThrow(/contradictory assignment pointers/u);
    expect(h.assignments.getAssignment(h.assignment.id)?.status).toBe(oldStatus);
    expect(h.tasks.getTask(h.task.id)).toEqual(beforeTask);
    expect(h.assignments.getAssignment(newerId)).toEqual(beforeNewer);
    expect(h.agents.getAgent(newerAgent.id)).toEqual(beforeAgent);
    h.database.close();
  });
});
