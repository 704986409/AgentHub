export type ManagerPromptDiagnosticEventType =
  | 'manager_prompt.build.start'
  | 'manager_prompt.build.success'
  | 'manager_prompt.validation_failed'
  | 'manager_role.read.success'
  | 'manager_role.read.failed';

export interface ManagerPromptDiagnosticRecorder {
  record(type: ManagerPromptDiagnosticEventType, details: Record<string, unknown>): void;
}
