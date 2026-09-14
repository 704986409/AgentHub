import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentProfileManager,
  AgentRegistry,
  AssignmentManager,
  Database,
  SqliteAgentRepository,
  SqliteAssignmentRepository,
  SqliteProjectRepository,
  SqliteTaskRepository,
  TaskComplexity,
  TaskManager,
  TaskRisk,
  TaskStatus,
  type Assignment,
  type AssignmentRepository,
} from '../src/index.js';

describe('AssignmentManager scheduler boundary', () => {
  let directory: string;
  let database: Database;
  let agents: AgentRegistry;
  let tasks: TaskManager;
  let projectId: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-assignment-scheduler-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    agents = new AgentRegistry(
      new SqliteAgentRepository(database),
      new AgentProfileManager({ agentsDirectory: join(directory, 'data', 'agents') }),
    );
    tasks = new TaskManager(new SqliteTaskRepository(database));
    projectId = new SqliteProjectRepository(database).create({ name: 'Assignment boundary' }).id;
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('does not transition or claim a task when assignment persistence fails before commit', () => {
    const agent = agents.createAgent({ name: 'Worker' });
    const task = tasks.createTask({
      projectId, title: 'Precommit', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
    });
    const manager = new AssignmentManager(
      new FailingAssignmentRepository(), tasks, agents, () => 'profile-hash',
    );

    expect(() => manager.createAssignment({ id: 'assignment-a', taskId: task.id, agentId: agent.id }))
      .toThrow('precommit failure');
    expect(tasks.getTask(task.id)).toMatchObject({
      status: TaskStatus.CREATED,
      assignedAgentId: null,
      assignmentId: null,
    });
  });

  it('provides a read-only assignment lookup for post-create reconciliation', () => {
    const agent = agents.createAgent({ name: 'Worker' });
    const task = tasks.createTask({
      projectId, title: 'Lookup', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW,
    });
    const manager = new AssignmentManager(
      new SqliteAssignmentRepository(database), tasks, agents, () => 'profile-hash',
    );
    const assignment = manager.createAssignment({ id: 'assignment-a', taskId: task.id, agentId: agent.id });

    expect(manager.getAssignment(assignment.id)).toEqual(assignment);
    expect(manager.getAssignment('missing')).toBeNull();
  });
});

class FailingAssignmentRepository implements AssignmentRepository {
  public create(): Assignment { throw new Error('precommit failure'); }
  public findById(): Assignment | null { return null; }
  public list(): Assignment[] { return []; }
  public update(): Assignment { throw new Error('not implemented'); }
}
