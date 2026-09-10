import { describe, expect, it } from 'vitest';

import { CodexManagerUseCase, CodexProvider } from '../src/index.js';

interface LifecycleCounts {
  notification: number;
  serverRequest: number;
  protocolError: number;
  processExit: number;
  processError: number;
}

describe('Manager use-case subscription lifecycle', () => {
  it('delivers each Provider event only to the active use-case after repeated dispose cycles', () => {
    const provider = new CodexProvider();
    const disposedCounts: LifecycleCounts[] = [];

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const useCase = new CodexManagerUseCase(provider);
      const counts = createCounts();
      subscribe(useCase, counts);
      useCase.dispose();
      disposedCounts.push(counts);
    }

    const active = new CodexManagerUseCase(provider);
    const activeCounts = createCounts();
    subscribe(active, activeCounts);

    provider.client.processManager.emit('stdout', Buffer.from(
      '{"method":"fixture/notification","params":{"threadId":"thread-1","turnId":"turn-1"}}\n',
    ));
    provider.client.processManager.emit('stdout', Buffer.from(
      '{"id":"request-1","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1"}}\n',
    ));
    provider.client.processManager.emit('stdout', Buffer.from('{malformed}\n'));
    provider.client.processManager.emit('exit', { code: 7, signal: null });
    provider.client.processManager.emit('error', new Error('fixture process error'));

    expect(disposedCounts).toEqual([createCounts(), createCounts(), createCounts()]);
    expect(activeCounts).toEqual({
      notification: 1,
      serverRequest: 1,
      protocolError: 1,
      processExit: 1,
      processError: 1,
    });
    active.dispose();
  });
});

function createCounts(): LifecycleCounts {
  return { notification: 0, serverRequest: 0, protocolError: 0, processExit: 0, processError: 0 };
}

function subscribe(useCase: CodexManagerUseCase, counts: LifecycleCounts): void {
  useCase.onNotification(() => { counts.notification += 1; });
  useCase.onServerRequest(() => { counts.serverRequest += 1; });
  useCase.onProtocolError(() => { counts.protocolError += 1; });
  useCase.onProcessExit(() => { counts.processExit += 1; });
  useCase.onProcessError(() => { counts.processError += 1; });
}
