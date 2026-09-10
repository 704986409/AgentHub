import { describe, expect, it } from 'vitest';

import {
  ClaudeExecutableResolutionError,
  resolveClaudeExecutable,
  type ClaudeExecutableResolverDependencies,
} from '../src/index.js';

const windowsDependencies: ClaudeExecutableResolverDependencies = {
  platform: 'win32',
  exists: () => true,
  realpath: (path) => `real:${path}`,
  findOnPath: () => [],
};

describe('Claude executable resolver', () => {
  it('honors an explicit path before CLAUDE_EXECUTABLE', () => {
    const result = resolveClaudeExecutable(
      'C:\\Other\\claude.exe',
      { CLAUDE_EXECUTABLE: 'C:\\Tools\\claude.exe' },
      windowsDependencies,
    );
    expect(result).toBe('real:C:\\Other\\claude.exe');
  });

  it('uses CLAUDE_EXECUTABLE for the default command', () => {
    const result = resolveClaudeExecutable(
      'claude',
      { CLAUDE_EXECUTABLE: 'C:\\Tools\\claude.exe' },
      windowsDependencies,
    );
    expect(result).toBe('real:C:\\Tools\\claude.exe');
  });

  it('prefers claude.exe when where.exe returns script shims first', () => {
    const result = resolveClaudeExecutable('claude', {}, {
      ...windowsDependencies,
      findOnPath: () => ['C:\\bin\\claude.cmd', 'C:\\bin\\claude', 'C:\\bin\\claude.exe'],
    });
    expect(result).toBe('real:C:\\bin\\claude.exe');
  });

  it('uses claude.cmd when it is the only Windows candidate', () => {
    const result = resolveClaudeExecutable('claude', {}, {
      ...windowsDependencies,
      findOnPath: () => ['C:\\bin\\claude.cmd'],
    });
    expect(result).toBe('real:C:\\bin\\claude.cmd');
  });

  it('reports an explicit missing path without falling back to PATH', () => {
    let pathLookupCount = 0;
    expect(() => resolveClaudeExecutable('C:\\missing\\claude.exe', {}, {
      ...windowsDependencies,
      exists: () => false,
      findOnPath: () => {
        pathLookupCount += 1;
        return ['C:\\bin\\claude.exe'];
      },
    })).toThrow(ClaudeExecutableResolutionError);
    expect(pathLookupCount).toBe(0);
  });
});
