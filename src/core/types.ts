export enum AgentStatus {
  IDLE = 'IDLE',
  BUSY = 'BUSY',
  OFFLINE = 'OFFLINE',
  DISABLED = 'DISABLED',
}

export enum TaskStatus {
  CREATED = 'CREATED',
  QUEUED = 'QUEUED',
  ASSIGNED = 'ASSIGNED',
  IMPLEMENTING = 'IMPLEMENTING',
  REVIEWING = 'REVIEWING',
  REVISION_REQUIRED = 'REVISION_REQUIRED',
  WAITING_INPUT = 'WAITING_INPUT',
  WAITING_APPROVAL = 'WAITING_APPROVAL',
  WAITING_DEPENDENCY = 'WAITING_DEPENDENCY',
  PAUSED = 'PAUSED',
  BLOCKED = 'BLOCKED',
  FAILED = 'FAILED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
}

export enum TaskComplexity {
  TRIVIAL = 'TRIVIAL',
  SIMPLE = 'SIMPLE',
  MEDIUM = 'MEDIUM',
  COMPLEX = 'COMPLEX',
  CRITICAL = 'CRITICAL',
}

export enum TaskRisk {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum AssignmentStatus {
  DISPATCHING = 'DISPATCHING',
  ACCEPTED = 'ACCEPTED',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  RELEASED = 'RELEASED',
  STALE = 'STALE',
  PENDING = 'PENDING',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export enum AgentCapability {
  PLANNING = 'PLANNING',
  CODING = 'CODING',
  RESEARCH = 'RESEARCH',
  REVIEW = 'REVIEW',
  TOOL_USE = 'TOOL_USE',
}

export enum AgentAuthority {
  READ_ONLY = 'READ_ONLY',
  STANDARD = 'STANDARD',
  PRIVILEGED = 'PRIVILEGED',
  ADMIN = 'ADMIN',
}

export enum DomainEventType {
  AGENT_CREATED = 'AgentCreated',
  AGENT_UPDATED = 'AgentUpdated',
  AGENT_LOCKED = 'AgentLocked',
  AGENT_UNLOCKED = 'AgentUnlocked',
  TASK_CREATED = 'TaskCreated',
  TASK_STATUS_CHANGED = 'TaskStatusChanged',
  ASSIGNMENT_CREATED = 'AssignmentCreated',
  ASSIGNMENT_ACCEPTED = 'AssignmentAccepted',
  ASSIGNMENT_COMPLETED = 'AssignmentCompleted',
  SYSTEM_ERROR = 'SystemError',
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  projectId: string | null;
  name: string;
  provider: string;
  model: string;
  position: string;
  status: AgentStatus;
  allowedComplexities: TaskComplexity[];
  allowedRiskLevels: TaskRisk[];
  capabilities: string[];
  specialties: string[];
  authority: AgentAuthority;
  routingPriority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  requiredCapabilities: string[];
  requiredSpecialties: string[];
  acceptanceCriteria: string[];
  status: TaskStatus;
  complexity: TaskComplexity;
  risk: TaskRisk;
  assignedAgentId: string | null;
  assignmentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Assignment {
  id: string;
  assignmentId: string;
  taskId: string;
  agentId: string;
  specVersion: string;
  profileHash: string;
  status: AssignmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentHubEvent {
  id: string;
  eventId: string;
  eventType: DomainEventType | string;
  projectId: string | null;
  agentId: string | null;
  taskId: string | null;
  assignmentId: string | null;
  entityType: string;
  entityId: string | null;
  payload: unknown;
  actor: string | null;
  oldStatus: string | null;
  newStatus: string | null;
  timestamp: string;
  createdAt: string;
}
