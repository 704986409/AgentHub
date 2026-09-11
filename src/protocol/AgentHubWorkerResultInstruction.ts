import { agentHubResultCloseTag, agentHubResultOpenTag } from './AgentHubWorkerResultParser.js';

export function buildAgentHubWorkerResultInstruction(): string {
  return [
    `At the end of your final response, output exactly one ${agentHubResultOpenTag} block followed by ${agentHubResultCloseTag}.`,
    'Inside the block, output raw JSON only: no Markdown code fence, and do not include either marker token in JSON strings.',
    'Set protocolVersion to 1 and include exactly these fields: protocolVersion, outcome, summary, changedFiles, checks, blockers, questions, risks, notes.',
    'outcome must be one of: COMPLETED, FAILED, BLOCKED, NEEDS_INPUT.',
    'Each checks item must contain exactly name, status, detail; status must be PASSED, FAILED, or NOT_RUN.',
    'All fields are required. Use empty arrays where appropriate and add no additional fields.',
  ].join('\n');
}
