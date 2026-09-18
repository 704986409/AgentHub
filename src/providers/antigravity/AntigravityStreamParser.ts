export class AntigravityStreamParseError extends Error {
  public constructor(
    public readonly code:
      | 'ANTIGRAVITY_LINE_OVERFLOW'
      | 'ANTIGRAVITY_BUFFER_OVERFLOW'
      | 'ANTIGRAVITY_PARSE_FAILED'
      | 'ANTIGRAVITY_MALFORMED_JSON'
      | 'ANTIGRAVITY_DUPLICATE_TERMINAL'
      | 'ANTIGRAVITY_IDENTITY_CONFLICT'
      | 'ANTIGRAVITY_IDENTITY_BLANK'
      | 'ANTIGRAVITY_MISSING_TERMINAL',
    message: string,
  ) {
    super(message);
    this.name = 'AntigravityStreamParseError';
  }
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MiB

const TERMINAL_TYPES = new Set(['result', 'terminal', 'done', 'turn_complete']);

export class AntigravityStreamParser {
  readonly #maxLineBytes: number;
  readonly #maxTotalBytes: number;
  #totalBytes = 0;
  #buffer = '';
  #capturedConversationId: string | undefined;
  #accumulatedText = '';
  #terminalFound = false;
  #failed = false;

  public constructor(options: { maxLineBytes?: number; maxTotalBytes?: number } = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  public get capturedConversationId(): string | undefined {
    return this.#capturedConversationId;
  }

  public get accumulatedText(): string {
    return this.#accumulatedText;
  }

  public get isTerminal(): boolean {
    return this.#terminalFound;
  }

  public feed(chunk: string): void {
    this.#assertNotFailed();
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    this.#totalBytes += chunkBytes;
    if (this.#totalBytes > this.#maxTotalBytes) {
      this.#fail(
        new AntigravityStreamParseError(
          'ANTIGRAVITY_BUFFER_OVERFLOW',
          `Antigravity stream output exceeded limit of ${String(this.#maxTotalBytes)} bytes`,
        ),
      );
    }

    this.#buffer += chunk;
    let newlineIndex = this.#buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trimEnd();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);

      if (Buffer.byteLength(line, 'utf8') > this.#maxLineBytes) {
        this.#fail(
          new AntigravityStreamParseError(
            'ANTIGRAVITY_LINE_OVERFLOW',
            `Antigravity stream line exceeded limit of ${String(this.#maxLineBytes)} bytes`,
          ),
        );
      }

      if (line.trim().length > 0) {
        this.#processLine(line);
      }

      newlineIndex = this.#buffer.indexOf('\n');
    }

    if (Buffer.byteLength(this.#buffer, 'utf8') > this.#maxLineBytes) {
      this.#fail(
        new AntigravityStreamParseError(
          'ANTIGRAVITY_LINE_OVERFLOW',
          `Antigravity stream line buffer exceeded limit of ${String(this.#maxLineBytes)} bytes`,
        ),
      );
    }
  }

  public finish(): { conversationId?: string; responseText: string } {
    this.#assertNotFailed();
    if (this.#buffer.trim().length > 0) {
      this.#processLine(this.#buffer.trim());
      this.#buffer = '';
    }

    if (!this.#terminalFound) {
      this.#fail(
        new AntigravityStreamParseError(
          'ANTIGRAVITY_MISSING_TERMINAL',
          'Antigravity stream completed without a terminal result frame',
        ),
      );
    }

    return {
      ...(this.#capturedConversationId !== undefined ? { conversationId: this.#capturedConversationId } : {}),
      responseText: this.#accumulatedText,
    };
  }

  #processLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.#fail(
        new AntigravityStreamParseError(
          'ANTIGRAVITY_MALFORMED_JSON',
          'Antigravity stream-json stdout contained a malformed JSON frame',
        ),
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.#fail(
        new AntigravityStreamParseError(
          'ANTIGRAVITY_MALFORMED_JSON',
          'Antigravity stream-json frame must be a JSON object',
        ),
      );
    }

    this.#handleParsedObject(parsed as Record<string, unknown>);
  }

  #handleParsedObject(obj: Record<string, unknown>): void {
    this.#observeIdentity(obj);

    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';

    if (TERMINAL_TYPES.has(type)) {
      if (this.#terminalFound) {
        this.#fail(
          new AntigravityStreamParseError(
            'ANTIGRAVITY_DUPLICATE_TERMINAL',
            'Antigravity stream contained more than one terminal result frame',
          ),
        );
      }
      this.#terminalFound = true;
      const text = obj.text ?? obj.content ?? obj.result ?? obj.response;
      if (typeof text === 'string') {
        if (!this.#accumulatedText.includes(text)) {
          if (this.#accumulatedText.length > 0) this.#accumulatedText += '\n';
          this.#accumulatedText += text;
        }
      }
      return;
    }

    const msg = typeof obj.message === 'object' && obj.message !== null ? (obj.message as Record<string, unknown>) : undefined;
    const content = obj.content ?? obj.text ?? obj.delta ?? msg?.content;
    if (typeof content === 'string' && content.length > 0) {
      if (this.#accumulatedText.length > 0 && !this.#accumulatedText.endsWith('\n') && !content.startsWith('\n')) {
        this.#accumulatedText += '\n';
      }
      this.#accumulatedText += content;
    }
  }

  #observeIdentity(obj: Record<string, unknown>): void {
    const conv = typeof obj.conversation === 'object' && obj.conversation !== null ? (obj.conversation as Record<string, unknown>) : undefined;
    const candidates: unknown[] = [obj.conversation_id, obj.conversationId, conv?.id];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      if (typeof candidate !== 'string') {
        this.#fail(
          new AntigravityStreamParseError(
            'ANTIGRAVITY_IDENTITY_CONFLICT',
            'Antigravity conversation identity must be a string',
          ),
        );
      }
      const id = candidate.trim();
      if (id.length === 0) {
        this.#fail(
          new AntigravityStreamParseError(
            'ANTIGRAVITY_IDENTITY_BLANK',
            'Antigravity conversation identity was blank',
          ),
        );
      }
      if (this.#capturedConversationId === undefined) {
        this.#capturedConversationId = id;
        continue;
      }
      if (this.#capturedConversationId !== id) {
        this.#fail(
          new AntigravityStreamParseError(
            'ANTIGRAVITY_IDENTITY_CONFLICT',
            `Antigravity conversation identity conflict: locked ${this.#capturedConversationId}, got ${id}`,
          ),
        );
      }
    }
  }

  #assertNotFailed(): void {
    if (this.#failed) {
      throw new AntigravityStreamParseError(
        'ANTIGRAVITY_PARSE_FAILED',
        'Antigravity stream parser is in a terminal failed state',
      );
    }
  }

  #fail(error: AntigravityStreamParseError): never {
    this.#failed = true;
    throw error;
  }
}
