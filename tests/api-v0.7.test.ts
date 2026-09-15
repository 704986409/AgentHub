import { once } from 'node:events';

import WebSocket, { type RawData } from 'ws';
import { describe, expect, it } from 'vitest';

import { AgentHubHttpServer, IdempotencyStore, ReviewHandleStore } from '../src/api/index.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { TaskComplexity, TaskRisk, TaskStatus } from '../src/core/types.js';
import { EventBus } from '../src/events/index.js';
import type { TaskReviewBundle } from '../src/orchestration/index.js';

describe('V0.7 local API control plane', () => {
  it('serves bounded loopback HTTP DTOs and rejects invalid input', async () => {
    const bus = new EventBus(); const app = fakeApplication(bus);
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start(); const base = `http://${address.host}:${String(address.port)}`;
    try {
      const health = await fetch(`${base}/api/v1/health`);
      expect(await health.json()).toMatchObject({ ok: true, data: { status: 'ok', version: '0.7.0' } });
      const created = await fetch(`${base}/api/v1/tasks`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' }, body: JSON.stringify({ projectId: 'project-a',
          title: 'API task', complexity: 'SIMPLE', risk: 'LOW' }) });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ ok: true, data: { taskId: 'task-created', projectId: 'project-a' } });
      const invalid = await fetch(`${base}/api/v1/tasks`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid-1' }, body: '{' });
      expect(invalid.status).toBe(400);
      const missing = await fetch(`${base}/api/v1/agents/missing`); expect(missing.status).toBe(404);
    } finally { await server.stop(); }
    expect(() => new AgentHubHttpServer({ application: app, host: '0.0.0.0' })).toThrow();
  });

  it('joins concurrent idempotent requests, caches success, and rejects fingerprint reuse', async () => {
    const store = new IdempotencyStore(); let calls = 0;
    const operation = async () => { calls += 1; await Promise.resolve(); return { value: calls }; };
    const [first, second] = await Promise.all([store.execute('key', 'same', operation),
      store.execute('key', 'same', operation)]);
    expect(first).toEqual({ value: 1 }); expect(second).toEqual(first); expect(calls).toBe(1);
    expect(await store.execute('key', 'same', operation)).toEqual(first); expect(calls).toBe(1);
    await expect(store.execute('key', 'different', operation)).rejects.toMatchObject({ status: 409 });
  });

  it('keeps review bundles server-owned and expires handles', () => {
    const store = new ReviewHandleStore();
    const bundle = { taskId: 'task-a', reviewBundleSha256: 'a'.repeat(64) } as unknown as TaskReviewBundle;
    expect(store.register(bundle)).toBe('a'.repeat(64)); expect(store.resolve('a'.repeat(64))).toBe(bundle);
    store.expire('a'.repeat(64)); expect(() => store.resolve('a'.repeat(64))).toThrowError();
  });

  it('chains execute and review once across HTTP retries without trusting client bundles', async () => {
    const bus = new EventBus(); const app = fakeApplication(bus);
    const counts = { schedule: 0, dispatch: 0, prepare: 0, review: 0 };
    const handle = 'b'.repeat(64); const bundle = reviewBundle(handle);
    Object.assign(app as unknown as Record<string, unknown>, {
      tasks: { listTasks: () => [], getTask: () => ({ id: 'task-created' }), createTask: () => ({}) },
      scheduler: { scheduleTask: () => { counts.schedule += 1; return { outcome: 'reserved' }; } },
      dispatcher: { dispatch: () => { counts.dispatch += 1; return Promise.resolve({}); } },
      lifecycle: {
        prepareReview: () => { counts.prepare += 1; return Promise.resolve({ outcome: 'review-ready', reviewBundle: bundle,
          lifecycleSha256: 'c'.repeat(64) }); },
        applyReview: () => { counts.review += 1; return Promise.resolve({ outcome: 'completed-no-change', taskId: 'task-created',
          lifecycleSha256: 'd'.repeat(64), reviewEvidence: { reviewEvidenceSha256: 'e'.repeat(64) } }); },
      },
    });
    const server = new AgentHubHttpServer({ application: app, port: 0 }); const address = await server.start();
    const base = `http://${address.host}:${String(address.port)}`;
    try {
      const execute = () => fetch(`${base}/api/v1/tasks/task-created/execute`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'execute-once' },
        body: JSON.stringify({ baseRef: 'main', prompt: 'Implement' }) });
      const [one, two] = await Promise.all([execute(), execute()]);
      expect(one.status).toBe(200); expect(await two.json()).toMatchObject({ data: { reviewHandle: handle } });
      expect(counts).toMatchObject({ schedule: 1, dispatch: 1, prepare: 1 });
      const decisionBody = JSON.stringify({ reviewId: 'review-1', reviewerId: 'human', verdict: 'ACCEPT',
        summary: 'Accepted', findings: [], allowNoChangeCompletion: true });
      const decide = () => fetch(`${base}/api/v1/reviews/${handle}/decision`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'review-once' }, body: decisionBody });
      expect((await decide()).status).toBe(200); expect((await decide()).status).toBe(200); expect(counts.review).toBe(1);
      const stale = await fetch(`${base}/api/v1/reviews/${handle}/decision`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'stale-handle' }, body: decisionBody });
      expect(stale.status).toBe(410);
    } finally { await server.stop(); }
  });

  it('streams redacted EventBus events over WebSocket and shuts down cleanly', async () => {
    const bus = new EventBus(); const server = new AgentHubHttpServer({ application: fakeApplication(bus), port: 0 });
    const address = await server.start(); const socket = new WebSocket(`ws://${address.host}:${String(address.port)}/api/v1/realtime`);
    try {
      await once(socket, 'open');
      const eventMessage = new Promise<string>((resolve) => socket.on('message', (raw) => {
        const text = wsText(raw); const parsed = JSON.parse(text) as { type?: string };
        if (parsed.type === 'event') resolve(text);
      }));
      bus.publish({ eventType: 'TaskCreated', taskId: 'task-a', payload: { token: 'do-not-store', safe: 'yes' } });
      const raw = await eventMessage; const value = JSON.parse(raw) as Record<string, unknown>;
      expect(value).toMatchObject({ type: 'event', version: 1 });
      expect(JSON.stringify(value)).not.toContain('do-not-store'); expect(JSON.stringify(value)).toContain('yes');
    } finally { socket.close(); await server.stop(); }
  });
});

