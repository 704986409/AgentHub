import type {
  Agent,
  AgentHubEvent,
  AgentStatus,
  AgentAuthority,
  TaskComplexity,
  TaskRisk,
  Assignment,
  AssignmentStatus,
  Project,
  Task,
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
  provider: string;
  model: string;
  position: string;
  status: AgentStatus;
  allowed_complexities: string;
  allowed_risk_levels: string;
  capabilities: string;
  specialties: string;
  authority: AgentAuthority;
  routing_priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export const mapAgent = (row: AgentRow): Agent => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  provider: row.provider,
  model: row.model,
  position: row.position,
  status: row.status,
  allowedComplexities: JSON.parse(row.allowed_complexities) as TaskComplexity[],
  allowedRiskLevels: JSON.parse(row.allowed_risk_levels) as TaskRisk[],
  capabilities: JSON.parse(row.capabilities) as string[],
  specialties: JSON.parse(row.specialties) as string[],
  authority: row.authority,
  routingPriority: row.routing_priority,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  required_capabilities: string;
  required_specialties: string;
  acceptance_criteria: string;
  status: TaskStatus;
  complexity: TaskComplexity;
  risk: TaskRisk;
  assigned_agent_id: string | null;
  assignment_id: string | null;
  created_at: string;
  updated_at: string;
}

export const mapTask = (row: TaskRow): Task => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  description: row.description,
  requiredCapabilities: JSON.parse(row.required_capabilities) as string[],
  requiredSpecialties: JSON.parse(row.required_specialties) as string[],
  acceptanceCriteria: JSON.parse(row.acceptance_criteria) as string[],
  status: row.status,
  complexity: row.complexity,
  risk: row.risk,
  assignedAgentId: row.assigned_agent_id,
  assignmentId: row.assignment_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface AssignmentRow {
  id: string;
  task_id: string;
  agent_id: string;
  spec_version: string;
  profile_hash: string;
  status: AssignmentStatus;
  created_at: string;
  updated_at: string;
}

export const mapAssignment = (row: AssignmentRow): Assignment => ({
  id: row.id,
  assignmentId: row.id,
  taskId: row.task_id,
  agentId: row.agent_id,
  specVersion: row.spec_version,
  profileHash: row.profile_hash,
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
