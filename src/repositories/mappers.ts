import type {
  Agent,
  AgentCapability,
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

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export const mapProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface AgentRow {
  id: string;
  project_id: string | null;
  name: string;
  status: AgentStatus;
  capabilities: string;
  authority: AgentAuthority;
  created_at: string;
  updated_at: string;
}

export const mapAgent = (row: AgentRow): Agent => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  status: row.status,
  capabilities: JSON.parse(row.capabilities) as AgentCapability[],
  authority: row.authority,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  complexity: TaskComplexity;
  risk: TaskRisk;
  created_at: string;
  updated_at: string;
}

export const mapTask = (row: TaskRow): Task => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  description: row.description,
  status: row.status,
  complexity: row.complexity,
  risk: row.risk,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface AssignmentRow {
  id: string;
  task_id: string;
  agent_id: string;
  status: AssignmentStatus;
  created_at: string;
  updated_at: string;
}

export const mapAssignment = (row: AssignmentRow): Assignment => ({
  id: row.id,
  taskId: row.task_id,
  agentId: row.agent_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface EventRow {
  id: string;
  project_id: string | null;
  entity_type: string;
  entity_id: string | null;
  event_type: string;
  payload: string;
  created_at: string;
}

export const mapEvent = (row: EventRow): AgentHubEvent => ({
  id: row.id,
  projectId: row.project_id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  eventType: row.event_type,
  payload: JSON.parse(row.payload) as unknown,
  createdAt: row.created_at,
});
