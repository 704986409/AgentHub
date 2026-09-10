export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        status TEXT NOT NULL CHECK (status IN ('IDLE', 'BUSY', 'OFFLINE', 'DISABLED')),
        capabilities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(capabilities) AND json_type(capabilities) = 'array'),
        authority TEXT NOT NULL CHECK (authority IN ('READ_ONLY', 'STANDARD', 'PRIVILEGED', 'ADMIN')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        description TEXT,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED')),
        complexity TEXT NOT NULL CHECK (complexity IN ('TRIVIAL', 'SIMPLE', 'MEDIUM', 'COMPLEX', 'CRITICAL')),
        risk TEXT NOT NULL CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE assignments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'ACTIVE', 'COMPLETED', 'REJECTED', 'CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, agent_id)
      );

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) > 0),
        entity_id TEXT,
        event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
        payload TEXT NOT NULL DEFAULT '{} ' CHECK (json_valid(payload)),
        created_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
        value TEXT NOT NULL CHECK (json_valid(value)),
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_agents_project_id ON agents(project_id);
      CREATE INDEX idx_tasks_project_id ON tasks(project_id);
      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_assignments_task_id ON assignments(task_id);
      CREATE INDEX idx_assignments_agent_id ON assignments(agent_id);
      CREATE INDEX idx_events_project_id ON events(project_id);
      CREATE INDEX idx_events_entity ON events(entity_type, entity_id);
    `,
  },
  {
    version: 2,
    name: 'agent_profiles',
    up: `
      ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown' CHECK (length(trim(provider)) > 0);
      ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown' CHECK (length(trim(model)) > 0);
      ALTER TABLE agents ADD COLUMN position TEXT NOT NULL DEFAULT 'Agent' CHECK (length(trim(position)) > 0);
      ALTER TABLE agents ADD COLUMN allowed_complexities TEXT NOT NULL DEFAULT '["TRIVIAL","SIMPLE","MEDIUM","COMPLEX","CRITICAL"]' CHECK (json_valid(allowed_complexities));
      ALTER TABLE agents ADD COLUMN allowed_risk_levels TEXT NOT NULL DEFAULT '["LOW","MEDIUM","HIGH","CRITICAL"]' CHECK (json_valid(allowed_risk_levels));
      ALTER TABLE agents ADD COLUMN specialties TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(specialties) AND json_type(specialties) = 'array');
      ALTER TABLE agents ADD COLUMN routing_priority INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
    `,
  },
];
