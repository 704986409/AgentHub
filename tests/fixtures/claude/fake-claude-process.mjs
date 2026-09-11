import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

const mode = process.argv[2] ?? 'quick';

if (mode === 'quick') {
  process.stdout.write('{"type":"result","ok":true}\n');
} else if (mode === 'exit') {
  process.exitCode = Number(process.argv[3] ?? '7');
} else if (mode === 'stderr') {
  process.stderr.write('INFO normal diagnostic\n');
  process.stdout.write('{"type":"result","ok":true}\n');
} else if (mode === 'jsonl') {
  process.stderr.write('INFO fixture diagnostic\n');
  process.stdout.write(Buffer.from('{"type":"system","subtype":"init","session_id":"fixture-'));
  setTimeout(() => {
    process.stdout.write(Buffer.from('会话"}\r\n{"type":"assistant","text":"ok"}\n{"type":"result","result":"done"}'));
  }, 5);
} else if (mode === 'echo-args') {
  process.stdout.write(`${JSON.stringify({ type: 'args', args: process.argv.slice(3) })}\n`);
} else if (mode === 'stdin-count') {
  let bytes = 0;
  process.stdin.on('data', (chunk) => {
    bytes += chunk.length;
  });
  process.stdin.on('end', () => {
    process.stdout.write(`${JSON.stringify({ type: 'stdin', bytes })}\n`);
  });
} else if (mode === 'hang') {
  process.stdin.resume();
  setInterval(() => undefined, 1_000);
} else if (mode === 'turn-success' || mode === 'turn-success-with-stderr' || mode === 'prompt-args' || mode === 'env-overlay') {
  const args = process.argv.slice(3);
  const resumedSession = readOption(args, '--resume');
  const sessionId = resumedSession ?? 'session-A';
  const prompt = readPrintPrompt(args);
  const result = mode === 'prompt-args'
    ? prompt
    : mode === 'env-overlay'
      ? JSON.stringify({ inheritedPath: typeof process.env.PATH === 'string', custom: process.env.AGENTHUB_TEST_ENV })
      : resumedSession === undefined ? 'first-ok' : 'second-ok';
  if (mode === 'turn-success-with-stderr') process.stderr.write('INFO observer diagnostic\n');
  emitTurn(sessionId, sessionId, result);
} else if (mode === 'missing-result') {
  emit({ type: 'system', subtype: 'init', session_id: 'session-A', pid: process.pid });
  emit({ type: 'assistant', text: 'no terminal result' });
} else if (mode === 'missing-session') {
  emit({ type: 'result', result: 'missing-session' });
} else if (mode === 'init-result-mismatch') {
  emitTurn('session-A', 'session-B', 'mismatch');
} else if (mode === 'resume-return-mismatch') {
  emitTurn('session-B', 'session-B', 'mismatch');
} else if (mode === 'duplicate-result') {
  emitTurn('session-A', 'session-A', 'first');
  emit({ type: 'result', session_id: 'session-A', result: 'second' });
} else if (mode === 'error-result') {
  emit({ type: 'system', subtype: 'init', session_id: 'session-A', pid: process.pid });
  emit({ type: 'result', session_id: 'session-A', result: 'failed', is_error: true });
} else if (mode === 'nonzero-result') {
  emitTurn('session-A', 'session-A', 'present');
  process.exitCode = 7;
} else if (mode === 'resume-fail') {
  process.stderr.write('Session not found\n');
  process.exitCode = 2;
} else if (mode === 'parser-error-hang') {
  process.stdout.write('{bad json}\n');
  setInterval(() => undefined, 1_000);
} else if (mode === 'parser-error-extra-output') {
  process.stdout.write('{bad json}\n');
  setTimeout(() => {
    emit({ type: 'assistant', text: 'late' });
  }, 0);
  setInterval(() => undefined, 1_000);
} else if (mode === 'stop-failure') {
  emitTurn('session-A', 'session-A', 'stop-failure-result');
} else if (mode === 'result-hang') {
  emitTurn('session-A', 'session-A', 'present');
  setInterval(() => undefined, 1_000);
} else {
  process.stderr.write(`Unknown fixture mode: ${mode}\n`);
  process.exitCode = 64;
}

function emitTurn(initSessionId, resultSessionId, result) {
  emit({ type: 'system', subtype: 'init', session_id: initSessionId, pid: process.pid });
  emit({ type: 'assistant', text: 'fixture assistant' });
  emit({ type: 'result', subtype: 'success', session_id: resultSessionId, result });
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function readPrintPrompt(args) {
  const index = args.indexOf('-p');
  return index < 0 ? undefined : args[index + 1];
}
