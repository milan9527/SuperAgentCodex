WITH "affected_scopes" AS (
  SELECT DISTINCT "business_scope_id"
  FROM "agents"
  WHERE "business_scope_id" IS NOT NULL
    AND "system_prompt" ~ 'Relevant project skills are available under \.agents/skills:'
),
"updated_agents" AS (
  UPDATE "agents"
  SET
    "system_prompt" = BTRIM(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          "system_prompt",
          E'(^|\\n)[ \\t]*Relevant project skills are available under \\.agents/skills:[^\\n]*\\.[ \\t]*(\\n|$)',
          E'\\1',
          'g'
        ),
        E'\\n{3,}',
        E'\\n\\n',
        'g'
      )
    ),
    "updated_at" = NOW()
  WHERE "system_prompt" ~ 'Relevant project skills are available under \.agents/skills:'
  RETURNING "business_scope_id"
)
UPDATE "business_scopes"
SET
  "config_version" = "config_version" + 1,
  "updated_at" = NOW()
WHERE "id" IN (
  SELECT "business_scope_id"
  FROM "affected_scopes"
);
