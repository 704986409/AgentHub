import process from 'node:process';
import { setTimeout } from 'node:timers';

const scenario = process.argv[2] ?? 'success';
let buffer = '';
let initialized = false;
let turnNumber = 0;

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
    send({ id: message.id, result: { thread: { id: 'manager-thread-1' } } });
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
    setTimeout(() => emitTurn(message.params.threadId, turnId), 5);
  }
}

function emitTurn(threadId, turnId) {
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

  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
  send({ method: 'fixture/progress', params: { threadId, turnId, progress: 0.5 } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message-1', delta: 'O' } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'message-1', delta: 'K' } });
  send({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: { type: 'agentMessage', id: 'message-1', text: 'OK', phase: 'final_answer' },
    },
  });
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status: 'completed', items: [] } },
  });
}
