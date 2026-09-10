import type { AgentRuntimeContext } from '../../events/agent-runtime-events.js';
import { AgentRuntimeEventType } from '../../events/agent-runtime-events.js';
import type { EventBus } from '../../events/event-bus.js';
import type {
  CodexNotificationHandler,
  CodexProcessErrorHandler,
  CodexProcessExitHandler,
  CodexProtocolErrorHandler,
  CodexServerRequestHandler,
} from './CodexProvider.js';
import type { CodexServerRequest } from './CodexProtocol.js';
import { normalizeCodexErrorCode } from './CodexError.js';

export interface CodexEventSource {
  onNotification(handler: CodexNotificationHandler): () => void;
  onServerRequest(handler: CodexServerRequestHandler): () => void;
  onProtocolError(handler: CodexProtocolErrorHandler): () => void;
  onProcessExit(handler: CodexProcessExitHandler): () => void;
  onProcessError(handler: CodexProcessErrorHandler): () => void;
}

export interface CodexEventMapperOptions {
  eventBus: EventBus;
  source: CodexEventSource;
  context: AgentRuntimeContext;
  resolveSessionId?: (threadId: string) => string | undefined;
}

type Metadata = Record<string, string | number | boolean | null>;

const approvalMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
const inputMethods = new Set(['item/tool/requestUserInput', 'mcpServer/elicitation/request']);
const operationTypes = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'toolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
]);

export class CodexEventMapper {
  readonly #context: Readonly<AgentRuntimeContext>;
  readonly #unsubscribe: Array<() => void> = [];
  #attached = false;

  public constructor(private readonly options: CodexEventMapperOptions) {
    this.#context = Object.freeze({ ...options.context });
  }

  public attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    const { source } = this.options;
    this.#unsubscribe.push(
      source.onNotification((method, params) => this.#mapNotification(method, params)),
      source.onServerRequest((request) => this.#mapServerRequest(request)),
      source.onProtocolError((error) => this.#publish(AgentRuntimeEventType.PROVIDER_ERROR, {
        provider: this.#context.provider,
        kind: 'protocol',
        message: safeMessage(error),
      })),
      source.onProcessExit((exitCode, signal) => this.#publish(AgentRuntimeEventType.PROVIDER_PROCESS_EXITED, {
        provider: this.#context.provider,
        exitCode,
        signal,
      })),
      source.onProcessError((error) => this.#publish(AgentRuntimeEventType.PROVIDER_ERROR, {
        provider: this.#context.provider,
        kind: 'process',
        message: safeMessage(error),
      })),
    );
  }

  public dispose(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#attached = false;
  }

  #mapNotification(method: string, params: unknown): void {
    const record = asRecord(params);
    const metadata = this.#metadata(method, record);
    if (method === 'turn/started') {
      this.#publish(AgentRuntimeEventType.AGENT_EXECUTION_STARTED, metadata);
      return;
    }
    if (method === 'turn/completed') {
      const status = stringValue(asRecord(record?.turn)?.status) ?? stringValue(record?.status);
      this.#publish(
        status === 'completed' ? AgentRuntimeEventType.AGENT_EXECUTION_COMPLETED : AgentRuntimeEventType.AGENT_EXECUTION_FAILED,
        { ...metadata, ...(status === undefined ? {} : { status }) },
      );
      return;
    }
    if (method === 'item/agentMessage/delta') {
      this.#publish(AgentRuntimeEventType.AGENT_MESSAGE_DELTA, {
        ...metadata,
        textLength: stringValue(record?.delta)?.length ?? 0,
      });
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = asRecord(record?.item);
      const operationType = stringValue(item?.type) ?? stringValue(record?.type) ?? 'unknown';
      const itemMetadata = { ...metadata, ...idField('itemId', stringValue(item?.id)) };
      if (method === 'item/completed' && operationType === 'agentMessage') {
        const text = stringValue(item?.text);
        this.#publish(AgentRuntimeEventType.AGENT_MESSAGE_COMPLETED, {
          ...itemMetadata,
          ...idField('phase', stringValue(item?.phase)),
          textLength: text?.length ?? 0,
        });
      } else if (operationTypes.has(operationType)) {
        this.#publish(
          method === 'item/started' ? AgentRuntimeEventType.AGENT_OPERATION_STARTED : AgentRuntimeEventType.AGENT_OPERATION_COMPLETED,
          {
            ...itemMetadata,
            operationType,
            ...idField('status', stringValue(item?.status) ?? stringValue(record?.status)),
          },
        );
      } else {
        this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, { ...itemMetadata, itemType: operationType });
      }
      return;
    }
    if (method === 'error') {
      const error = asRecord(record?.error);
      this.#publish(AgentRuntimeEventType.AGENT_RUNTIME_ERROR, {
        ...metadata,
        ...idField('errorCode', stringValue(error?.code) ?? normalizeCodexErrorCode(error?.codexErrorInfo) ?? stringValue(record?.errorCode)),
        ...(typeof record?.willRetry === 'boolean' ? { willRetry: record.willRetry } : {}),
      });
      return;
    }
    this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, metadata);
  }

  #mapServerRequest(request: CodexServerRequest): void {
    const record = asRecord(request.params);
    const metadata = { ...this.#metadata(request.method, record), requestId: request.id };
    if (approvalMethods.has(request.method)) {
      this.#publish(AgentRuntimeEventType.AGENT_APPROVAL_REQUIRED, metadata);
    } else if (inputMethods.has(request.method)) {
      this.#publish(AgentRuntimeEventType.AGENT_INPUT_REQUIRED, metadata);
    } else {
      this.#publish(AgentRuntimeEventType.PROVIDER_EVENT_OBSERVED, metadata);
    }
  }

  #metadata(sourceMethod: string, record: Record<string, unknown> | undefined): Metadata {
    const turn = asRecord(record?.turn);
    const item = asRecord(record?.item);
    const threadId = stringValue(record?.threadId);
    const metadata: Metadata = {
      provider: this.#context.provider,
      sourceMethod,
      ...idField('threadId', threadId),
      ...idField('turnId', stringValue(record?.turnId) ?? stringValue(turn?.id)),
      ...idField('itemId', stringValue(record?.itemId) ?? stringValue(item?.id)),
    };
    if (threadId !== undefined) {
      const sessionId = this.options.resolveSessionId?.(threadId);
      if (sessionId !== undefined) metadata.sessionId = sessionId;
    }
    return metadata;
  }

  #publish(eventType: AgentRuntimeEventType, payload: Metadata): void {
    this.options.eventBus.publish({
      eventType,
      ...optionalContext(this.#context),
      actor: this.#context.agentId ?? this.#context.provider,
      payload,
    });
  }
}

function optionalContext(context: Readonly<AgentRuntimeContext>): {
  projectId?: string;
  agentId?: string;
  taskId?: string;
  assignmentId?: string;
} {
  return {
    ...idField('projectId', context.projectId),
    ...idField('agentId', context.agentId),
    ...idField('taskId', context.taskId),
    ...idField('assignmentId', context.assignmentId),
  };
}

function idField<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, string>>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeMessage(error: Error): string {
  return error.message.slice(0, 500);
}
