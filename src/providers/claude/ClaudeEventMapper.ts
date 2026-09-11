import type { AgentRuntimeContext } from '../../events/agent-runtime-events.js';
import { AgentRuntimeEventType } from '../../events/agent-runtime-events.js';
import type { EventBus } from '../../events/event-bus.js';
import type { AgentHubWorkerResult } from '../../protocol/AgentHubWorkerResult.js';
import type { AgentHubWorkerResultFailure } from '../../protocol/AgentHubWorkerResultParser.js';
import type { ClaudeRawMessage } from './ClaudeJsonlParser.js';

export type ClaudeMapperTransport = 'persistent-stream' | 'resume-per-turn';

export interface ClaudeEventMapperOptions {
  eventBus: EventBus;
  context: AgentRuntimeContext;
}

export interface ClaudeExecutionObservation {
  transport?: ClaudeMapperTransport;
  sessionId?: string;
  processId?: number;
}

export interface ClaudeProcessExitObservation extends ClaudeExecutionObservation {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  expected?: boolean;
}

type ClaudeSafeMetadata = Record<string, string | number | boolean | null>;
type ProviderErrorKind = 'process' | 'protocol' | 'transport';

interface PendingAssistantMessage {
  messageId: string;
  sessionId?: string;
  model?: string;
  textLength: number;
  textBlockCount: number;
  contentBlockCount: number;
  unknownBlockCount: number;
}

const maxMetadataStringChars = 256;
const retrySafetyValues = new Set(['safe', 'ambiguous', 'not-applicable']);
const transportValues = new Set<ClaudeMapperTransport>(['persistent-stream', 'resume-per-turn']);

export class ClaudeEventMapper {
  readonly #context: Readonly<AgentRuntimeContext>;
  #pendingAssistantMessage: PendingAssistantMessage | undefined;

  public constructor(private readonly options: ClaudeEventMapperOptions) {
    this.#context = Object.freeze({ ...options.context, provider: 'claude' });
  }

