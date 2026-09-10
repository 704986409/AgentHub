import type { ManagerPromptDiagnosticEventType } from '../../manager/ManagerPromptDiagnostics.js';
import {
  isSensitiveKey,
  REDACTED_VALUE,
  redactSensitiveAssignments,
} from '../../events/sensitive-key-policy.js';

export type CodexDiagnosticEventType =
  | ManagerPromptDiagnosticEventType
  | 'process-started'
  | 'outbound'
  | 'inbound-stdout'
  | 'stderr'
  | 'request-timeout'
  | 'process-exit'
  | 'provider-state'
  | 'turn-event'
  | 'late-turn-event'
  | 'directive.parse.start'
  | 'directive.parse.success'
  | 'directive.parse.failure'
  | 'directive.repair.start'
  | 'directive.repair.completed'
  | 'directive.repair.failure';

export interface CodexDiagnosticEvent {
  timestamp: string;
  type: CodexDiagnosticEventType;
  details: Readonly<Record<string, unknown>>;
}

export type CodexDiagnosticSink = (event: CodexDiagnosticEvent) => void;

/**
 * An in-memory, opt-in protocol trace for diagnosing app-server connections.
 * JSON values are redacted before they enter the trace so callers can safely
 * attach it to support reports.
 */
export class CodexDiagnostics {
  readonly #events: CodexDiagnosticEvent[] = [];

  public constructor(
    private readonly enabled = false,
    private readonly sink?: CodexDiagnosticSink,
  ) {}

  public record(type: CodexDiagnosticEventType, details: Record<string, unknown>): void {
    if (!this.enabled) return;
    const event: CodexDiagnosticEvent = {
      timestamp: new Date().toISOString(),
      type,
      details: redactValue(details) as Record<string, unknown>,
    };
    this.#events.push(event);
    this.sink?.(event);
  }

  public snapshot(): readonly CodexDiagnosticEvent[] {
    return [...this.#events];
  }
}

export function redactProtocolLine(line: string): string {
  try {
    return JSON.stringify(redactValue(JSON.parse(line) as unknown));
  } catch {
    return redactSensitiveAssignments(line, true);
  }
}

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) return REDACTED_VALUE;
  if ((key === 'text' || key === 'delta') && typeof value === 'string') return `[TEXT ${String(value.length)} chars]`;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === 'object' && value !== null) {
    if ('type' in value && value.type === 'reasoning') {
      return { type: 'reasoning', id: 'id' in value ? value.id : undefined, content: REDACTED_VALUE };
    }
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]),
    );
  }
  return value;
}
