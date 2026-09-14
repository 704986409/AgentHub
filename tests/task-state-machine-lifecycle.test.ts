import { describe, expect, it } from 'vitest';
import { TaskStateMachine, TaskStatus } from '../src/index.js';

describe('TaskStateMachine lifecycle resume path', () => {
  it('supports WAITING_INPUT to QUEUED', () => {
    const machine = new TaskStateMachine();
    expect(machine.canTransition(TaskStatus.WAITING_INPUT, TaskStatus.QUEUED)).toBe(true);
    expect(machine.transition(TaskStatus.WAITING_INPUT, TaskStatus.QUEUED)).toBe(TaskStatus.QUEUED);
  });
});
