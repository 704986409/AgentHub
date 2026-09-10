import process from 'node:process';
import { setTimeout } from 'node:timers';

const scenario = process.argv[2] ?? 'success';
let buffer = '';
let initialized = false;
let turnNumber = 0;
let pendingServerRequest;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handle(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (message.method === undefined && message.id === 'server-request-1' && pendingServerRequest !== undefined) {
    if (message.result?.decision === 'accept') {
      const { threadId, turnId } = pendingServerRequest;
      pendingServerRequest = undefined;
      emitTurn(threadId, turnId);
    }
    return;
  }
  if (message.method === 'initialize') {
    send({ id: message.id, result: { platformFamily: 'fixture', platformOs: 'fixture' } });
    return;
  }
  if (message.method === 'initialized') {
    initialized = true;
    return;
  }
  if (message.method === 'thread/start') {
    if (!initialized) {
      send({ id: message.id, error: { code: -32000, message: 'not initialized' } });
      return;
    }
    send({ id: message.id, result: { thread: { id: 'manager-thread-1', sessionId: 'manager-session-1' } } });
    return;
  }
  if (message.method === 'turn/start') {
    turnNumber += 1;
    const turnId = `manager-turn-${turnNumber}`;
    if (scenario === 'unmatched') {
      send({ id: `wrong-${String(message.id)}`, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (scenario === 'server-request') {
      pendingServerRequest = { threadId: message.params.threadId, turnId };
      setTimeout(() => send({
        id: 'server-request-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          itemId: 'command-1',
          threadId: message.params.threadId,
          turnId,
          reason: 'fixture approval',
        },
      }), 5);
      return;
    }
    const promptAccepted = scenario !== 'manager-prompt-valid' || validateManagerPrompt(message.params);
    setTimeout(() => emitTurn(message.params.threadId, turnId, promptAccepted), 5);
  }
}

function emitTurn(threadId, turnId, promptAccepted = true) {
  if (scenario === 'capacity') {
    send({
      method: 'error',
      params: {
        threadId,
        turnId,
        willRetry: false,
        error: { message: 'Selected model is at capacity', codexErrorInfo: 'serverOverloaded' },
      },
    });
    return;
  }
  if (scenario === 'malformed') {
    process.stdout.write('{not-json}\n');
    return;
  }
  if (scenario === 'exit') {
    process.exitCode = 7;
    process.stdin.destroy();
    return;
  }
  if (scenario === 'hang') return;

  const outputText = directiveOutput(turnId, promptAccepted);
  const splitAt = Math.ceil(outputText.length / 2);
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
  send({ method: 'fixture/progress', params: { threadId, turnId, progress: 0.5 } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message-1', delta: outputText.slice(0, splitAt) } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message-1', delta: outputText.slice(splitAt) } });
  send({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: { type: 'agentMessage', id: 'message-1', text: outputText, phase: 'final_answer' },
    },
  });
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status: 'completed', items: [] } },
  });
}

function directiveOutput(turnId, promptAccepted) {
  if (scenario === 'manager-prompt-valid') return promptAccepted ? envelopeDirective : 'Invalid Manager prompt.';
  if (scenario === 'directive-valid') return validDirective;
  if (scenario === 'directive-repair-success') return turnId.endsWith('-1') ? 'No control block.' : validDirective;
  if (scenario === 'directive-repair-invalid') return 'No control block.';
  return 'OK';
}

function validateManagerPrompt(params) {
  const prompt = params?.input?.[0]?.text;
  if (typeof prompt !== 'string') return false;
  const expectedOrder = [
    '[AGENTHUB_MANAGER_ROLE_JSON]',
    '[PROJECT_JSON]',
    '[USER_REQUIREMENT_JSON]',
    '[CURRENT_TASK_JSON]',
    '[AGENTHUB_INSTRUCTIONS]',
  ];
  let lastIndex = -1;
  for (const section of expectedOrder) {
    const index = prompt.indexOf(section);
    if (index <= lastIndex) return false;
    lastIndex = index;
  }
  return prompt.includes(JSON.stringify({ text: 'Development Manager role' }))
    && prompt.includes(JSON.stringify({
      workspace: 'D:\\Code\\Demo',
      targetBranch: 'main',
      repositoryRules: ['Use TypeScript', 'No destructive Git'],
    }))
    && prompt.includes(JSON.stringify({ text: 'Add save support' }))
    && prompt.includes('Produce exactly one final <AGENTHUB_DIRECTIVE> block.');
}

const validDirective = [
  '<AGENTHUB_DIRECTIVE>',
  JSON.stringify({
    action: 'INFORM',
    taskId: 'FIXTURE',
    title: 'Fixture',
    instructions: '',
    acceptanceCriteria: [],
    issues: [],
    requestedChecks: [],
    summary: 'OK',
  }),
  '</AGENTHUB_DIRECTIVE>',
].join('\n');

const envelopeDirective = [
  '<AGENTHUB_DIRECTIVE>',
  JSON.stringify({
    action: 'INFORM',
    taskId: 'ENVELOPE',
    title: 'Envelope received',
    instructions: '',
    acceptanceCriteria: [],
    issues: [],
    requestedChecks: [],
    summary: 'PROMPT_CONTEXT_RECEIVED',
  }),
  '</AGENTHUB_DIRECTIVE>',
].join('\n');
