import type { Migration } from "../Migration.js";

export const initialExecutorMigration: Migration = {
  id: "20260921133000-initial-executor",
  sql: `
    CREATE TABLE IF NOT EXISTS "integration" ("slug" text NOT NULL, "plugin_id" text NOT NULL, "name" text, "description" text, "config" text, "health_check" text, "config_revised_at" blob, "can_remove" integer NOT NULL DEFAULT 1, "can_refresh" integer NOT NULL DEFAULT 0, "created_at" integer NOT NULL, "updated_at" integer NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "subject" ("external_id" text NOT NULL, "created_at" integer NOT NULL, "last_seen_at" blob, "status" text, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "connection" ("integration" text NOT NULL, "name" text NOT NULL, "template" text NOT NULL, "provider" text NOT NULL, "item_ids" text NOT NULL, "identity_label" text, "description" text, "last_health" text, "tools_synced_at" blob, "oauth_client" text, "oauth_client_owner" text, "refresh_item_id" text, "expires_at" blob, "oauth_scope" text, "oauth_token_url" text, "provider_state" text, "created_at" integer NOT NULL, "updated_at" integer NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL, "owner" text NOT NULL, "subject" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "oauth_client" ("slug" text NOT NULL, "authorization_url" text NOT NULL, "token_url" text NOT NULL, "grant" text NOT NULL, "client_id" text NOT NULL, "client_secret_item_id" text, "resource" text, "origin_kind" text, "origin_integration" text, "origin_issuer" text, "origin_redirect_uri" text, "created_at" integer NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL, "owner" text NOT NULL, "subject" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "oauth_session" ("state" text NOT NULL, "client_slug" text NOT NULL, "integration" text NOT NULL, "name" text NOT NULL, "template" text NOT NULL, "redirect_url" text NOT NULL, "pkce_verifier" text, "identity_label" text, "payload" text NOT NULL, "expires_at" blob NOT NULL, "created_at" integer NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL, "owner" text NOT NULL, "subject" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "tool" ("integration" text NOT NULL, "connection" text NOT NULL, "plugin_id" text NOT NULL, "name" text NOT NULL, "description" text NOT NULL, "input_schema" text, "output_schema" text, "annotations" text, "created_at" integer NOT NULL, "updated_at" integer NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL, "owner" text NOT NULL, "subject" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "definition" ("integration" text NOT NULL, "connection" text NOT NULL, "plugin_id" text NOT NULL, "name" text NOT NULL, "schema" text NOT NULL, "created_at" integer NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL, "owner" text NOT NULL, "subject" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "tool_policy" ("id" text NOT NULL, "pattern" text NOT NULL, "action" text NOT NULL, "position" text NOT NULL, "created_at" integer NOT NULL, "updated_at" integer NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL, "owner" text NOT NULL, "subject" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "artifact" ("id" text NOT NULL, "title" text NOT NULL, "description" text, "code" text NOT NULL, "bindings" text, "preview" text, "created_at" integer NOT NULL, "updated_at" integer NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL, "owner" text NOT NULL, "subject" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "plugin_storage" ("plugin_id" text NOT NULL, "collection" text NOT NULL, "key" text NOT NULL, "data" text NOT NULL, "created_at" integer NOT NULL, "updated_at" integer NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "tenant" text NOT NULL, "owner" text NOT NULL, "subject" text NOT NULL);
    CREATE TABLE IF NOT EXISTS "blob" ("namespace" text NOT NULL, "key" text NOT NULL, "value" text NOT NULL, "row_id" text PRIMARY KEY NOT NULL, "id" text NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS "integration_uidx" ON "integration" ("tenant", "slug");
    CREATE UNIQUE INDEX IF NOT EXISTS "subject_uidx" ON "subject" ("tenant", "external_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "connection_uidx" ON "connection" ("tenant", "owner", "subject", "integration", "name");
    CREATE UNIQUE INDEX IF NOT EXISTS "oauth_client_uidx" ON "oauth_client" ("tenant", "owner", "subject", "slug");
    CREATE UNIQUE INDEX IF NOT EXISTS "oauth_session_uidx" ON "oauth_session" ("tenant", "state");
    CREATE UNIQUE INDEX IF NOT EXISTS "tool_uidx" ON "tool" ("tenant", "owner", "subject", "integration", "connection", "name");
    CREATE UNIQUE INDEX IF NOT EXISTS "definition_uidx" ON "definition" ("tenant", "owner", "subject", "integration", "connection", "name");
    CREATE UNIQUE INDEX IF NOT EXISTS "tool_policy_uidx" ON "tool_policy" ("tenant", "owner", "subject", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "artifact_uidx" ON "artifact" ("tenant", "owner", "subject", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "plugin_storage_uidx" ON "plugin_storage" ("tenant", "owner", "subject", "plugin_id", "collection", "key");
    CREATE UNIQUE INDEX IF NOT EXISTS "blob_id_uidx" ON "blob" ("id");
    CREATE TABLE IF NOT EXISTS "private_halo_executor_settings" ("id" text PRIMARY KEY NOT NULL, "version" text NOT NULL DEFAULT '1.0.0');
  `,
};
