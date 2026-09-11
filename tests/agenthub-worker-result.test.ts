import { describe, expect, it } from 'vitest';
import {
  AgentHubWorkerCheckClaimSchema,
  AgentHubWorkerResultParser,
  AgentHubWorkerResultSchema,
  agentHubResultCloseTag,
  agentHubResultOpenTag,
  agentHubWorkerResultLimits,
  buildAgentHubWorkerResultInstruction,
  type AgentHubWorkerResult,
} from '../src/index.js';

const parser = new AgentHubWorkerResultParser();

describe('AgentHub worker result parser', () => {
  it.each([
    ['COMPLETED', { outcome: 'COMPLETED' }],
    ['FAILED', { outcome: 'FAILED' }],
    ['BLOCKED', { outcome: 'BLOCKED', blockers: ['Dependency unavailable.'] }],
    ['NEEDS_INPUT', { outcome: 'NEEDS_INPUT', questions: ['Which behavior is required?'] }],
  ] as const)('parses a valid %s result', (_name, overrides) => {
    const result = parser.parse(block(createResult(overrides)));
    expect(result).toEqual({ success: true, result: createResult(overrides) });
  });

  it('allows surrounding prose and preserves Unicode and path strings', () => {
    const value = createResult({
      summary: '完成了 café 功能 🚀',
      changedFiles: ['src\\worker.ts', 'docs/结果.md'],
    });
    expect(parser.parse(`Finished.\n${block(value)}\nAdditional prose.`)).toEqual({ success: true, result: value });
  });

  it.each([
    ['no markers', 'plain response', 'missing_result'],
    ['only open', `${agentHubResultOpenTag}{}`, 'missing_result'],
    ['only close', `{}` + agentHubResultCloseTag, 'missing_result'],
    ['close before open', `${agentHubResultCloseTag}{}${agentHubResultOpenTag}`, 'missing_result'],
    ['wrong case', '<agenthub_result>{}</agenthub_result>', 'missing_result'],
    ['duplicate open', `${agentHubResultOpenTag}${block(createResult())}`, 'multiple_results'],
    ['duplicate close', `${block(createResult())}${agentHubResultCloseTag}`, 'multiple_results'],
    ['two blocks', `${block(createResult())}\n${block(createResult())}`, 'multiple_results'],
    ['open marker in string', block(createResult({ notes: [agentHubResultOpenTag] })), 'multiple_results'],
    ['close marker in string', block(createResult({ notes: [agentHubResultCloseTag] })), 'multiple_results'],
    ['empty block', `${agentHubResultOpenTag}  ${agentHubResultCloseTag}`, 'malformed_json'],
  ])('rejects marker framing: %s', (_name, text, kind) => {
    expect(parser.parse(text)).toMatchObject({ success: false, failure: { kind } });
  });

  it.each([
    ['malformed object', '{bad}'],
    ['code fence', '```json\n{}\n```'],
    ['trailing comma', '{"protocolVersion":1,}'],
    ['comment', '{/* no */}'],
  ])('rejects malformed JSON: %s', (_name, json) => {
    expect(parser.parse(`${agentHubResultOpenTag}${json}${agentHubResultCloseTag}`)).toMatchObject({
      success: false,
      failure: { kind: 'malformed_json' },
    });
  });

  it.each([
    ['array', []],
    ['null', null],
    ['string', 'value'],
    ['number', 1],
    ['boolean', true],
  ])('rejects a non-object JSON root: %s', (_name, value) => {
    expect(parser.parse(block(value))).toMatchObject({ success: false, failure: { kind: 'schema_invalid' } });
  });

  it('rejects every missing required field', () => {
    for (const key of Object.keys(createResult()) as (keyof AgentHubWorkerResult)[]) {
      const value = Object.fromEntries(Object.entries(createResult()).filter(([entryKey]) => entryKey !== key));
      const result = parser.parse(block(value));
      expect(result, key).toMatchObject({ success: false, failure: { kind: 'schema_invalid' } });
    }
  });

  it.each([
    ['protocol version 0', { protocolVersion: 0 }],
    ['protocol version 2', { protocolVersion: 2 }],
    ['protocol version string', { protocolVersion: '1' }],
    ['unknown outcome', { outcome: 'DONE' }],
    ['summary type', { summary: 1 }],
    ['changedFiles type', { changedFiles: null }],
    ['checks type', { checks: {} }],
    ['blockers type', { blockers: 'blocked' }],
    ['questions item type', { questions: [1] }],
    ['risks type', { risks: null }],
    ['notes type', { notes: false }],
  ])('rejects invalid schema: %s', (_name, overrides) => {
    expect(parser.parse(block(createResult(overrides as Partial<AgentHubWorkerResult>)))).toMatchObject({
      success: false,
      failure: { kind: 'schema_invalid' },
    });
  });

  it('rejects unknown top-level fields without exposing their names', () => {
    for (const secret of [
      'PRIVATE_UNKNOWN_KEY_SENTINEL',
      '未知秘密字段',
      'CONTROL\nCHARACTER\tKEY',
      '__proto__',
      'constructor',
      'prototype',
      'toString',
      '__defineGetter__',
    ]) {
      const value = addUnknownField(createResult(), secret);
      const parsed = parser.parse(block(value));
      const schemaResult = AgentHubWorkerResultSchema.safeParse(value);

      expect(parsed, secret).toMatchObject({
        success: false,
        failure: { kind: 'schema_invalid', message: '$.*: Unknown field' },
      });
      const escapedSecret = JSON.stringify(secret).slice(1, -1);
      expect(JSON.stringify(parsed), secret).not.toContain(escapedSecret);
      expect(JSON.stringify(schemaResult), secret).not.toContain(escapedSecret);
      expect(schemaResult).toMatchObject({ success: false, issues: [{ path: '$.*', message: 'Unknown field' }] });
    }
  });

  it('rejects an unknown nested check field without exposing its name', () => {
    const secret = 'PRIVATE_NESTED_KEY_SENTINEL';
    const check = addUnknownField({ name: 'test', status: 'PASSED', detail: '' }, secret);
    const value = createResult({ checks: [check] });
    const parsed = parser.parse(block(value));
    const schemaResult = AgentHubWorkerResultSchema.safeParse(value);
    const checkSchemaResult = AgentHubWorkerCheckClaimSchema.safeParse(check);

    expect(parsed).toMatchObject({
      success: false,
      failure: { kind: 'schema_invalid', message: 'checks[0].*: Unknown field' },
    });
    for (const diagnostic of [parsed, schemaResult, checkSchemaResult]) {
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
    }
    expect(schemaResult).toMatchObject({ success: false, issues: [{ path: 'checks[0].*' }] });
    expect(checkSchemaResult).toMatchObject({ success: false, issues: [{ path: 'checks[0].*' }] });
  });

  it('keeps a huge unknown key private and the parser failure bounded', () => {
    const secret = `HUGE_PRIVATE_KEY_${'x'.repeat(agentHubWorkerResultLimits.maxFailureMessageChars * 4)}`;
    const value = addUnknownField(createResult(), secret);
    const parsed = parser.parse(block(value));
    const schemaResult = AgentHubWorkerResultSchema.safeParse(value);

    expect(parsed).toMatchObject({ success: false, failure: { kind: 'schema_invalid' } });
    if (parsed.success) throw new Error('Expected parser failure');
    expect(parsed.failure.message.length).toBeLessThanOrEqual(agentHubWorkerResultLimits.maxFailureMessageChars);
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(JSON.stringify(schemaResult)).not.toContain(secret);
  });

  it('does not expose any of several unknown property names', () => {
    const secrets = ['PRIVATE_ONE', 'PRIVATE_TWO', 'PRIVATE_THREE', 'PRIVATE_FOUR'];
    let value: object = createResult();
    for (const secret of secrets) value = addUnknownField(value, secret);

    const parsed = parser.parse(block(value));
    const schemaResult = AgentHubWorkerResultSchema.safeParse(value);
    for (const secret of secrets) {
      expect(JSON.stringify(parsed)).not.toContain(secret);
      expect(JSON.stringify(schemaResult)).not.toContain(secret);
    }
    expect(parsed).toMatchObject({ success: false, failure: { kind: 'schema_invalid' } });
  });

  it('retains safe structural diagnostics for mixed top-level, nested, and known-field errors', () => {
    const topSecret = 'PRIVATE_TOP_LEVEL_KEY';
    const nestedSecret = 'PRIVATE_NESTED_LEVEL_KEY';
    const check = addUnknownField({ name: 'test', status: 'PASSED', detail: '' }, nestedSecret);
    const value = addUnknownField(createResult({ summary: 42, checks: [check] }), topSecret);
    const parsed = parser.parse(block(value));
    const schemaResult = AgentHubWorkerResultSchema.safeParse(value);

    expect(parsed).toMatchObject({ success: false, failure: { kind: 'schema_invalid' } });
    if (parsed.success || schemaResult.success) throw new Error('Expected validation failures');
    expect(parsed.failure.message).toContain('$.*: Unknown field');
    expect(parsed.failure.message).toContain('summary: summary must be a string');
    expect(parsed.failure.message).toContain('checks[0].*: Unknown field');
    expect(schemaResult.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['$.*', 'summary', 'checks[0].*']));
    expect(JSON.stringify([parsed, schemaResult])).not.toContain(topSecret);
    expect(JSON.stringify([parsed, schemaResult])).not.toContain(nestedSecret);
  });

  it.each([
    ['missing name', { status: 'PASSED', detail: '' }],
    ['missing status', { name: 'test', detail: '' }],
    ['missing detail', { name: 'test', status: 'PASSED' }],
    ['wrong status', { name: 'test', status: 'SUCCESS', detail: '' }],
    ['non-object', 'test'],
    ['unknown field', { name: 'test', status: 'PASSED', detail: '', trusted: true }],
  ])('rejects an invalid check claim: %s', (_name, check) => {
    expect(parser.parse(block(createResult({ checks: [check] as never })))).toMatchObject({
      success: false,
      failure: { kind: 'schema_invalid' },
    });
  });

  it.each([
    ['blank summary', { summary: '  ' }],
    ['completed blockers', { blockers: ['Still blocked.'] }],
    ['completed questions', { questions: ['Need input?'] }],
    ['blocked without blockers', { outcome: 'BLOCKED' }],
    ['needs input without questions', { outcome: 'NEEDS_INPUT' }],
    ['duplicate changed file', { changedFiles: ['src/a.ts', 'src/a.ts'] }],
    [
      'duplicate check name',
      {
        checks: [
          { name: 'tests', status: 'PASSED', detail: '' },
          { name: 'tests', status: 'FAILED', detail: 'Claim only.' },
        ],
      },
    ],
  ])('rejects semantic contradiction: %s', (_name, overrides) => {
    expect(parser.parse(block(createResult(overrides as Partial<AgentHubWorkerResult>)))).toMatchObject({
      success: false,
      failure: { kind: 'semantic_invalid' },
    });
  });

  it.each([
    ['blank changed file', { changedFiles: [' '] }],
    ['NUL changed file', { changedFiles: ['src/a\0.ts'] }],
    ['blank blocker', { outcome: 'BLOCKED', blockers: [' '] }],
    ['blank question', { outcome: 'NEEDS_INPUT', questions: [' '] }],
    ['blank risk', { risks: [' '] }],
    ['blank note', { notes: [' '] }],
    ['blank check name', { checks: [{ name: ' ', status: 'NOT_RUN', detail: '' }] }],
  ])('rejects invalid string content: %s', (_name, overrides) => {
    expect(parser.parse(block(createResult(overrides as Partial<AgentHubWorkerResult>)))).toMatchObject({
      success: false,
      failure: { kind: 'schema_invalid' },
    });
  });

  it.each([
    ['summary', { summary: 'x'.repeat(agentHubWorkerResultLimits.maxSummaryChars + 1) }],
    ['path', { changedFiles: ['x'.repeat(agentHubWorkerResultLimits.maxPathChars + 1)] }],
    ['check name', { checks: [{ name: 'x'.repeat(agentHubWorkerResultLimits.maxCheckNameChars + 1), status: 'PASSED', detail: '' }] }],
    ['check detail', { checks: [{ name: 'test', status: 'PASSED', detail: 'x'.repeat(agentHubWorkerResultLimits.maxDetailChars + 1) }] }],
    ['list item', { risks: ['x'.repeat(agentHubWorkerResultLimits.maxListItemChars + 1)] }],
  ])('rejects an oversized %s', (_name, overrides) => {
    expect(parser.parse(block(createResult(overrides as Partial<AgentHubWorkerResult>)))).toMatchObject({
      success: false,
      failure: { kind: 'schema_invalid' },
    });
  });

  it.each([
    ['changed files', 'changedFiles', agentHubWorkerResultLimits.maxChangedFiles + 1, 'x'],
    ['checks', 'checks', agentHubWorkerResultLimits.maxChecks + 1, { name: 'x', status: 'PASSED', detail: '' }],
    ['blockers', 'blockers', agentHubWorkerResultLimits.maxBlockers + 1, 'x'],
    ['questions', 'questions', agentHubWorkerResultLimits.maxQuestions + 1, 'x'],
    ['risks', 'risks', agentHubWorkerResultLimits.maxRisks + 1, 'x'],
    ['notes', 'notes', agentHubWorkerResultLimits.maxNotes + 1, 'x'],
  ] as const)('rejects too many %s', (_name, key, count, item) => {
    const overrides = { [key]: Array.from({ length: count }, (_, index) => typeof item === 'string' ? `${item}${String(index)}` : { ...item, name: `${item.name}${String(index)}` }) };
    expect(parser.parse(block(createResult(overrides)))).toMatchObject({
      success: false,
      failure: { kind: 'schema_invalid' },
    });
  });

  it.each([
    ['summary', { summary: 's'.repeat(agentHubWorkerResultLimits.maxSummaryChars) }],
    ['path', { changedFiles: ['p'.repeat(agentHubWorkerResultLimits.maxPathChars)] }],
    ['check name', { checks: [{ name: 'n'.repeat(agentHubWorkerResultLimits.maxCheckNameChars), status: 'NOT_RUN', detail: '' }] }],
    ['check detail', { checks: [{ name: 'test', status: 'NOT_RUN', detail: 'd'.repeat(agentHubWorkerResultLimits.maxDetailChars) }] }],
    ['list item', { notes: ['n'.repeat(agentHubWorkerResultLimits.maxListItemChars)] }],
    ['changed file count', { changedFiles: Array.from({ length: agentHubWorkerResultLimits.maxChangedFiles }, (_, index) => `f${String(index)}`) }],
    ['check count', { checks: Array.from({ length: agentHubWorkerResultLimits.maxChecks }, (_, index) => ({ name: `check${String(index)}`, status: 'NOT_RUN', detail: '' })) }],
  ] as const)('accepts %s exactly at its limit', (_name, overrides) => {
    expect(parser.parse(block(createResult(overrides)))).toMatchObject({ success: true });
  });

  it('accepts a valid result block just under the byte limit', () => {
    const value = createResult({
      notes: Array.from({ length: 63 }, () => 'n'.repeat(agentHubWorkerResultLimits.maxListItemChars)),
    });
    const json = JSON.stringify(value);
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(agentHubWorkerResultLimits.maxBlockBytes);
    expect(parser.parse(`${agentHubResultOpenTag}${json}${agentHubResultCloseTag}`)).toMatchObject({ success: true });
  });

  it('enforces the UTF-8 result-block size limit', () => {
    const oversized = `${agentHubResultOpenTag}${'界'.repeat(Math.ceil(agentHubWorkerResultLimits.maxBlockBytes / 3) + 1)}${agentHubResultCloseTag}`;
    expect(parser.parse(oversized)).toMatchObject({ success: false, failure: { kind: 'result_too_large' } });
  });

  it('enforces the whole-response scan limit before marker processing', () => {
    expect(parser.parse('x'.repeat(agentHubWorkerResultLimits.maxResponseChars + 1))).toMatchObject({
      success: false,
      failure: { kind: 'result_too_large' },
    });
  });

  it('does not leak malformed JSON or oversized payloads in failures', () => {
    const secret = 'TOP-SECRET-MODEL-OUTPUT';
    const malformed = parser.parse(`${agentHubResultOpenTag}{"summary":"${secret}"${agentHubResultCloseTag}`);
    const oversized = parser.parse(`${agentHubResultOpenTag}${secret.repeat(20_000)}${agentHubResultCloseTag}`);
    expect(JSON.stringify(malformed)).not.toContain(secret);
    expect(JSON.stringify(oversized)).not.toContain(secret);
  });

  it('does not leak schema-invalid or semantic-invalid values', () => {
    const schemaSecret = 'PRIVATE_INVALID_OUTCOME_VALUE';
    const semanticSecret = 'PRIVATE_BLOCKER_VALUE';
    const schemaFailure = parser.parse(block(createResult({ outcome: schemaSecret })));
    const semanticFailure = parser.parse(block(createResult({ blockers: [semanticSecret] })));

    expect(schemaFailure).toMatchObject({ success: false, failure: { kind: 'schema_invalid' } });
    expect(semanticFailure).toMatchObject({
      success: false,
      failure: { kind: 'semantic_invalid', message: 'blockers: COMPLETED must not include blockers' },
    });
    expect(JSON.stringify(schemaFailure)).not.toContain(schemaSecret);
    expect(JSON.stringify(semanticFailure)).not.toContain(semanticSecret);
  });

  it('keeps every public parser failure message within the configured limit', () => {
    const failures = [
      parser.parse('no result'),
      parser.parse(`${block(createResult())}${block(createResult())}`),
      parser.parse(`${agentHubResultOpenTag}${'x'.repeat(agentHubWorkerResultLimits.maxBlockBytes + 1)}${agentHubResultCloseTag}`),
      parser.parse(`${agentHubResultOpenTag}{bad}${agentHubResultCloseTag}`),
      parser.parse(block(createResult({ outcome: 'PRIVATE_INVALID_OUTCOME_VALUE' }))),
      parser.parse(block(createResult({ blockers: ['PRIVATE_BLOCKER_VALUE'] }))),
    ];

    for (const result of failures) {
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected parser failure');
      expect(result.failure.message.length).toBeLessThanOrEqual(agentHubWorkerResultLimits.maxFailureMessageChars);
    }
  });

  it('is deterministic for repeated parsing', () => {
    const text = block(createResult());
    expect(parser.parse(text)).toEqual(parser.parse(text));
  });
});

