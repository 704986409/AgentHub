import {
  ManagerDirectiveSchema,
  validateManagerDirectiveSemantics,
  type ManagerDirective,
  type SchemaIssue,
} from './ManagerDirective.js';

export const managerDirectiveOpenTag = '<AGENTHUB_DIRECTIVE>';
export const managerDirectiveCloseTag = '</AGENTHUB_DIRECTIVE>';

export type ManagerDirectiveFailureKind =
  | 'missing_directive'
  | 'multiple_directives'
  | 'malformed_json'
  | 'schema_invalid'
  | 'semantic_invalid';

export interface ManagerDirectiveFailure {
  kind: ManagerDirectiveFailureKind;
  message: string;
}

export type ManagerDirectiveParseResult =
  | { success: true; directive: ManagerDirective }
  | { success: false; failure: ManagerDirectiveFailure };

export class ManagerDirectiveParser {
  public parse(text: string): ManagerDirectiveParseResult {
    const openIndexes = findAll(text, managerDirectiveOpenTag);
    const closeIndexes = findAll(text, managerDirectiveCloseTag);
    if (openIndexes.length > 1 || closeIndexes.length > 1) {
      return failure('multiple_directives', 'Expected exactly one AgentHub directive block');
    }
    if (openIndexes.length !== 1 || closeIndexes.length !== 1 || closeIndexes[0] === undefined || openIndexes[0] === undefined) {
      return failure('missing_directive', 'A complete AgentHub directive block is required');
    }
    const openIndex = openIndexes[0];
    const closeIndex = closeIndexes[0];
    const contentStart = openIndex + managerDirectiveOpenTag.length;
    if (closeIndex < contentStart) {
      return failure('missing_directive', 'The AgentHub directive closing tag is misplaced');
    }
    const jsonText = text.slice(contentStart, closeIndex).trim();
    if (jsonText.length === 0) return failure('malformed_json', 'The AgentHub directive block is empty');

    let value: unknown;
    try {
      value = JSON.parse(jsonText) as unknown;
    } catch {
      return failure('malformed_json', 'The AgentHub directive contains malformed JSON');
    }

    const schemaResult = ManagerDirectiveSchema.safeParse(value);
    if (!schemaResult.success) {
      return failure('schema_invalid', summarizeIssues(schemaResult.issues));
    }
    const semanticIssues = validateManagerDirectiveSemantics(schemaResult.data);
    if (semanticIssues.length > 0) {
      return failure('semantic_invalid', summarizeIssues(semanticIssues));
    }
    return { success: true, directive: schemaResult.data };
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

function summarizeIssues(issues: readonly SchemaIssue[]): string {
  return issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}

function failure(kind: ManagerDirectiveFailureKind, message: string): ManagerDirectiveParseResult {
  return { success: false, failure: { kind, message } };
}
