import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentProfileManager,
  AgentRegistry,
  AgentStatus,
  AssignmentManager,
  CodexEventMapper,
  CodexProvider,
  Database,
  DomainEventType,
  EventBus,
  EventStore,
  SqliteAgentRepository,
  SqliteAssignmentRepository,
  SqliteEventRepository,
  SqliteProjectRepository,
  SqliteTaskRepository,
  TaskComplexity,
  TaskManager,
  TaskRisk,
  TaskStateMachine,
  TaskStatus,
} from '../src/index.js';

describe('Event Foundation E2E', () => {
  let database: Database;
  let directory: string;
  let eventStore: EventStore;
  let bus: EventBus;
  let agents: AgentRegistry;
  let tasks: TaskManager;
  let assignments: AssignmentManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-event-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    bus = new EventBus();
    eventStore = new EventStore(new SqliteEventRepository(database), bus);
    const profiles = new AgentProfileManager({ agentsDirectory: join(directory, 'data', 'agents') });
    agents = new AgentRegistry(new SqliteAgentRepository(database), profiles, bus);
    tasks = new TaskManager(new SqliteTaskRepository(database), new TaskStateMachine(), bus);
    assignments = new AssignmentManager(
      new SqliteAssignmentRepository(database),
      tasks,
      agents,
      (agentId) => agents.calculateProfileHash(agentId),
      bus,
    );
  });

  afterEach(() => {
    eventStore.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('records the complete agent/task/assignment lifecycle', () => {
    const project = new SqliteProjectRepository(database).create({ name: 'E2E project' });
    const agent = agents.createAgent({ name: 'E2E worker', provider: 'Codex', model: 'm', position: 'Developer' });
    const task = tasks.createTask({
      projectId: project.id,
      title: 'Event-backed task',
      complexity: TaskComplexity.SIMPLE,
      risk: TaskRisk.LOW,
    });
    const assignment = assignments.createAssignment({ taskId: task.id, agentId: agent.id });
    assignments.acceptAssignment(assignment.id);
    assignments.activateAssignment(assignment.id);

    expect(agents.getAgent(agent.id)?.status).toBe(AgentStatus.BUSY);
    expect(tasks.getTask(task.id)?.status).toBe(TaskStatus.IMPLEMENTING);
    tasks.transitionTask(task.id, TaskStatus.REVIEWING);
    assignments.completeAssignment(assignment.id);

    expect(tasks.getTask(task.id)?.status).toBe(TaskStatus.COMPLETED);
    expect(agents.getAgent(agent.id)?.status).toBe(AgentStatus.IDLE);
    expect(assignments).toBeDefined();

    const events = eventStore.list();
    const eventTypes = events.map((event) => event.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        DomainEventType.AGENT_CREATED,
        DomainEventType.AGENT_LOCKED,
        DomainEventType.AGENT_UNLOCKED,
        DomainEventType.TASK_CREATED,
        DomainEventType.TASK_STATUS_CHANGED,
        DomainEventType.ASSIGNMENT_CREATED,
        DomainEventType.ASSIGNMENT_ACCEPTED,
        DomainEventType.ASSIGNMENT_COMPLETED,
      ]),
    );
    const statusEvents = events.filter((event) => event.eventType === 'TaskStatusChanged');
    expect(statusEvents.some((event) => event.oldStatus === 'IMPLEMENTING' && event.newStatus === 'REVIEWING')).toBe(true);
    expect(statusEvents.some((event) => event.oldStatus === 'REVIEWING' && event.newStatus === 'COMPLETED')).toBe(true);
    const completed = events.find((event) => event.eventType === 'AssignmentCompleted');
    expect(completed?.assignmentId).toBe(assignment.id);
    expect(completed?.taskId).toBe(task.id);
    expect(completed?.agentId).toBe(agent.id);
  });

  it('recovers agents, tasks, assignments, and events after restart', () => {
    const path = join(directory, 'agenthub.db');
    const project = new SqliteProjectRepository(database).create({ name: 'Recovery project' });
    const agent = agents.createAgent({ name: 'Persistent worker', provider: 'Codex', model: 'm', position: 'Developer' });
    const task = tasks.createTask({ projectId: project.id, title: 'Persistent task', complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW });
    const assignment = assignments.createAssignment({ taskId: task.id, agentId: agent.id });
    assignments.acceptAssignment(assignment.id);
    assignments.activateAssignment(assignment.id);
    const before = eventStore.list().length;
    eventStore.close();
    database.close();

    database = new Database(path);
    database.initialize();
    const recoveredAgents = new SqliteAgentRepository(database);
    const recoveredTasks = new SqliteTaskRepository(database);
    const recoveredAssignments = new SqliteAssignmentRepository(database);
    const recoveredEvents = new SqliteEventRepository(database);

    expect(recoveredAgents.findById(agent.id)?.status).toBe(AgentStatus.BUSY);
    expect(recoveredTasks.findById(task.id)?.status).toBe(TaskStatus.IMPLEMENTING);
    expect(recoveredAssignments.findById(assignment.id)?.status).toBe('ACTIVE');
    expect(recoveredEvents.list()).toHaveLength(before);
  });

  it('classifies assignment, task, agent, and system events by the most specific entity', () => {
    const project = new SqliteProjectRepository(database).create({ name: 'Classification project' });
    const agent = agents.createAgent({ name: 'Classifier', provider: 'Codex', model: 'm', position: 'Worker' });
    const task = tasks.createTask({
      projectId: project.id,
      title: 'Classification task',
      complexity: TaskComplexity.SIMPLE,
      risk: TaskRisk.LOW,
    });
    const assignment = assignments.createAssignment({ taskId: task.id, agentId: agent.id });

    bus.publish({ eventType: 'AssignmentAudit', agentId: agent.id, taskId: task.id, assignmentId: assignment.id });
    bus.publish({ eventType: 'TaskAudit', agentId: agent.id, taskId: task.id });
    bus.publish({ eventType: 'AgentAudit', agentId: agent.id });
    bus.publish({ eventType: 'SystemAudit' });

    const byType = new Map(eventStore.list().map((event) => [event.eventType, event]));
    expect(byType.get('AssignmentAudit')).toMatchObject({ entityType: 'assignment', entityId: assignment.id });
    expect(byType.get('TaskAudit')).toMatchObject({ entityType: 'task', entityId: task.id });
    expect(byType.get('AgentAudit')).toMatchObject({ entityType: 'agent', entityId: agent.id });
    expect(byType.get('SystemAudit')).toMatchObject({ entityType: 'system', entityId: null });
  });

  it('persists only redacted Codex semantic metadata and ignores stderr diagnostics', () => {
    const observed: unknown[] = [];
    bus.subscribe((event) => observed.push(event.payload));
    const provider = new CodexProvider({ debug: true }, bus);
    const mapper = new CodexEventMapper({ eventBus: bus, source: provider, context: { provider: 'codex' } });
    mapper.attach();
    const secrets = [
      'authorization-secret',
      'token-secret',
      'api-key-secret',
      'nested-secret',
      'password-secret',
      'credential-secret',
      'stderr-secret',
    ];
    provider.client.processManager.emit('stdout', Buffer.from(`${JSON.stringify({
      id: 'sensitive-request',
      method: 'item/permissions/requestApproval',
      params: {
        authorization: 'Bearer authorization-secret',
        token: 'token-secret',
        apiKey: 'api-key-secret',
        nested: { secret: 'nested-secret', password: 'password-secret', credential: 'credential-secret' },
      },
    })}\n`));
    provider.client.processManager.emit('stderr', Buffer.from('secret=stderr-secret\n'));

    const busJson = JSON.stringify(observed);
    const storedEvents = eventStore.list().filter((event) => event.eventType === 'AgentApprovalRequired');
    const storeJson = JSON.stringify(storedEvents);
    const rows = database.connection.prepare(
      `SELECT payload FROM events WHERE event_type = 'AgentApprovalRequired'`,
    ).all() as Array<{ payload: string }>;
    const sqliteJson = JSON.stringify(rows);
    for (const secret of secrets) {
      expect(busJson).not.toContain(secret);
      expect(storeJson).not.toContain(secret);
      expect(sqliteJson).not.toContain(secret);
    }
    expect(storedEvents).toHaveLength(1);
    expect(eventStore.list().some((event) => event.eventType === 'ProviderError')).toBe(false);
    expect(provider.client.diagnostics.snapshot().some((event) => event.type === 'stderr')).toBe(true);
    mapper.dispose();
  });

  it('preserves audit authorship while redacting authorization through EventBus, EventStore, and SQLite', () => {
    const observed: unknown[] = [];
    bus.subscribe((event) => {
      if (event.eventType === 'AgentAudit') observed.push(event.payload);
    });
    const agent = agents.createAgent({ name: 'Audited agent', provider: 'Codex', model: 'm', position: 'Reviewer' });
    bus.publish({
      eventType: 'AgentAudit',
      agentId: agent.id,
      payload: {
        authority: 'ADMIN',
        author: 'Codex',
        authorId: 'author-1',
        authenticationMode: 'oauth',
        authorization: 'Bearer persistence-secret',
      },
    });

    const expectedPayload = {
      authority: 'ADMIN',
      author: 'Codex',
      authorId: 'author-1',
      authenticationMode: 'oauth',
      authorization: '[REDACTED]',
    };
    expect(observed).toContainEqual(expectedPayload);

    const stored = eventStore.list().find((event) => event.eventType === 'AgentAudit');
    expect(stored?.payload).toEqual(expectedPayload);

    const row = database.connection.prepare(
      `SELECT payload FROM events WHERE event_type = 'AgentAudit'`,
    ).get() as { payload: string };
    expect(JSON.parse(row.payload)).toEqual(expectedPayload);
    expect(row.payload).not.toContain('persistence-secret');
  });
});
