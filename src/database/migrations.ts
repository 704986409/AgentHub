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
  {
    version: 3,
    name: 'task_lifecycle_and_assignments',
    up: `
      PRAGMA foreign_keys = OFF;
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        description TEXT,
        required_capabilities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_capabilities) AND json_type(required_capabilities) = 'array'),
        required_specialties TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_specialties) AND json_type(required_specialties) = 'array'),
        acceptance_criteria TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_criteria) AND json_type(acceptance_criteria) = 'array'),
        status TEXT NOT NULL CHECK (status IN ('CREATED','QUEUED','ASSIGNED','IMPLEMENTING','REVIEWING','REVISION_REQUIRED','COMPLETED','WAITING_INPUT','WAITING_APPROVAL','WAITING_DEPENDENCY','PAUSED','BLOCKED','FAILED','CANCELLED','PENDING','IN_PROGRESS')),
        complexity TEXT NOT NULL CHECK (complexity IN ('TRIVIAL', 'SIMPLE', 'MEDIUM', 'COMPLEX', 'CRITICAL')),
        risk TEXT NOT NULL CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        assignment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks_new (id, project_id, title, description, status, complexity, risk, created_at, updated_at)
        SELECT id, project_id, title, description,
          CASE status WHEN 'PENDING' THEN 'CREATED' WHEN 'IN_PROGRESS' THEN 'IMPLEMENTING' ELSE status END,
          complexity, risk, created_at, updated_at FROM tasks;
      CREATE TABLE assignments_backup AS SELECT * FROM assignments;
      DROP TABLE assignments;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX idx_tasks_project_id ON tasks(project_id);
      CREATE INDEX idx_tasks_status ON tasks(status);

      CREATE TABLE assignments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        spec_version TEXT NOT NULL DEFAULT '1.0.0',
        profile_hash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('DISPATCHING','ACCEPTED','ACTIVE','COMPLETED','RELEASED','STALE','PENDING','REJECTED','CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, agent_id)
      );
      INSERT INTO assignments (id, task_id, agent_id, status, created_at, updated_at)
        SELECT id, task_id, agent_id,
          CASE status WHEN 'PENDING' THEN 'DISPATCHING' WHEN 'REJECTED' THEN 'RELEASED' WHEN 'CANCELLED' THEN 'RELEASED' ELSE status END,
          created_at, updated_at FROM assignments_backup;
      DROP TABLE assignments_backup;
      CREATE INDEX idx_assignments_task_id ON assignments(task_id);
      CREATE INDEX idx_assignments_agent_id ON assignments(agent_id);
      PRAGMA foreign_keys = ON;
    `,
  },
  {
    version: 4,
    name: 'event_foundation',
    up: `
      ALTER TABLE events ADD COLUMN event_id TEXT;
      ALTER TABLE events ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
      ALTER TABLE events ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
      ALTER TABLE events ADD COLUMN assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL;
      ALTER TABLE events ADD COLUMN actor TEXT;
      ALTER TABLE events ADD COLUMN old_status TEXT;
      ALTER TABLE events ADD COLUMN new_status TEXT;
      ALTER TABLE events ADD COLUMN timestamp TEXT;
      UPDATE events SET event_id = id, timestamp = created_at WHERE event_id IS NULL;
      CREATE UNIQUE INDEX idx_events_event_id ON events(event_id);
      CREATE INDEX idx_events_agent_id ON events(agent_id);
      CREATE INDEX idx_events_task_id ON events(task_id);
      CREATE INDEX idx_events_assignment_id ON events(assignment_id);
    `,
  },
  {
    version: 5,
    name: 'codex_session_persistence',
    up: `
      CREATE TABLE codex_sessions (
        session_key TEXT PRIMARY KEY CHECK (length(trim(session_key)) BETWEEN 1 AND 256),
        thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
        session_id TEXT NOT NULL CHECK (length(trim(session_id)) > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];
