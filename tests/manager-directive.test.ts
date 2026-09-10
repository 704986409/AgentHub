import { describe, expect, it } from 'vitest';

import {
  CodexManagerDirectiveRunner,
  ManagerDirectiveParser,
  type CodexDirectiveTurnExecutor,
  type CodexTurnRequest,
  type CodexTurnResult,
  type ManagerDirective,
  type ManagerDirectiveAction,
} from '../src/index.js';

const parser = new ManagerDirectiveParser();
const validDirectiveCases: Array<[ManagerDirectiveAction, Partial<ManagerDirective>]> = [
  ['DELEGATE', { instructions: 'Implement it.', acceptanceCriteria: ['Tests pass'] }],
  ['REQUEST_REVISION', { issues: ['A test is missing'] }],
  ['ACCEPT', { summary: 'All acceptance criteria passed.' }],
  ['BLOCK', { summary: 'Required dependency is unavailable.' }],
  ['INFORM', { summary: 'Status update.' }],
];

describe('Manager Directive parser', () => {
  it.each(validDirectiveCases)('parses a valid %s directive', (action, overrides) => {
    const result = parser.parse(block(createDirective({ action, ...overrides })));
    expect(result).toMatchObject({ success: true, directive: { action, taskId: 'TASK-1' } });
  });

  it('allows prose outside the single tagged control block', () => {
    const text = `Summary before\n${block(createDirective({ action: 'INFORM', summary: 'Done.' }))}\nSummary after`;
    expect(parser.parse(text)).toMatchObject({ success: true, directive: { action: 'INFORM' } });
  });

  it.each([
    ['no opening tag', '{"action":"INFORM"}', 'missing_directive'],
    ['no closing tag', '<AGENTHUB_DIRECTIVE>{}', 'missing_directive'],
    ['empty block', '<AGENTHUB_DIRECTIVE>  </AGENTHUB_DIRECTIVE>', 'malformed_json'],
    ['malformed JSON', '<AGENTHUB_DIRECTIVE>{bad}</AGENTHUB_DIRECTIVE>', 'malformed_json'],
    ['missing fields', block({ action: 'INFORM' }), 'schema_invalid'],
    ['invalid action', block({ ...createDirective(), action: 'DO_SOMETHING' }), 'schema_invalid'],
    ['multiple blocks', `${block(createDirective())}${block(createDirective())}`, 'multiple_directives'],
    ['blank delegate instructions', block(createDirective({ action: 'DELEGATE', instructions: '', acceptanceCriteria: ['Pass'] })), 'semantic_invalid'],
    ['empty delegate criteria', block(createDirective({ action: 'DELEGATE', instructions: 'Do it', acceptanceCriteria: [] })), 'semantic_invalid'],
    ['revision without issues', block(createDirective({ action: 'REQUEST_REVISION', issues: [] })), 'semantic_invalid'],
    ['accept without summary', block(createDirective({ action: 'ACCEPT', summary: ' ' })), 'semantic_invalid'],
    ['block without reason', block(createDirective({ action: 'BLOCK', summary: '', issues: [] })), 'semantic_invalid'],
  ])('classifies %s as %s', (_name, text, expectedKind) => {
    expect(parser.parse(text)).toMatchObject({ success: false, failure: { kind: expectedKind } });
  });
});

describe('Manager Directive repair', () => {
  it.each([
    ['missing block', 'plain response'],
    ['malformed JSON', '<AGENTHUB_DIRECTIVE>{bad}</AGENTHUB_DIRECTIVE>'],
    ['schema invalid', block({ action: 'INFORM' })],
  ])('repairs %s exactly once on the same thread', async (_name, initialText) => {
    const executor = new QueueTurnExecutor([
      completedTurn('turn-1', initialText),
      completedTurn('turn-2', block(createDirective({ action: 'INFORM', taskId: 'REPAIRED', summary: 'OK' }))),
    ]);
    const result = await new CodexManagerDirectiveRunner(executor).run({ prompt: 'original request' });

    expect(result).toMatchObject({
      directiveStatus: 'repaired',
      directive: { action: 'INFORM', taskId: 'REPAIRED', summary: 'OK' },
      initialTurn: { threadId: 'thread-1', turnId: 'turn-1' },
      repairTurn: { threadId: 'thread-1', turnId: 'turn-2' },
    });
    expect(executor.requests).toHaveLength(2);
    expect(executor.requests[1]?.prompt).toContain('Validation error');
    expect(executor.requests[1]?.prompt).not.toContain('original request');
  });

  it('returns invalid after one failed repair and never attempts a second repair', async () => {
    const executor = new QueueTurnExecutor([
      completedTurn('turn-1', 'no directive'),
      completedTurn('turn-2', 'still no directive'),
    ]);
    const result = await new CodexManagerDirectiveRunner(executor).run({ prompt: 'request' });
    expect(result).toMatchObject({
      directiveStatus: 'invalid',
      directive: null,
      failure: { kind: 'missing_directive' },
    });
    expect(executor.requests).toHaveLength(2);
  });

  it.each([
    ['timeout', failedTurn('turn-2', 'timeout', 'timeout')],
    ['process exit', failedTurn('turn-2', 'failed', 'process_exit')],
  ])('returns a structured failure when the repair turn ends with %s', async (_name, repairTurn) => {
    const executor = new QueueTurnExecutor([completedTurn('turn-1', 'no directive'), repairTurn]);
    const result = await new CodexManagerDirectiveRunner(executor).run({ prompt: 'request' });
    expect(result).toMatchObject({
      directiveStatus: 'invalid',
      directive: null,
      failure: { kind: 'repair_turn_failed' },
    });
    expect(executor.requests).toHaveLength(2);
  });

  it('keeps an initial turn failure separate from a directive parsing failure', async () => {
    const executor = new QueueTurnExecutor([failedTurn('turn-1', 'upstream_unavailable', 'upstream_unavailable')]);
    const result = await new CodexManagerDirectiveRunner(executor).run({ prompt: 'request' });
    expect(result).toMatchObject({
      initialTurn: { status: 'upstream_unavailable' },
      directiveStatus: 'invalid',
      failure: { kind: 'initial_turn_failed' },
    });
    expect(executor.requests).toHaveLength(1);
  });
});

class QueueTurnExecutor implements CodexDirectiveTurnExecutor {
  readonly requests: CodexTurnRequest[] = [];

  public constructor(private readonly results: CodexTurnResult[]) {}

  public runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (result === undefined) throw new Error('Unexpected extra repair turn');
    return Promise.resolve(result);
  }
}

function createDirective(overrides: Partial<ManagerDirective> = {}): ManagerDirective {
  return {
    action: 'INFORM',
    taskId: 'TASK-1',
    title: 'Task',
    instructions: '',
    acceptanceCriteria: [],
    issues: [],
    requestedChecks: [],
    summary: 'Information supplied.',
    ...overrides,
  };
}

function block(value: unknown): string {
  return `<AGENTHUB_DIRECTIVE>\n${JSON.stringify(value)}\n</AGENTHUB_DIRECTIVE>`;
}

function completedTurn(turnId: string, text: string): CodexTurnResult {
  return { threadId: 'thread-1', sessionId: 'session-1', turnId, status: 'completed', text, events: [] };
}

function failedTurn(
  turnId: string,
  status: 'failed' | 'timeout' | 'upstream_unavailable',
  kind: 'process_exit' | 'timeout' | 'upstream_unavailable',
): CodexTurnResult {
  return {
    threadId: 'thread-1',
    sessionId: 'session-1',
    turnId,
    status,
    text: '',
    events: [],
    error: { kind, message: kind },
  };
}