  public observeExecutionStarted(metadata: ClaudeExecutionObservation = {}): void {
    this.#publish(AgentRuntimeEventType.AGENT_EXECUTION_STARTED, {
      provider: 'claude',
      ...executionMetadata(metadata),
    });
  }

  public observeRawMessage(message: ClaudeRawMessage): void {
    const record = asRecord(message);
    const sourceType = safeString(read(record, 'type'));
    switch (sourceType) {
      case 'system':
        this.#observeSystem(record);
        return;
      case 'assistant':
        this.#observeAssistant(record);
        return;
      case 'user':
        this.#flushPendingAssistantMessage();
        this.#observeUser(record);
        return;
      case 'stream_event':
        this.#observeStreamEvent(record);
        return;
      case 'result':
        this.#flushPendingAssistantMessage();
        this.#observeResult(record);
        return;
      case 'rate_limit_event':
        this.#observeRateLimit(record);
        return;
      default:
        this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, {
          provider: 'claude',
          ...optionalString('sourceType', sourceType),
          ...optionalString('subtype', safeString(read(record, 'subtype'))),
          ...sessionMetadata(record),
        });
    }
  }

  public observeWorkerResult(result: AgentHubWorkerResult, metadata: ClaudeExecutionObservation = {}): void {
    const payload = {
      provider: 'claude',
      ...executionMetadata(metadata),
      ...workerResultMetadata(result),
    };
    const terminalType = result.outcome === 'FAILED'
      ? AgentRuntimeEventType.AGENT_EXECUTION_FAILED
      : AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED;
    this.#publish(terminalType, payload);
    if (result.outcome === 'NEEDS_INPUT') {
      this.#publish(AgentRuntimeEventType.AGENT_INPUT_REQUIRED, payload);
    }
  }

  public observeWorkerResultFailure(
    failure: AgentHubWorkerResultFailure,
    metadata: ClaudeExecutionObservation = {},
  ): void {
    const payload = {
      provider: 'claude',
      kind: 'worker_result_protocol',
      ...optionalString('failureKind', safeString(failure.kind)),
      ...executionMetadata(metadata),
    };
    this.#publish(AgentRuntimeEventType.AGENT_RUNTIME_ERROR, payload);
    this.#publish(AgentRuntimeEventType.AGENT_EXECUTION_FAILED, payload);
  }

  public observeExecutionFailure(error: unknown, metadata: ClaudeExecutionObservation = {}): void {
    this.#pendingAssistantMessage = undefined;
    this.#publish(AgentRuntimeEventType.AGENT_EXECUTION_FAILED, {
      provider: 'claude',
      ...executionMetadata(metadata),
      ...errorMetadata(error, true),
    });
  }

  public observeProviderError(
    error: unknown,
    kind: ProviderErrorKind,
    metadata: ClaudeExecutionObservation = {},
  ): void {
    this.#publish(AgentRuntimeEventType.PROVIDER_ERROR, {
      provider: 'claude',
      kind,
      ...executionMetadata(metadata),
      ...errorMetadata(error, false),
    });
  }

  public observeProcessExit(exit: ClaudeProcessExitObservation): void {
    this.#pendingAssistantMessage = undefined;
    this.#publish(AgentRuntimeEventType.PROVIDER_PROCESS_EXITED, {
      provider: 'claude',
      ...executionMetadata(exit),
      ...(exit.exitCode === null ? { exitCode: null } : optionalSafeInteger('exitCode', exit.exitCode)),
      ...optionalString('signal', safeString(exit.signal)),
      ...optionalBoolean('expected', exit.expected),
    });
  }

  #observeSystem(record: Record<string, unknown> | undefined): void {
    const subtype = safeString(read(record, 'subtype'));
    const base = {
      provider: 'claude',
      sourceType: 'system',
      ...optionalString('subtype', subtype),
      ...sessionMetadata(record),
    };
    if (subtype === 'api_retry') {
      const attempt = safeInteger(read(record, 'attempt'));
      const retryCount = safeInteger(read(record, 'retry_count')) ?? safeInteger(read(record, 'retryCount'));
      this.#publish(AgentRuntimeEventType.AGENT_RUNTIME_ERROR, {
        ...base,
        willRetry: true,
        ...optionalNumber('attempt', attempt),
        ...optionalNumber('retryCount', retryCount),
      });
      return;
    }
    if (subtype === 'init') {
      this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, {
        ...base,
        ...optionalString('model', safeString(read(record, 'model'))),
        ...optionalString('claudeCodeVersion', safeString(read(record, 'claude_code_version')) ?? safeString(read(record, 'claudeCodeVersion'))),
        ...optionalString('permissionMode', safeString(read(record, 'permissionMode')) ?? safeString(read(record, 'permission_mode'))),
      });
      return;
    }
    this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, base);
  }

  #observeAssistant(record: Record<string, unknown> | undefined): void {
    const message = asRecord(read(record, 'message'));
    const messageId = safeRequiredString(read(message, 'id'));
    if (messageId !== undefined && this.#pendingAssistantMessage?.messageId !== messageId) {
      this.#flushPendingAssistantMessage();
    }
    const base: ClaudeSafeMetadata = {
      provider: 'claude',
      sourceType: 'assistant',
      ...sessionMetadata(record),
      ...optionalString('messageId', messageId),
      ...optionalString('model', safeString(read(message, 'model')) ?? safeString(read(record, 'model'))),
    };
    if (read(record, 'isApiErrorMessage') === true || read(message, 'isApiErrorMessage') === true) {
      if (this.#pendingAssistantMessage?.messageId === messageId) this.#pendingAssistantMessage = undefined;
      this.#publish(AgentRuntimeEventType.AGENT_RUNTIME_ERROR, { ...base, kind: 'api_error_message' });
      return;
    }

    const content = asArray(read(message, 'content'));
    if (content === undefined) {
      this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, base);
      return;
    }

    let textLength = 0;
    let textBlockCount = 0;
    let unknownBlockCount = 0;
    let malformedToolUseCount = 0;
    let validToolUseCount = 0;
    for (const value of content) {
      const block = asRecord(value);
      const blockType = safeString(read(block, 'type'));
      if (blockType === 'text') {
        const text = rawString(read(block, 'text'));
        if (text !== undefined) {
          textLength = saturatingAdd(textLength, text.length);
          textBlockCount = saturatingAdd(textBlockCount, 1);
        } else {
          unknownBlockCount = saturatingAdd(unknownBlockCount, 1);
        }
      } else if (blockType === 'tool_use') {
        const toolUseId = safeRequiredString(read(block, 'id'));
        const toolName = safeRequiredString(read(block, 'name'));
        if (toolUseId === undefined || toolName === undefined) {
          malformedToolUseCount = saturatingAdd(malformedToolUseCount, 1);
          unknownBlockCount = saturatingAdd(unknownBlockCount, 1);
          continue;
        }
        validToolUseCount = saturatingAdd(validToolUseCount, 1);
        this.#publish(AgentRuntimeEventType.AGENT_OPERATION_STARTED, {
          ...base,
          operationType: 'tool_use',
          toolUseId,
          toolName,
        });
      } else {
        unknownBlockCount = saturatingAdd(unknownBlockCount, 1);
      }
    }

    if (messageId !== undefined) {
      const pending = this.#pendingAssistantMessage ?? {
        messageId,
        ...optionalString('sessionId', safeString(read(record, 'session_id')) ?? safeString(read(record, 'sessionId'))),
        ...optionalString('model', safeString(read(message, 'model')) ?? safeString(read(record, 'model'))),
        textLength: 0,
        textBlockCount: 0,
        contentBlockCount: 0,
        unknownBlockCount: 0,
      };
      pending.textLength = saturatingAdd(pending.textLength, textLength);
      pending.textBlockCount = saturatingAdd(pending.textBlockCount, textBlockCount);
      pending.contentBlockCount = saturatingAdd(pending.contentBlockCount, content.length);
      pending.unknownBlockCount = saturatingAdd(pending.unknownBlockCount, unknownBlockCount);
      this.#pendingAssistantMessage = pending;
    }

    if (messageId === undefined || malformedToolUseCount > 0 ||
      (textBlockCount === 0 && validToolUseCount === 0 && unknownBlockCount > 0)) {
      this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, {
        ...base,
        contentBlockCount: content.length,
        ...(unknownBlockCount === 0 ? {} : { unknownBlockCount }),
        ...(malformedToolUseCount === 0 ? {} : { malformedToolUseCount }),
      });
    }
  }

  #flushPendingAssistantMessage(): void {
    const pending = this.#pendingAssistantMessage;
    this.#pendingAssistantMessage = undefined;
    if (pending === undefined || pending.textBlockCount === 0) return;
    this.#publish(AgentRuntimeEventType.AGENT_MESSAGE_COMPLETED, {
      provider: 'claude',
      sourceType: 'assistant',
      messageId: pending.messageId,
      ...optionalString('sessionId', pending.sessionId),
      ...optionalString('model', pending.model),
      textLength: pending.textLength,
      textBlockCount: pending.textBlockCount,
      contentBlockCount: pending.contentBlockCount,
      ...(pending.unknownBlockCount === 0 ? {} : { unknownBlockCount: pending.unknownBlockCount }),
    });
  }

  #observeUser(record: Record<string, unknown> | undefined): void {
    const content = asArray(read(asRecord(read(record, 'message')), 'content'));
    const base: ClaudeSafeMetadata = {
      provider: 'claude',
      sourceType: 'user',
      ...sessionMetadata(record),
    };
    let recognized = 0;
    let malformedToolResultCount = 0;
    for (const value of content ?? []) {
      const block = asRecord(value);
      if (safeString(read(block, 'type')) !== 'tool_result') continue;
      const toolUseId = safeRequiredString(read(block, 'tool_use_id'));
      if (toolUseId === undefined) {
        malformedToolResultCount = saturatingAdd(malformedToolResultCount, 1);
        continue;
      }
      recognized = saturatingAdd(recognized, 1);
      this.#publish(AgentRuntimeEventType.AGENT_OPERATION_COMPLETED, {
        ...base,
        operationType: 'tool_use',
        toolUseId,
        status: read(block, 'is_error') === true ? 'failed' : 'completed',
      });
    }
    if (recognized === 0 || malformedToolResultCount > 0) {
      this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, {
        ...base,
        ...(malformedToolResultCount === 0 ? {} : { malformedToolResultCount }),
      });
    }
  }

  #observeStreamEvent(record: Record<string, unknown> | undefined): void {
    const event = asRecord(read(record, 'event'));
    const streamEventType = safeString(read(event, 'type'));
    const base: ClaudeSafeMetadata = {
      provider: 'claude',
      sourceType: 'stream_event',
      ...sessionMetadata(record),
    };
    const delta = asRecord(read(event, 'delta'));
    if (streamEventType === 'content_block_delta' && safeString(read(delta, 'type')) === 'text_delta') {
      const text = rawString(read(delta, 'text'));
      if (text !== undefined) {
        this.#publish(AgentRuntimeEventType.AGENT_MESSAGE_DELTA, {
          ...base,
          textLength: text.length,
          ...optionalSafeInteger('contentBlockIndex', read(event, 'index')),
        });
        return;
      }
    }
    this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, {
      ...base,
      ...optionalString('streamEventType', streamEventType),
    });
  }

  #observeResult(record: Record<string, unknown> | undefined): void {
    const usage = asRecord(read(record, 'usage'));
    const permissionDenials = asArray(read(record, 'permission_denials'));
    this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, {
      provider: 'claude',
      sourceType: 'result',
      ...optionalString('subtype', safeString(read(record, 'subtype'))),
      ...sessionMetadata(record),
      ...optionalBoolean('isError', read(record, 'is_error')),
      ...optionalNumber('durationMs', safeNumber(read(record, 'duration_ms'))),
      ...optionalNumber('durationApiMs', safeNumber(read(record, 'duration_api_ms'))),
      ...optionalSafeInteger('numTurns', read(record, 'num_turns')),
      ...optionalNumber('totalCostUsd', safeNumber(read(record, 'total_cost_usd'))),
      ...optionalString('stopReason', safeString(read(record, 'stop_reason'))),
      ...optionalSafeInteger('inputTokens', read(usage, 'input_tokens')),
      ...optionalSafeInteger('outputTokens', read(usage, 'output_tokens')),
      ...optionalSafeInteger('cacheReadInputTokens', read(usage, 'cache_read_input_tokens')),
      ...optionalSafeInteger('cacheCreationInputTokens', read(usage, 'cache_creation_input_tokens')),
      ...(permissionDenials === undefined ? {} : { permissionDenialCount: permissionDenials.length }),
    });
  }

  #observeRateLimit(record: Record<string, unknown> | undefined): void {
    const info = asRecord(read(record, 'rate_limit_info'));
    this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, {
      provider: 'claude',
      sourceType: 'rate_limit_event',
      ...optionalString('rateLimitStatus', safeString(read(info, 'status'))),
      ...optionalString('rateLimitType', safeString(read(info, 'rateLimitType'))
        ?? safeString(read(info, 'rate_limit_type'))
        ?? safeString(read(info, 'type'))),
      ...optionalNumber('resetsAt', safeNumber(read(info, 'resetsAt')) ?? safeNumber(read(info, 'resets_at'))),
      ...optionalBoolean('isUsingOverage', safeBoolean(read(info, 'isUsingOverage'))
        ?? safeBoolean(read(info, 'is_using_overage'))),
    });
  }

  #publish(eventType: AgentRuntimeEventType, payload: ClaudeSafeMetadata): void {
    this.options.eventBus.publish({
      eventType,
      ...optionalContext(this.#context),
      actor: this.#context.agentId ?? 'claude',
      payload,
    });
  }
}

