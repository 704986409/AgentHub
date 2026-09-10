export enum AgentRuntimeEventType {
  AGENT_EXECUTION_STARTED = 'AgentExecutionStarted',
  AGENT_EXECUTION_COMPLETED = 'AgentExecutionCompleted',
  AGENT_EXECUTION_FAILED = 'AgentExecutionFailed',
  AGENT_MESSAGE_DELTA = 'AgentMessageDelta',
  AGENT_MESSAGE_COMPLETED = 'AgentMessageCompleted',
  AGENT_OPERATION_STARTED = 'AgentOperationStarted',
  AGENT_OPERATION_COMPLETED = 'AgentOperationCompleted',
  AGENT_APPROVAL_REQUIRED = 'AgentApprovalRequired',
  AGENT_INPUT_REQUIRED = 'AgentInputRequired',
  AGENT_RUNTIME_ERROR = 'AgentRuntimeError',
  PROVIDER_EVENT_OBSERVED = 'ProviderEventObserved',
  PROVIDER_PROCESS_EXITED = 'ProviderProcessExited',
  PROVIDER_ERROR = 'ProviderError',
}

export interface AgentRuntimeContext {
  provider: string;
  projectId?: string;
  agentId?: string;
  taskId?: string;
  assignmentId?: string;
}
