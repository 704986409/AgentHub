import { describe, expect, expectTypeOf, it } from 'vitest';

import { TaskComplexity, TaskRisk } from '../src/index.js';

describe('core types', () => {
  it('keeps task complexity and task risk as distinct types and value sets', () => {
    expectTypeOf<TaskComplexity>().not.toEqualTypeOf<TaskRisk>();
    expect(Object.values(TaskComplexity)).toEqual(['TRIVIAL', 'SIMPLE', 'MEDIUM', 'COMPLEX', 'CRITICAL']);
    expect(Object.values(TaskRisk)).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  });
});