function fakeApplication(eventBus: EventBus): AgentHubApplication {
  const project = { id: 'project-a', name: 'Project', description: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const task = { id: 'task-created', projectId: 'project-a', title: 'API task', description: null,
    complexity: TaskComplexity.SIMPLE, risk: TaskRisk.LOW, requiredCapabilities: [], requiredSpecialties: [],
    acceptanceCriteria: [], status: TaskStatus.CREATED, assignedAgentId: null, assignmentId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const empty = () => [];
  return {
    projects: { create: () => project, findById: (id: string) => id === project.id ? project : null, list: () => [project] },
    agents: { listAgents: empty, getAgent: () => null }, tasks: { listTasks: empty, getTask: () => null,
      createTask: () => task }, assignments: {}, assignmentQueries: { list: empty, findById: () => null },
    events: { list: empty }, eventBus, scheduler: {}, dispatcher: {}, lifecycle: {},
    buildTestPlan: { commands: [] }, targetBranch: 'HEAD',
  } as unknown as AgentHubApplication;
}

function wsText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function reviewBundle(handle: string): TaskReviewBundle {
  return {
    version: 1, taskId: 'task-created', projectId: 'project-a', agentId: 'agent-a', assignmentId: 'assignment-a',
    providerId: 'fake', reservationSha256: '1'.repeat(64), dispatchSha256: '2'.repeat(64),
    executionProfileSha256: '3'.repeat(64), taskCommit: {} as never,
    source: { branchName: 'agenthub/task-created', baseCommit: '4'.repeat(40), headCommit: '5'.repeat(40),
      changedPaths: ['src/change.ts'], changes: [], changeSetSha256: '6'.repeat(64),
      sourceVisibilitySha256: '7'.repeat(64), committed: { changedPaths: ['src/change.ts'],
        patch: { status: 'captured', text: 'diff --git a/src/change.ts b/src/change.ts' } },
      uncommitted: { changedPaths: [], patch: { status: 'captured', text: '' } } },
    workerResult: { version: 1, status: 'completed', summary: 'Implemented', blockers: [], questions: [], risks: [], notes: [] },
    buildTestEvidence: { version: 2, taskId: 'task-created', branchName: 'agenthub/task-created',
      baseCommit: '4'.repeat(40), headCommit: '5'.repeat(40), changeSetSha256: '6'.repeat(64),
      sourceVisibilitySha256: '7'.repeat(64), build: 'passed', test: 'passed', outcome: 'passed', commands: [],
      evidenceSha256: '8'.repeat(64) }, reviewBundleSha256: handle,
  } as unknown as TaskReviewBundle;
}
