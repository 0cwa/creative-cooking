CREATE TABLE personal_profile_fields (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  field_key text NOT NULL,
  value jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, field_key),
  UNIQUE (space_id, entity_id)
);
CREATE INDEX personal_profile_fields_by_space ON personal_profile_fields(space_id, updated_at);

CREATE TABLE personal_allergies (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, normalized_name),
  UNIQUE (space_id, entity_id)
);
CREATE INDEX personal_allergies_by_space ON personal_allergies(space_id, updated_at);

CREATE TABLE personal_conversations (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, entity_id)
);
CREATE INDEX personal_conversations_by_space ON personal_conversations(space_id, updated_at DESC);

CREATE TABLE personal_chat_messages (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  conversation_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (length(content) <= 32000),
  created_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version = 1),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, conversation_id, entity_id),
  FOREIGN KEY (space_id, conversation_id) REFERENCES personal_conversations(space_id, entity_id)
);
CREATE INDEX personal_chat_messages_by_conversation
  ON personal_chat_messages(space_id, conversation_id, created_at, entity_id);

CREATE TABLE personal_chat_proposals (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  conversation_id text NOT NULL,
  message_id text NOT NULL,
  tool_name text NOT NULL CHECK (length(btrim(tool_name)) BETWEEN 1 AND 80),
  arguments text NOT NULL CHECK (length(arguments) <= 16000),
  status text NOT NULL CHECK (status IN ('pending', 'applied')),
  applied_effect_space_id uuid REFERENCES spaces(id),
  applied_effect_mutation_id text,
  applied_effect_op_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, conversation_id, message_id, entity_id),
  FOREIGN KEY (space_id, conversation_id, message_id)
    REFERENCES personal_chat_messages(space_id, conversation_id, entity_id),
  CHECK (
    (applied_effect_space_id IS NULL AND applied_effect_mutation_id IS NULL AND applied_effect_op_id IS NULL)
    OR (applied_effect_space_id IS NOT NULL AND applied_effect_mutation_id IS NOT NULL AND applied_effect_op_id IS NOT NULL)
  )
);
CREATE INDEX personal_chat_proposals_by_message
  ON personal_chat_proposals(space_id, conversation_id, message_id, entity_id);

CREATE TABLE personal_content_conflicts (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  record_type text NOT NULL,
  mutation_id text NOT NULL,
  op_id text NOT NULL,
  base_version bigint,
  current_version bigint,
  attempted_content jsonb NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (space_id, mutation_id, op_id)
);
CREATE INDEX personal_content_conflicts_by_space
  ON personal_content_conflicts(space_id, created_at DESC);

ALTER PUBLICATION powersync ADD TABLE
  personal_profile_fields,
  personal_allergies,
  personal_conversations,
  personal_chat_messages,
  personal_chat_proposals,
  personal_content_conflicts;