describe('AgentHub worker result schema', () => {
  it('returns canonical copies without mutating or retaining caller arrays', () => {
    const input = createResult({
      changedFiles: ['src/a.ts'],
      checks: [{ name: 'test', status: 'PASSED', detail: 'claim' }],
      notes: ['note'],
    });
    const original = structuredClone(input);
    const parsed = AgentHubWorkerResultSchema.safeParse(input);
    expect(input).toEqual(original);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data).not.toBe(input);
    expect(parsed.data.changedFiles).not.toBe(input.changedFiles);
    expect(parsed.data.checks).not.toBe(input.checks);
    expect(parsed.data.checks[0]).not.toBe(input.checks[0]);
    expect(parsed.data.notes).not.toBe(input.notes);

    input.changedFiles.push('src/b.ts');
    const inputCheck = input.checks[0];
    if (inputCheck === undefined) throw new Error('Expected test check');
    inputCheck.detail = 'mutated';
    expect(parsed.data.changedFiles).toEqual(['src/a.ts']);
    expect(parsed.data.checks[0]?.detail).toBe('claim');
  });

  it('validates a check claim independently', () => {
    expect(AgentHubWorkerCheckClaimSchema.safeParse({ name: 'lint', status: 'PASSED', detail: '' })).toEqual({
      success: true,
      data: { name: 'lint', status: 'PASSED', detail: '' },
    });
  });
});

describe('AgentHub worker result instruction', () => {
  it('describes exact markers and strict raw JSON requirements', () => {
    const instruction = buildAgentHubWorkerResultInstruction();
    for (const expected of [
      agentHubResultOpenTag,
      agentHubResultCloseTag,
      'protocolVersion',
      'COMPLETED',
      'FAILED',
      'BLOCKED',
      'NEEDS_INPUT',
      'raw JSON',
      'no Markdown code fence',
      'no additional fields',
    ]) {
      expect(instruction).toContain(expected);
    }
  });
});

function createResult(overrides: Record<string, unknown> = {}): AgentHubWorkerResult {
  return {
    protocolVersion: 1,
    outcome: 'COMPLETED',
    summary: 'Implemented the requested change.',
    changedFiles: [],
    checks: [],
    blockers: [],
    questions: [],
    risks: [],
    notes: [],
    ...overrides,
  };
}

function block(value: unknown): string {
  return `${agentHubResultOpenTag}\n${JSON.stringify(value)}\n${agentHubResultCloseTag}`;
}

function addUnknownField(value: object, key: string): Record<string, unknown> {
  const result = { ...value } as Record<string, unknown>;
  Object.defineProperty(result, key, { value: true, enumerable: true });
  return result;
}
