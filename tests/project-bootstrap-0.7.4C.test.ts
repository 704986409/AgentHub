import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/AgentHubHttpServer.js';
import type { AgentHubApplication } from '../src/application/AgentHubApplication.js';
import { Database } from '../src/database/database.js';
import { EventBus } from '../src/events/event-bus.js';
import { SqliteProjectRepository } from '../src/repositories/project-repository.js';

interface ProjectBody {
  projectId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

function application(database: Database): AgentHubApplication {
  return {
    projects: new SqliteProjectRepository(database),
    agents: { listAgents: () => [], getAgent: () => null },
    tasks: { listTasks: () => [], getTask: () => null },
    assignmentQueries: { list: () => [], findById: () => null },
    events: { list: () => [] },
    eventBus: new EventBus(),
    buildTestPlan: { commands: [] },
    targetBranch: 'main',
  } as unknown as AgentHubApplication;
}

async function listen(database: Database): Promise<{ base: string; server: AgentHubHttpServer }> {
  const server = new AgentHubHttpServer({ application: application(database), port: 0, database });
  const address = await server.start();
  return { base: `http://${address.host}:${String(address.port)}`, server };
}

describe('0.7.4C project bootstrap API', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* windows lock */ }
    }
  });

  it('creates, replays, rejects conflicts, validates, projects, and survives reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenthub-074c-'));
    directories.push(directory);
    const database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    const first = await listen(database);
    try {
      const empty = await fetch(`${first.base}/api/v1/projects`);
      expect(empty.status).toBe(200);
      expect(((await empty.json()) as { data: unknown[] }).data).toEqual([]);

      const created = await fetch(`${first.base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'project-create-1' },
        body: JSON.stringify({ name: 'AgentHub PRE E2E Project', description: 'Project created from Desktop.' }),
      });
      expect(created.status).toBe(201);
      const project = ((await created.json()) as { data: ProjectBody }).data;
      expect(project.projectId.trim().length).toBeGreaterThan(0);
      expect(project.name).toBe('AgentHub PRE E2E Project');
      expect(project.description).toBe('Project created from Desktop.');
      expect(Number.isNaN(Date.parse(project.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(project.updatedAt))).toBe(false);

      const listed = ((await (await fetch(`${first.base}/api/v1/projects`)).json()) as { data: ProjectBody[] }).data;
      expect(listed).toHaveLength(1);
      expect(listed[0]?.projectId).toBe(project.projectId);

      const state = ((await (await fetch(`${first.base}/api/v1/state`)).json()) as { data: { projects: ProjectBody[] } }).data;
      expect(state.projects.map((item) => item.projectId)).toEqual([project.projectId]);

      const replay = await fetch(`${first.base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'project-create-1' },
        body: JSON.stringify({ name: 'AgentHub PRE E2E Project', description: 'Project created from Desktop.' }),
      });
      expect(replay.status).toBe(201);
      expect(((await replay.json()) as { data: ProjectBody }).data.projectId).toBe(project.projectId);
      expect(((await (await fetch(`${first.base}/api/v1/projects`)).json()) as { data: unknown[] }).data).toHaveLength(1);

      const conflict = await fetch(`${first.base}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'project-create-1' },
        body: JSON.stringify({ name: 'Other', description: 'Project created from Desktop.' }),
      });
      expect(conflict.status).toBe(409);
      expect(((await (await fetch(`${first.base}/api/v1/projects`)).json()) as { data: unknown[] }).data).toHaveLength(1);

      const invalidBodies = [
        { description: null },
        { name: '   ', description: null },
        { name: 'Valid', description: 1 },
        { name: 'Valid', description: null, projectId: 'client-id' },
        { name: 'x'.repeat(257), description: null },
      ];
      for (const [index, body] of invalidBodies.entries()) {
        const rejected = await fetch(`${first.base}/api/v1/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `invalid-${String(index)}` },
          body: JSON.stringify(body),
        });
        expect(rejected.status).toBe(400);
      }
      expect(((await (await fetch(`${first.base}/api/v1/projects`)).json()) as { data: unknown[] }).data).toHaveLength(1);
    } finally {
      await first.server.stop();
      database.close();
    }

    const reopened = new Database(join(directory, 'agenthub.db'));
    reopened.initialize();
    const second = await listen(reopened);
    try {
      const listed = ((await (await fetch(`${second.base}/api/v1/projects`)).json()) as { data: ProjectBody[] }).data;
      expect(listed).toHaveLength(1);
      expect(listed[0]?.name).toBe('AgentHub PRE E2E Project');
      expect(listed[0]?.projectId.trim().length).toBeGreaterThan(0);
    } finally {
      await second.server.stop();
      reopened.close();
    }
  });
});