function workerResultMetadata(result: AgentHubWorkerResult): ClaudeSafeMetadata {
  let passedCheckClaimCount = 0;
  let failedCheckClaimCount = 0;
  let notRunCheckClaimCount = 0;
  for (const check of result.checks) {
    if (check.status === 'PASSED') passedCheckClaimCount += 1;
    else if (check.status === 'FAILED') failedCheckClaimCount += 1;
    else notRunCheckClaimCount += 1;
  }
  return {
    workerOutcome: result.outcome,
    summaryLength: result.summary.length,
    changedFileClaimCount: result.changedFiles.length,
    checkClaimCount: result.checks.length,
    passedCheckClaimCount,
    failedCheckClaimCount,
    notRunCheckClaimCount,
    blockerCount: result.blockers.length,
    questionCount: result.questions.length,
    riskCount: result.risks.length,
    noteCount: result.notes.length,
  };
}

function errorMetadata(error: unknown, includeRetrySafety: boolean): ClaudeSafeMetadata {
  const record = asRecord(error);
  const retrySafety = safeString(read(record, 'retrySafety'));
  return {
    ...optionalString('errorCode', safeString(read(record, 'code'))),
    ...optionalString('errorName', safeString(read(record, 'name'))),
    ...(includeRetrySafety && retrySafety !== undefined && retrySafetyValues.has(retrySafety)
      ? { retrySafety }
      : {}),
  };
}

