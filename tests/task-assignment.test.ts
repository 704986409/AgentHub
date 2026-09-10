import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentProfileManager,
  AgentRegistry,
  AgentStatus,
  AssignmentManager,
  Database,
  SqliteAgentRepository,
  SqliteAssignmentRepository,
  SqliteProjectRepository,
  SqliteTaskRepository,
  TaskComplexity,
  TaskManager,
  TaskRisk,
  TaskStateMachine,
  TaskStatus,
} from '../src/index.js';

describe('Task and Assignment Engine', () => {
  let database: Database;
  let directory: string;
  let agents: AgentRegistry;
  let tasks: TaskManager;
  let assignments: AssignmentManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-task-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    const profiles = new AgentProfileManager({ agentsDirectory: join(directory, 'data', 'agents') });
    agents = new AgentRegistry(new SqliteAgentRepository(database), profiles);
    tasks = new TaskManager(new SqliteTaskRepository(database));
    assignments = new AssignmentManager(
      new SqliteAssignmentRepository(database),
      tasks,
      agents,
      (agentId) => agents.calculateProfileHash(agentId),
    );
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates a Task with required capabilities, specialties, and acceptance criteria', () => {
    const project = new SqliteProjectRepository(database).create({ name: 'Task project' });
    const task = tasks.createTask({
      projectId: project.id,
      title: 'Build a feature',
      description: 'Implement the feature',
      complexity: TaskComplexity.COMPLEX,
      risk: TaskRisk.MEDIUM,
      requiredCapabilities: ['coding'],
      requiredSpecialties: ['backend'],
      acceptanceCriteria: ['tests pass'],
    });

    expect(task.status).toBe(TaskStatus.CREATED);
    expect(tasks.getTask(task.id)).toEqual(task);
    expect(task.requiredCapabilities).toEqual(['coding']);
    expect(task.requiredSpecialties).toEqual(['backend']);
    expect(task.acceptanceCriteria).toEqual(['tests pass']);
  });

  it('creates an Assignment, records the profile hash, and makes the Agent BUSY when active', () => {
    const project = new SqliteProjectRepository(database).create({ name: 'Assignment project' });
    const agent = agents.createAgent({ name: 'Worker', provider: 'Codex', model: 'm', position: 'Developer' });
    const task = tasks.createTask({
      projectId: project.id,
      title: 'Assigned task',
      complexity: TaskComplexity.SIMPLE,
      risk: TaskRisk.LOW,
    });
    const hash = agents.calculateProfileHash(agent.id);
    const assignment = assignments.createAssignment({ taskId: task.id, agentId: agent.id });

    expect(assignment.status).toBe('DISPATCHING');
    expect(assignment.profileHash).toBe(hash);
    assignments.acceptAssignment(assignment.id);
    assignments.activateAssignment(assignment.id);

    expect(agents.getAgent(agent.id)?.status).toBe(AgentStatus.BUSY);
    expect(tasks.getTask(task.id)?.status).toBe(TaskStatus.IMPLEMENTING);
  });

  it('supports legal task transitions and rejects illegal transitions', () => {
    const machine = new TaskStateMachine();
    expect(machine.transition(TaskStatus.CREATED, TaskStatus.QUEUED)).toBe(TaskStatus.QUEUED);
    expect(machine.transition(TaskStatus.REVIEWING, TaskStatus.COMPLETED)).toBe(TaskStatus.COMPLETED);
    expect(() => machine.transition(TaskStatus.COMPLETED, TaskStatus.IMPLEMENTING)).toThrow(/Invalid task transition/);
  });

  it('returns the Agent to IDLE when an Assignment completes', () => {
    const project = new SqliteProjectRepository(database).create({ name: 'Completion project' });
    const agent = agents.createAgent({ name: 'Worker', provider: 'Codex', model: 'm', position: 'Developer' });
    const task = tasks.createTask({ projectId: project.id, title: 'Complete me', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    const assignment = assignments.createAssignment({ taskId: task.id, agentId: agent.id });
    assignments.acceptAssignment(assignment.id);
    assignments.activateAssignment(assignment.id);
    const completed = assignments.completeAssignment(assignment.id);

    expect(completed.status).toBe('COMPLETED');
    expect(tasks.getTask(task.id)?.status).toBe(TaskStatus.COMPLETED);
    expect(agents.getAgent(agent.id)?.status).toBe(AgentStatus.IDLE);
  });

  it('does not allow a STALE Assignment to be activated again', () => {
    const project = new SqliteProjectRepository(database).create({ name: 'Stale project' });
    const agent = agents.createAgent({ name: 'Worker', provider: 'Codex', model: 'm', position: 'Developer' });
    const task = tasks.createTask({ projectId: project.id, title: 'Stale me', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    const assignment = assignments.createAssignment({ taskId: task.id, agentId: agent.id });
    assignments.markStale(assignment.id);

    expect(() => assignments.activateAssignment(assignment.id)).toThrow(/Only ACCEPTED assignments/);
    expect(agents.getAgent(agent.id)?.status).toBe(AgentStatus.IDLE);
  });
});
