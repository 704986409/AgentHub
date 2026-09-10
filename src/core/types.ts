export enum AgentStatus {
  IDLE = 'IDLE',
  BUSY = 'BUSY',
  OFFLINE = 'OFFLINE',
  DISABLED = 'DISABLED',
}

export enum TaskStatus {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
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
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
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
  status: TaskStatus;
  complexity: TaskComplexity;
  risk: TaskRisk;
  createdAt: string;
  updatedAt: string;
}

export interface Assignment {
  id: string;
  taskId: string;
  agentId: string;
  status: AssignmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentHubEvent {
  id: string;
  projectId: string | null;
  entityType: string;
  entityId: string | null;
  eventType: string;
  payload: unknown;
  createdAt: string;
}
