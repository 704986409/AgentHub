import { describe, expect, it } from 'vitest';

import {
  ClaudeJsonlParser,
  type ClaudeJsonlParseError,
  type ClaudeRawMessage,
} from '../src/index.js';

describe('Claude JSONL parser', () => {
  it('frames fragmented and multiple JSON lines with CRLF, whitespace, and empty lines', () => {
    const { parser, messages, errors } = createParser();
    parser.push(Buffer.from('{"a":'));
    parser.push(Buffer.from('1}\r\n\n  {"b":2}  \n{"c"'));
    parser.push(Buffer.from(':3}\n'));
    parser.end();

    expect(messages).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(errors).toEqual([]);
    expect(parser.lineNumber).toBe(4);
  });

  it('preserves UTF-8 characters split across Buffer chunk boundaries', () => {
    const { parser, messages, errors } = createParser();
    const encoded = Buffer.from('{"text":"中文🙂"}\n', 'utf8');
    const chineseBoundary = encoded.indexOf(Buffer.from('中')) + 1;
    const emojiBoundary = encoded.indexOf(Buffer.from('🙂')) + 2;
    parser.push(encoded.subarray(0, chineseBoundary));
    parser.push(encoded.subarray(chineseBoundary, emojiBoundary));
    parser.push(encoded.subarray(emojiBoundary));
    parser.end();

    expect(messages).toEqual([{ text: '中文🙂' }]);
    expect(errors).toEqual([]);
  });

  it('flushes a valid final object without a trailing newline exactly once', () => {
    const { parser, messages, errors } = createParser();
    parser.push(Buffer.from('{"type":"result"}'));
    parser.end();
    parser.end();

    expect(messages).toEqual([{ type: 'result' }]);
    expect(errors).toEqual([]);
  });

  it.each([
    ['malformed JSON', '{"type":\n', 'CLAUDE_JSONL_INVALID_JSON'],
    ['null root', 'null\n', 'CLAUDE_JSONL_INVALID_ROOT'],
    ['array root', '[]\n', 'CLAUDE_JSONL_INVALID_ROOT'],
    ['string root', '"value"\n', 'CLAUDE_JSONL_INVALID_ROOT'],
  ])('enters terminal failure for %s', (_name, input, code) => {
    const { parser, messages, errors } = createParser();
    parser.push(Buffer.from(input));

    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code, lineNumber: 1 });
    expect(errors[0]?.message).not.toContain(input.trim());
    expect(parser.failed).toBe(true);
    expect(captureError(() => parser.push(Buffer.from('{"valid":true}\n')))).toMatchObject({
      code: 'CLAUDE_JSONL_PARSER_FAILED',
    });
  });

  it('rejects oversized complete and incomplete lines without retaining content', () => {
    const complete = createParser(8);
    complete.parser.push(Buffer.from('{"long":123}\n'));
    expect(complete.errors[0]).toMatchObject({ code: 'CLAUDE_JSONL_LINE_TOO_LARGE', lineNumber: 1 });

    const incomplete = createParser(4);
    incomplete.parser.push(Buffer.from('12345'));
    expect(incomplete.errors[0]).toMatchObject({ code: 'CLAUDE_JSONL_LINE_TOO_LARGE', lineNumber: 1 });
    expect(incomplete.messages).toEqual([]);
  });

  it('reports partial invalid JSON at EOF and rejects push after a clean end', () => {
    const partial = createParser();
    partial.parser.push(Buffer.from('{"type":'));
    partial.parser.end();
    expect(partial.errors[0]).toMatchObject({ code: 'CLAUDE_JSONL_INVALID_JSON', lineNumber: 1 });

    const closed = createParser();
    closed.parser.end();
    expect(captureError(() => closed.parser.push(Buffer.from('{}\n')))).toMatchObject({
      code: 'CLAUDE_JSONL_PARSER_CLOSED',
    });
  });

  it('does not mutate raw parsed messages', () => {
    const { parser, messages } = createParser();
    parser.push(Buffer.from('{"type":"assistant","token":"raw","nested":{"value":1}}\n'));
    parser.end();
    expect(messages[0]).toEqual({ type: 'assistant', token: 'raw', nested: { value: 1 } });
  });
});

function createParser(maxLineBytes?: number): {
  parser: ClaudeJsonlParser;
  messages: ClaudeRawMessage[];
  errors: ClaudeJsonlParseError[];
} {
  const messages: ClaudeRawMessage[] = [];
  const errors: ClaudeJsonlParseError[] = [];
  const parser = new ClaudeJsonlParser({
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
    ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
  });
  return { parser, messages, errors };
}

function captureError(action: () => void): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}
