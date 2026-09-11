import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setInterval, setTimeout } from 'node:timers';

const mode = process.argv[2] ?? 'quick';

if (mode.startsWith('persistent-')) {
  runPersistent(mode);
} else if (mode === 'quick') {
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

function runPersistent(scenario) {
  const args = process.argv.slice(3);
  const resumedSession = readOption(args, '--resume');
  const baseSession = resumedSession ?? 'persistent-session-A';
  let turnCount = 0;
  let marker;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  if (scenario === 'persistent-unexpected-idle-result') {
    setTimeout(() => emit({ type: 'result', session_id: baseSession, result: 'idle' }), 25);
  }
  if (scenario === 'persistent-idle-parser-error') {
    setTimeout(() => process.stdout.write('{bad idle json}\n'), 25);
  }
  if (scenario === 'persistent-idle-assistant') {
    setTimeout(() => emit({ type: 'assistant', text: 'idle output' }), 25);
  }

  input.on('line', (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      process.exitCode = 65;
      input.close();
      return;
    }
    if (frame?.type !== 'user' || frame?.message?.role !== 'user' || typeof frame?.message?.content !== 'string') {
      process.exitCode = 66;
      input.close();
      return;
    }
    turnCount += 1;
    const prompt = frame.message.content;

    if (scenario === 'persistent-hang') return;
    if (scenario === 'persistent-parser-error') {
      process.stdout.write('{bad json}\n');
      setTimeout(() => emit({ type: 'assistant', text: 'late' }), 0);
      return;
    }
    if (scenario === 'persistent-exit-busy') {
      process.exit(9);
    }

    const initSession = scenario === 'persistent-initial-resume-mismatch'
      ? 'persistent-session-B'
      : scenario === 'persistent-conflicting-init' && turnCount === 2
        ? 'persistent-session-B'
        : baseSession;
    if ((turnCount === 1 && scenario !== 'persistent-missing-session') ||
      scenario === 'persistent-repeated-init' || scenario === 'persistent-conflicting-init' ||
      scenario === 'persistent-initial-resume-mismatch') {
      emit({ type: 'system', subtype: 'init', session_id: initSession, pid: process.pid });
    }
    emit({ type: 'assistant', text: 'fixture assistant' });

    if (scenario === 'persistent-context') {
      const match = prompt.match(/AGENTHUB_PERSISTENT_[A-Za-z0-9-]+/u);
      if (match !== null) marker = match[0];
    }
    if (scenario === 'persistent-stderr') process.stderr.write(`INFO turn ${String(turnCount)} diagnostic\n`);
    const resultSession = scenario === 'persistent-conflicting-session'
      ? 'persistent-session-B'
      : scenario === 'persistent-missing-session' ? undefined : initSession;
    const result = scenario === 'persistent-input-roundtrip'
      ? prompt
      : scenario === 'persistent-context' && turnCount > 1
        ? marker ?? 'missing-marker'
        : `turn-${String(turnCount)}`;
    emit({
      type: 'result',
      subtype: 'success',
      session_id: resultSession,
      result,
      is_error: scenario === 'persistent-error-result',
      input_frame_count: turnCount,
    });
    if (scenario === 'persistent-duplicate-result') {
      emit({ type: 'result', subtype: 'success', session_id: resultSession, result: 'duplicate' });
    }
    if (scenario === 'persistent-exit-after-result') setTimeout(() => process.exit(0), 50);
  });
}
