import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentAuthority,
  AgentCapability,
  AgentStatus,
  AssignmentStatus,
  Database,
  SqliteAgentRepository,
  SqliteAssignmentRepository,
  SqliteEventRepository,
  SqliteProjectRepository,
  SqliteTaskRepository,
  TaskComplexity,
  TaskRisk,
  TaskStatus,
} from '../src/index.js';

describe('core data foundation', () => {
  let directory: string;
  let path: string;
  let database: Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-'));
    path = join(directory, 'agenthub.db');
    database = new Database(path);
    database.initialize();
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('initializes the database and applies migrations idempotently', () => {
    expect(database.migrationManager.currentVersion()).toBe(3);
    database.initialize();
    expect(database.migrationManager.currentVersion()).toBe(3);

    const tables = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(['agents', 'assignments', 'events', 'projects', 'schema_migrations', 'settings', 'tasks']),
    );
  });

  it('inserts and queries records through repositories', () => {
    const projects = new SqliteProjectRepository(database);
    const agents = new SqliteAgentRepository(database);
    const tasks = new SqliteTaskRepository(database);
    const assignments = new SqliteAssignmentRepository(database);
    const events = new SqliteEventRepository(database);

    const project = projects.create({ name: 'AgentHub' });
    const agent = agents.create({
      projectId: project.id,
      name: 'Builder',
      status: AgentStatus.IDLE,
      capabilities: [AgentCapability.CODING, AgentCapability.REVIEW],
      authority: AgentAuthority.STANDARD,
    });
    const task = tasks.create({
      projectId: project.id,
      title: 'Create data layer',
      status: TaskStatus.PENDING,
      complexity: TaskComplexity.MEDIUM,
      risk: TaskRisk.LOW,
    });
    const assignment = assignments.create({
      taskId: task.id,
      agentId: agent.id,
      status: AssignmentStatus.ACCEPTED,
    });
    const event = events.create({
      projectId: project.id,
      entityType: 'task',
      entityId: task.id,
      eventType: 'task.created',
      payload: { taskId: task.id },
    });

    expect(projects.findById(project.id)).toEqual(project);
    expect(agents.findById(agent.id)).toEqual(agent);
    expect(tasks.findById(task.id)).toEqual(task);
    expect(assignments.findById(assignment.id)).toEqual(assignment);
    expect(events.findById(event.id)).toEqual(event);
  });

  it('persists data after the database is closed and reopened', () => {
    const project = new SqliteProjectRepository(database).create({ name: 'Persistent project' });
    database.close();

    database = new Database(path);
    database.initialize();

    expect(new SqliteProjectRepository(database).findById(project.id)).toEqual(project);
  });

  it('rejects invalid enum values at repository and schema boundaries', () => {
    const projects = new SqliteProjectRepository(database);
    const tasks = new SqliteTaskRepository(database);
    const project = projects.create({ name: 'Validation' });

    expect(() =>
      tasks.create({
        projectId: project.id,
        title: 'Invalid task',
        complexity: 'LOW' as TaskComplexity,
        risk: TaskRisk.LOW,
      }),
    ).toThrow(/complexity has an invalid value/);

    expect(() =>
      database.connection
        .prepare(`INSERT INTO tasks
          (id, project_id, title, status, complexity, risk, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('invalid', project.id, 'Invalid task', 'UNKNOWN', 'SIMPLE', 'LOW', 'now', 'now'),
    ).toThrow();
  });
});
