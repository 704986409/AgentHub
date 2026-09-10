import type {
  Agent,
  AgentHubEvent,
  AgentStatus,
  AgentAuthority,
  Assignment,
  AssignmentStatus,
  Project,
  Task,
  TaskComplexity,
  TaskRisk,
  TaskStatus,
} from '../core/types.js';

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string | null;
}

export interface CreateAgentInput {
  id?: string;
  projectId?: string | null;
  name: string;
  provider?: string;
  model?: string;
  position?: string;
  status?: AgentStatus;
  allowedComplexities?: TaskComplexity[];
  allowedRiskLevels?: TaskRisk[];
  capabilities?: string[];
  specialties?: string[];
  authority?: AgentAuthority;
  routingPriority?: number;
  enabled?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  provider?: string;
  model?: string;
  position?: string;
  status?: AgentStatus;
  allowedComplexities?: TaskComplexity[];
  allowedRiskLevels?: TaskRisk[];
  capabilities?: string[];
  specialties?: string[];
  authority?: AgentAuthority;
  routingPriority?: number;
  enabled?: boolean;
}

export interface CreateTaskInput {
  id?: string;
  projectId: string;
  title: string;
  description?: string | null;
  requiredCapabilities?: string[];
  requiredSpecialties?: string[];
  acceptanceCriteria?: string[];
  status?: TaskStatus;
  complexity: TaskComplexity;
  risk: TaskRisk;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  requiredCapabilities?: string[];
  requiredSpecialties?: string[];
  acceptanceCriteria?: string[];
  complexity?: TaskComplexity;
  risk?: TaskRisk;
  assignedAgentId?: string | null;
  assignmentId?: string | null;
}

export interface CreateAssignmentInput {
  id?: string;
  taskId: string;
  agentId: string;
  specVersion?: string;
  profileHash?: string;
  status?: AssignmentStatus;
}

export interface UpdateAssignmentInput {
  specVersion?: string;
  profileHash?: string;
  status?: AssignmentStatus;
}

export interface CreateEventInput {
  id?: string;
  projectId?: string | null;
  entityType: string;
  entityId?: string | null;
  eventType: string;
  payload?: unknown;
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Project;
  findById(id: string): Project | null;
  list(): Project[];
}

export interface AgentRepository {
  create(input: CreateAgentInput): Agent;
  findById(id: string): Agent | null;
  list(): Agent[];
  update(id: string, input: UpdateAgentInput): Agent;
  delete(id: string): void;
}

export interface TaskRepository {
  create(input: CreateTaskInput): Task;
  findById(id: string): Task | null;
  list(): Task[];
  update(id: string, input: UpdateTaskInput): Task;
  setStatus(id: string, status: TaskStatus): Task;
}

export interface AssignmentRepository {
  create(input: CreateAssignmentInput): Assignment;
  findById(id: string): Assignment | null;
  list(): Assignment[];
  update(id: string, input: UpdateAssignmentInput): Assignment;
}

export interface EventRepository {
  create(input: CreateEventInput): AgentHubEvent;
  findById(id: string): AgentHubEvent | null;
  list(): AgentHubEvent[];
}
