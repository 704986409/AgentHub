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
  let agents: AgentRegistry;
  let tasks: TaskManager;
  let assignments: AssignmentManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-event-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    const bus = new EventBus();
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
});
