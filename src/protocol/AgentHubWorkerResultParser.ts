import {
  AgentHubWorkerResultSchema,
  agentHubWorkerResultLimits,
  validateAgentHubWorkerResultSemantics,
  type AgentHubWorkerResult,
} from './AgentHubWorkerResult.js';
import type { SchemaIssue } from './ManagerDirective.js';

export const agentHubResultOpenTag = '<AGENTHUB_RESULT>';
export const agentHubResultCloseTag = '</AGENTHUB_RESULT>';

export type AgentHubWorkerResultFailureKind =
  | 'missing_result'
  | 'multiple_results'
  | 'result_too_large'
  | 'malformed_json'
  | 'schema_invalid'
  | 'semantic_invalid';

export interface AgentHubWorkerResultFailure {
  kind: AgentHubWorkerResultFailureKind;
  message: string;
}

export type AgentHubWorkerResultParseResult =
  | { success: true; result: AgentHubWorkerResult }
  | { success: false; failure: AgentHubWorkerResultFailure };

export class AgentHubWorkerResultParser {
  public parse(text: string): AgentHubWorkerResultParseResult {
    if (text.length > agentHubWorkerResultLimits.maxResponseChars) {
      return failure('result_too_large', 'The AgentHub worker response exceeds the scan limit');
    }

    const openIndexes = findAll(text, agentHubResultOpenTag);
    const closeIndexes = findAll(text, agentHubResultCloseTag);
    if (openIndexes.length > 1 || closeIndexes.length > 1) {
      return failure('multiple_results', 'Expected exactly one AgentHub result block');
    }
    if (openIndexes.length !== 1 || closeIndexes.length !== 1 || openIndexes[0] === undefined || closeIndexes[0] === undefined) {
      return failure('missing_result', 'A complete AgentHub result block is required');
    }

    const openIndex = openIndexes[0];
    const closeIndex = closeIndexes[0];
    const contentStart = openIndex + agentHubResultOpenTag.length;
    if (closeIndex < contentStart) {
      return failure('missing_result', 'The AgentHub result closing tag is misplaced');
    }

    const jsonText = text.slice(contentStart, closeIndex).trim();
    if (utf8ByteLength(jsonText) > agentHubWorkerResultLimits.maxBlockBytes) {
      return failure('result_too_large', 'The AgentHub result block exceeds the size limit');
    }
    if (jsonText.length === 0) return failure('malformed_json', 'The AgentHub result block is empty');

    let value: unknown;
    try {
      value = JSON.parse(jsonText) as unknown;
    } catch {
      return failure('malformed_json', 'The AgentHub result contains malformed JSON');
    }

    const schemaResult = AgentHubWorkerResultSchema.safeParse(value);
    if (!schemaResult.success) return failure('schema_invalid', summarizeIssues(schemaResult.issues));

    const semanticIssues = validateAgentHubWorkerResultSemantics(schemaResult.data);
    if (semanticIssues.length > 0) return failure('semantic_invalid', summarizeIssues(semanticIssues));

    return { success: true, result: schemaResult.data };
  }
}

function findAll(text: string, token: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= text.length - token.length) {
    const index = text.indexOf(token, offset);
    if (index < 0) break;
    indexes.push(index);
    offset = index + token.length;
  }
  return indexes;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function summarizeIssues(issues: readonly SchemaIssue[]): string {
  return limitFailureMessage(issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join('; '));
}

function failure(kind: AgentHubWorkerResultFailureKind, message: string): AgentHubWorkerResultParseResult {
  return { success: false, failure: { kind, message: limitFailureMessage(message) } };
}

function limitFailureMessage(message: string): string {
  const limit = agentHubWorkerResultLimits.maxFailureMessageChars;
  if (message.length <= limit) return message;
  return `${message.slice(0, limit - 1)}…`;
}
