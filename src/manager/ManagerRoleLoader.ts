import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ManagerPromptDiagnosticRecorder } from './ManagerPromptDiagnostics.js';

export type ManagerRoleLoadErrorCode =
  | 'MANAGER_ROLE_NOT_FOUND'
  | 'MANAGER_ROLE_EMPTY'
  | 'MANAGER_ROLE_READ_FAILED';

export class ManagerRoleLoadError extends Error {
  public constructor(
    public readonly code: ManagerRoleLoadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManagerRoleLoadError';
  }
}

export interface ManagerRoleLoaderOptions {
  roleFilePath: string;
  baseDirectory?: string;
  diagnostics?: ManagerPromptDiagnosticRecorder;
}

export class ManagerRoleLoader {
  readonly #roleFilePath: string;
  readonly #diagnostics: ManagerPromptDiagnosticRecorder | undefined;

  public constructor(options: ManagerRoleLoaderOptions) {
    if (options.roleFilePath.trim().length === 0) {
      throw new ManagerRoleLoadError('MANAGER_ROLE_NOT_FOUND', 'Manager role file path must not be blank');
    }
    this.#roleFilePath = path.resolve(options.baseDirectory ?? process.cwd(), options.roleFilePath);
    this.#diagnostics = options.diagnostics;
  }

  public get roleFilePath(): string {
    return this.#roleFilePath;
  }

  public async load(): Promise<string> {
    let prompt: string;
    try {
      prompt = await readFile(this.#roleFilePath, 'utf8');
    } catch (error) {
      const code = isNodeError(error) && error.code === 'ENOENT'
        ? 'MANAGER_ROLE_NOT_FOUND'
        : 'MANAGER_ROLE_READ_FAILED';
      this.#diagnostics?.record('manager_role.read.failed', { code });
      throw new ManagerRoleLoadError(code, `Unable to read Manager role file: ${this.#roleFilePath}`, { cause: error });
    }
    if (prompt.trim().length === 0) {
      this.#diagnostics?.record('manager_role.read.failed', { code: 'MANAGER_ROLE_EMPTY' });
      throw new ManagerRoleLoadError('MANAGER_ROLE_EMPTY', `Manager role file is empty: ${this.#roleFilePath}`);
    }
    this.#diagnostics?.record('manager_role.read.success', {
      rolePromptChars: prompt.length,
      rolePromptHash: `sha256:${createHash('sha256').update(prompt, 'utf8').digest('hex')}`,
    });
    return prompt;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