function executionMetadata(metadata: ClaudeExecutionObservation): ClaudeSafeMetadata {
  const transport = safeString(metadata.transport);
  return {
    ...(transport !== undefined && transportValues.has(transport as ClaudeMapperTransport) ? { transport } : {}),
    ...optionalString('sessionId', safeString(metadata.sessionId)),
    ...optionalSafeInteger('processId', metadata.processId),
  };
}

function sessionMetadata(record: Record<string, unknown> | undefined): ClaudeSafeMetadata {
  return optionalString('sessionId', safeString(read(record, 'session_id')) ?? safeString(read(record, 'sessionId')));
}

function optionalContext(context: Readonly<AgentRuntimeContext>): {
  projectId?: string;
  agentId?: string;
  taskId?: string;
  assignmentId?: string;
} {
  return {
    ...optionalRawString('projectId', context.projectId),
    ...optionalRawString('agentId', context.agentId),
    ...optionalRawString('taskId', context.taskId),
    ...optionalRawString('assignmentId', context.assignmentId),
  };
}

function read(record: Record<string, unknown> | undefined, key: string): unknown {
  if (record === undefined) return undefined;
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function rawString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}


function safeRequiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxMetadataStringChars
    ? value
    : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, maxMetadataStringChars) : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function optionalString<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, string>>;
}

function optionalRawString<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return typeof value === 'string' ? { [key]: value } as Partial<Record<K, string>> : {};
}

function optionalNumber<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, number>>;
}

function optionalSafeInteger<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  return optionalNumber(key, safeInteger(value));
}

function optionalBoolean<K extends string>(key: K, value: unknown): Partial<Record<K, boolean>> {
  return typeof value === 'boolean' ? { [key]: value } as Partial<Record<K, boolean>> : {};
}
