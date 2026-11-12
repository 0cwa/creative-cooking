CREATE TABLE pantry_items (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  preference smallint NOT NULL CHECK (preference BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, entity_id)
);
CREATE UNIQUE INDEX pantry_items_active_name_uq
  ON pantry_items (space_id, lower(btrim(name))) WHERE deleted_at IS NULL;
CREATE INDEX pantry_items_by_space_updated ON pantry_items(space_id, updated_at);

CREATE TABLE recipes (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 400),
  description text,
  portions integer NOT NULL CHECK (portions BETWEEN 1 AND 100),
  notes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, entity_id)
);
CREATE INDEX recipes_by_space_updated ON recipes(space_id, updated_at);

CREATE TABLE recipe_ingredients (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  recipe_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  amount text,
  needs_shopping boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, recipe_id, entity_id),
  FOREIGN KEY (space_id, recipe_id) REFERENCES recipes(space_id, entity_id)
);
CREATE INDEX recipe_ingredients_by_recipe ON recipe_ingredients(space_id, recipe_id, position);

CREATE TABLE recipe_steps (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  recipe_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  text text NOT NULL CHECK (length(text) <= 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, recipe_id, entity_id),
  FOREIGN KEY (space_id, recipe_id) REFERENCES recipes(space_id, entity_id)
);
CREATE INDEX recipe_steps_by_recipe ON recipe_steps(space_id, recipe_id, position);

CREATE TABLE recipe_conflicts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  space_id uuid NOT NULL REFERENCES spaces(id),
  recipe_id text NOT NULL,
  mutation_id text NOT NULL,
  base_version bigint,
  current_version bigint,
  attempted_content jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (space_id, recipe_id) REFERENCES recipes(space_id, entity_id)
);
CREATE INDEX recipe_conflicts_by_space ON recipe_conflicts(space_id, created_at DESC);

CREATE TABLE shopping_lists (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  current_cycle_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, entity_id)
);

CREATE TABLE shopping_cycles (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  list_id text NOT NULL,
  started_at timestamptz NOT NULL,
  UNIQUE (space_id, list_id, entity_id),
  FOREIGN KEY (space_id, list_id) REFERENCES shopping_lists(space_id, entity_id)
);
ALTER TABLE shopping_lists ADD CONSTRAINT shopping_lists_current_cycle_fk
  FOREIGN KEY (space_id, entity_id, current_cycle_id)
  REFERENCES shopping_cycles(space_id, list_id, entity_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE shopping_items (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  list_id text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  recipe_id text,
  ingredient_id text,
  display_quantity text,
  display_unit text,
  purchase_cycle_id text NOT NULL,
  checked boolean NOT NULL DEFAULT false,
  purchased_cycle_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, list_id, entity_id),
  FOREIGN KEY (space_id, list_id) REFERENCES shopping_lists(space_id, entity_id),
  FOREIGN KEY (space_id, list_id, purchase_cycle_id) REFERENCES shopping_cycles(space_id, list_id, entity_id),
  FOREIGN KEY (space_id, list_id, purchased_cycle_id) REFERENCES shopping_cycles(space_id, list_id, entity_id)
);
CREATE INDEX shopping_items_by_cycle ON shopping_items(space_id, list_id, purchase_cycle_id, updated_at);

CREATE TABLE shopping_purchases (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES spaces(id),
  list_id text NOT NULL,
  purchase_cycle_id text NOT NULL,
  item_ids text[] NOT NULL,
  pantry_item_ids text[] NOT NULL,
  purchased_at timestamptz NOT NULL,
  purchased_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (space_id, list_id, entity_id),
  FOREIGN KEY (space_id, list_id) REFERENCES shopping_lists(space_id, entity_id),
  FOREIGN KEY (space_id, list_id, purchase_cycle_id) REFERENCES shopping_cycles(space_id, list_id, entity_id)
);
CREATE INDEX shopping_purchases_by_list ON shopping_purchases(space_id, list_id, purchased_at);

CREATE TABLE content_mutations (
  user_id uuid NOT NULL REFERENCES users(id),
  mutation_id text NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  space_id uuid NOT NULL REFERENCES spaces(id),
  status_code smallint NOT NULL CHECK (status_code BETWEEN 200 AND 499),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mutation_id)
);
CREATE INDEX content_mutations_by_space ON content_mutations(space_id, created_at);

CREATE PUBLICATION powersync FOR TABLE
  spaces,
  space_members,
  pantry_items,
  recipes,
  recipe_ingredients,
  recipe_steps,
  recipe_conflicts,
  shopping_lists,
  shopping_cycles,
  shopping_items,
  shopping_purchases;
