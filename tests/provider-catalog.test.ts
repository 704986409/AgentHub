import { describe, expect, it } from 'vitest';

import {
  ProviderCatalogService,
  type ProviderDetectorLike,
  type ProviderModelDto,
} from '../src/index.js';

function createMockDetector(installed: boolean, usable: boolean, models: ProviderModelDto[] = []): ProviderDetectorLike {
  return {
    detect: () => ({
      installed,
      usable,
      version: installed ? '1.0.0' : null,
      status: installed && usable ? 'READY' : 'EXECUTABLE_NOT_FOUND',
      models,
    }),
  };
}

describe('ProviderCatalogService', () => {
  it('returns all 4 providers marked supported=true with correct privacy boundaries', async () => {
    const service = new ProviderCatalogService({
      claudeDetector: createMockDetector(true, true),
      codexDetector: createMockDetector(true, true),
      cursorDetector: createMockDetector(true, true, [{ modelId: 'cursor-fast', label: 'Cursor Fast' }]),
      antigravityDetector: createMockDetector(false, false),
    });

    const catalog = await service.getCatalog();
    expect(catalog).toHaveLength(4);

    const providerIds = catalog.map((p) => p.providerId);
    expect(providerIds).toEqual(['claude', 'codex', 'cursor', 'antigravity']);

    for (const provider of catalog) {
      expect(provider.supported).toBe(true);
      expect(typeof provider.usable).toBe('boolean');
      expect(typeof provider.installed).toBe('boolean');
      expect(typeof provider.checkedAt).toBe('string');

      // Privacy boundary checks: strict absence of sensitive fields
      const p = provider as unknown as Record<string, unknown>;
      expect(p.filePath).toBeUndefined();
      expect(p.executablePath).toBeUndefined();
      expect(p.command).toBeUndefined();
      expect(p.env).toBeUndefined();
      expect(p.apiKey).toBeUndefined();
      expect(p.token).toBeUndefined();
      expect(p.credentials).toBeUndefined();
      expect(p.sessionId).toBeUndefined();
    }

    const cursor = catalog.find((p) => p.providerId === 'cursor');
    expect(cursor?.usable).toBe(true);
    expect(cursor?.modelDiscovery).toBe('native');
    expect(cursor?.models).toEqual([{ modelId: 'cursor-fast', label: 'Cursor Fast' }]);

    const antigravity = catalog.find((p) => p.providerId === 'antigravity');
    expect(antigravity?.usable).toBe(false);
    expect(antigravity?.installed).toBe(false);
  }, 5_000);

  it('respects TTL cache and refreshes on forceRefresh', async () => {
    let claudeCallCount = 0;
    const trackingClaudeDetector: ProviderDetectorLike = {
      detect: () => {
        claudeCallCount += 1;
        return {
          installed: true,
          usable: true,
          version: '1.0.0',
          status: 'READY',
        };
      },
    };

    const service = new ProviderCatalogService({
      claudeDetector: trackingClaudeDetector,
      codexDetector: createMockDetector(true, true),
      cursorDetector: createMockDetector(true, true),
      antigravityDetector: createMockDetector(true, true),
      ttlMs: 5_000,
    });

    expect(claudeCallCount).toBe(0);

    // Call 1: cold cache -> calls detect
    await service.getCatalog();
    expect(claudeCallCount).toBe(1);

    // Call 2: within TTL -> served from cache
    await service.getCatalog();
    expect(claudeCallCount).toBe(1);

    // Call 3: forceRefresh -> bypasses cache
    await service.getCatalog(true);
    expect(claudeCallCount).toBe(2);
  }, 5_000);

  it('coalesces concurrent requests into a single probing pass', async () => {
    let cursorProbeCount = 0;
    const cursorDetector: ProviderDetectorLike = {
      detect: () => {
        cursorProbeCount += 1;
        return {
          installed: true,
          usable: true,
          version: '2.0.0',
          status: 'READY',
        };
      },
    };

    const service = new ProviderCatalogService({
      claudeDetector: createMockDetector(true, true),
      codexDetector: createMockDetector(true, true),
      cursorDetector,
      antigravityDetector: createMockDetector(true, true),
    });

    const [cat1, cat2, cat3] = await Promise.all([
      service.getCatalog(),
      service.getCatalog(),
      service.getCatalog(),
    ]);

    expect(cat1).toBe(cat2);
    expect(cat2).toBe(cat3);
    expect(cursorProbeCount).toBe(1);
  }, 5_000);

  it('provides synchronous usability checking with isUsableSync', () => {
    const service = new ProviderCatalogService({
      claudeDetector: createMockDetector(true, true),
      codexDetector: createMockDetector(true, true),
      cursorDetector: createMockDetector(true, false),
      antigravityDetector: createMockDetector(false, false),
    });

    expect(service.isUsableSync('claude')).toBe(true);
    expect(service.isUsableSync('codex')).toBe(true);
    expect(service.isUsableSync('cursor')).toBe(false);
    expect(service.isUsableSync('antigravity')).toBe(false);
    expect(service.isUsableSync('unknown-provider')).toBe(false);
  }, 5_000);
});
