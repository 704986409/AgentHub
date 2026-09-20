import { describe, expect, it } from 'vitest';

import { AgentHubHttpServer } from '../src/api/index.js';
import type { AgentHubApplication } from '../src/application/index.js';
import { EventBus } from '../src/events/index.js';
import {
  ProviderCatalogService,
  type ProviderDetectorLike,
} from '../src/services/provider-catalog-service.js';

function createMockDetector(installed: boolean, usable: boolean): ProviderDetectorLike {
  return {
    detect: () => ({
      installed,
      usable,
      version: installed ? '1.0.0' : null,
      status: installed && usable ? 'READY' : 'EXECUTABLE_NOT_FOUND',
      models: [],
    }),
  };
}

function fakeApplication(eventBus: EventBus, providerCatalog: ProviderCatalogService): AgentHubApplication {
  const empty = () => [];
  return {
    projects: { list: empty, findById: () => null, create: () => null },
    agents: { listAgents: empty, getAgent: () => null },
    agentManagement: {} as never,
    tasks: { listTasks: empty, getTask: () => null, createTask: () => null },
    assignments: {} as never,
    assignmentQueries: { list: empty, findById: () => null },
    events: { list: empty },
    eventBus,
    scheduler: {} as never,
    dispatcher: {} as never,
    lifecycle: {} as never,
    buildTestPlan: { commands: [] },
    targetBranch: 'main',
    providerCatalog,
  } as unknown as AgentHubApplication;
}

describe('API v0.7.2 Endpoints', () => {
  it('GET /api/v1/health reports package lifecycle version', async () => {
    const bus = new EventBus();
    const catalogService = new ProviderCatalogService({
      claudeDetector: createMockDetector(true, true),
      codexDetector: createMockDetector(true, true),
      cursorDetector: createMockDetector(true, true),
      antigravityDetector: createMockDetector(true, true),
    });
    const app = fakeApplication(bus, catalogService);
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    const base = `http://${address.host}:${String(address.port)}`;

    try {
      const res = await fetch(`${base}/api/v1/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: { status: string; version: string } };
      expect(body.ok).toBe(true);
      expect(body.data.version).toBe('0.7.3F');
    } finally {
      await server.stop();
    }
  }, 5_000);

  it('GET /api/v1/providers serves safe catalog with privacy protection', async () => {
    const bus = new EventBus();
    const catalogService = new ProviderCatalogService({
      claudeDetector: createMockDetector(true, true),
      codexDetector: createMockDetector(true, true),
      cursorDetector: createMockDetector(true, true),
      antigravityDetector: createMockDetector(false, false),
    });
    const app = fakeApplication(bus, catalogService);
    const server = new AgentHubHttpServer({ application: app, port: 0 });
    const address = await server.start();
    const base = `http://${address.host}:${String(address.port)}`;

    try {
      const res = await fetch(`${base}/api/v1/providers`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data: Array<Record<string, unknown>>;
      };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(4);

      const providerIds = body.data.map((p) => p.providerId);
      expect(providerIds).toEqual(['claude', 'codex', 'cursor', 'antigravity']);

      for (const item of body.data) {
        expect(item.supported).toBe(true);
        expect(typeof item.usable).toBe('boolean');
        expect(typeof item.installed).toBe('boolean');
        expect(typeof item.checkedAt).toBe('string');
        expect(item.capabilities).toBeDefined();

        // Privacy check
        expect(item.token).toBeUndefined();
        expect(item.credentials).toBeUndefined();
        expect(item.apiKey).toBeUndefined();
        expect(item.filePath).toBeUndefined();
        expect(item.executablePath).toBeUndefined();
        expect(item.command).toBeUndefined();
        expect(item.env).toBeUndefined();
        expect(item.sessionId).toBeUndefined();
      }
    } finally {
      await server.stop();
    }
  }, 5_000);
});
