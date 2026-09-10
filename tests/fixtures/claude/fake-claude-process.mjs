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
} else {
  process.stderr.write(`Unknown fixture mode: ${mode}\n`);
  process.exitCode = 64;
}
