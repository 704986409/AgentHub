import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileManager, AgentRegistry, AgentStatus, AssignmentManager, Database,
  SqliteAgentRepository, SqliteAssignmentRepository, SqliteProjectRepository, SqliteTaskRepository,
  TaskComplexity, TaskManager, TaskRisk, TaskStateMachine, TaskStatus,
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
});
