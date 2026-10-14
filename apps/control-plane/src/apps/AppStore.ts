// oxlint-disable unicorn/no-null -- SQL bindings and rows represent absent values with NULL.
import crypto from "node:crypto";
import * as errore from "errore";
import type { AppAction, AppJson } from "@get-halo/shared/extensionSharing";
import { SqlDatabase, type SqlTransaction } from "../database/SqlDatabase.js";
import type { DatabaseService } from "../DatabaseService.js";

export class AppConflictError extends errore.createTaggedError({
  name: "AppConflictError",
  message: "$reason",
}) {}

/** Publication progress; only `live` apps have a remote reference. */
type AppStage = "frozen" | "ready" | "live";
type SyncAccess = "read-only" | "shared" | "actions";

export type AppRecord = {
  appId: string;
  ownerUserId: string;
  handle: string;
  extensionId: string;
  slug: string;
  displayName: string;
  visibility: "public" | "invited";
  members: string[];
  published: boolean;
  stage: AppStage;
  syncAccess: SyncAccess;
  credentialGeneration: number;
  installId: string;
};

type AppRow = {
  app_id: string;
  owner_user_id: string;
  handle: string;
  extension_id: string;
  slug: string;
  display_name: string;
  visibility: "public" | "invited";
  published: number;
  stage: AppStage;
  sync_access: SyncAccess;
  credential_generation: number;
  install_id: string;
};

type ActionRow = {
  name: string;
  description: string;
  address: string;
  arguments: string;
  sample_result: string | null;
};

// Host labels the creator cannot claim, so they never shadow Halo services.
const reservedHandles = new Set([
  "admin",
  "api",
  "app",
  "apps",
  "auth",
  "demo",
  "docs",
  "halo",
  "mail",
  "staging",
  "static",
  "support",
  "templates",
  "www",
]);

const viewerSessionMs = 7 * 24 * 60 * 60_000;

function hash(secret: string) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

const appColumns = `a.app_id, a.owner_user_id, c.handle, a.extension_id, a.slug,
  a.display_name, a.visibility, a.published, a.stage, a.sync_access,
  a.credential_generation, a.install_id`;

/** Durable app ownership, access and fixed action bindings. */
export class AppStore {
  private readonly database: SqlDatabase;

  constructor(ctx: { db: DatabaseService }) {
    this.database = new SqlDatabase({ client: ctx.db.appClient });
  }

  async initialize() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS app_creators (
        user_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE)`,
      `CREATE TABLE IF NOT EXISTS apps (
        app_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL,
        extension_id TEXT NOT NULL, slug TEXT NOT NULL, display_name TEXT NOT NULL,
        visibility TEXT NOT NULL, published INTEGER NOT NULL, stage TEXT NOT NULL,
        sync_access TEXT NOT NULL, credential_generation INTEGER NOT NULL,
        install_id TEXT NOT NULL, created_at BIGINT NOT NULL,
        UNIQUE (owner_user_id, slug), UNIQUE (owner_user_id, extension_id))`,
      `CREATE TABLE IF NOT EXISTS app_members (
        app_id TEXT NOT NULL, email TEXT NOT NULL, PRIMARY KEY (app_id, email))`,
      // Creator-host browser sessions and single-use sign-in handoffs. Only
      // SHA-256 hashes of the random secrets are stored.
      `CREATE TABLE IF NOT EXISTS app_viewer_sessions (
        token_hash TEXT PRIMARY KEY, handle TEXT NOT NULL, user_id TEXT NOT NULL,
        email TEXT NOT NULL, expires_at BIGINT NOT NULL)`,
      // state_hash binds a code to the browser that started sign-in.
      `CREATE TABLE IF NOT EXISTS app_handoffs (
        code_hash TEXT PRIMARY KEY, handle TEXT NOT NULL, state_hash TEXT NOT NULL,
        user_id TEXT NOT NULL, email TEXT NOT NULL, expires_at BIGINT NOT NULL)`,
      // Fixed-window counters shared by every control-plane instance.
      `CREATE TABLE IF NOT EXISTS app_usage (
        app_id TEXT NOT NULL, kind TEXT NOT NULL, window_start BIGINT NOT NULL,
        count INTEGER NOT NULL, PRIMARY KEY (app_id, kind, window_start))`,
      `CREATE TABLE IF NOT EXISTS app_actions (
        app_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        address TEXT NOT NULL, arguments TEXT NOT NULL, sample_result TEXT,
        PRIMARY KEY (app_id, name))`,
    ];
    return await this.database.transaction(async (sql) => {
      for (const statement of statements) {
        const created = await sql.query(statement);
        if (created instanceof Error) return created;
      }
    });
  }

  /** Returns the creator's host label, claiming one on first publication. */
  async ensureHandle(ctx: { userId: string; email: string }) {
    return await this.database.transaction(async (sql) => {
      const existing = await sql.query<{ handle: string }>(
        "SELECT handle FROM app_creators WHERE user_id = $1",
        [ctx.userId],
      );
      if (existing instanceof Error) return existing;
      if (existing[0] !== undefined) return existing[0].handle;
      const base =
        (ctx.email.split("@")[0] ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 24) || "creator";
      const prefix = /^[a-z]/.test(base) ? base : `u-${base}`;
      for (let suffix = 1; suffix < 100; suffix += 1) {
        const handle = suffix === 1 ? prefix : `${prefix}-${suffix}`;
        if (reservedHandles.has(handle)) continue;
        const taken = await sql.query(
          "SELECT user_id FROM app_creators WHERE handle = $1",
          [handle],
        );
        if (taken instanceof Error) return taken;
        if (taken.length > 0) continue;
        const inserted = await sql.query(
          "INSERT INTO app_creators (user_id, handle) VALUES ($1, $2)",
          [ctx.userId, handle],
        );
        if (inserted instanceof Error) return inserted;
        return handle;
      }
      return new AppConflictError({ reason: "No creator handle is available" });
    });
  }

  /** Creates the app once per owner and extension; retries return the record. */
  async create(ctx: {
    ownerUserId: string;
    extensionId: string;
    slug: string;
    displayName: string;
    visibility: "public" | "invited";
    members: string[];
    syncAccess: SyncAccess;
    actions: AppAction[];
  }) {
    return await this.database.transaction(async (sql) => {
      const existing = await this.selectApps(
        sql,
        "a.owner_user_id = $1 AND a.extension_id = $2",
        [ctx.ownerUserId, ctx.extensionId],
      );
      if (existing instanceof Error) return existing;
      if (existing[0] !== undefined) return existing[0];
      const slugTaken = await sql.query(
        "SELECT app_id FROM apps WHERE owner_user_id = $1 AND slug = $2",
        [ctx.ownerUserId, ctx.slug],
      );
      if (slugTaken instanceof Error) return slugTaken;
      if (slugTaken.length > 0)
        return new AppConflictError({
          reason: "Another app already uses this link",
        });
      const appId = crypto.randomUUID();
      const inserted = await sql.query(
        `INSERT INTO apps (app_id, owner_user_id, extension_id, slug, display_name,
          visibility, published, stage, sync_access, credential_generation,
          install_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 'frozen', $7, 1, $8, $9)`,
        [
          appId,
          ctx.ownerUserId,
          ctx.extensionId,
          ctx.slug,
          ctx.displayName,
          ctx.visibility,
          ctx.syncAccess,
          crypto.randomUUID(),
          Date.now(),
        ],
      );
      if (inserted instanceof Error) return inserted;
      const members = await this.replaceMembers(sql, appId, ctx.members);
      if (members instanceof Error) return members;
      const actions = await this.replaceActionRows(sql, appId, ctx.actions);
      if (actions instanceof Error) return actions;
      const created = await this.selectApps(sql, "a.app_id = $1", [appId]);
      if (created instanceof Error) return created;
      return created[0]!;
    });
  }

  async get(appId: string) {
    return await this.database.transaction(async (sql) => {
      const apps = await this.selectApps(sql, "a.app_id = $1", [appId]);
      if (apps instanceof Error) return apps;
      return apps[0];
    });
  }

  async findByAddress(ctx: { handle: string; slug: string }) {
    return await this.database.transaction(async (sql) => {
      const apps = await this.selectApps(sql, "c.handle = $1 AND a.slug = $2", [
        ctx.handle,
        ctx.slug,
      ]);
      if (apps instanceof Error) return apps;
      return apps[0];
    });
  }

  async list(ownerUserId: string) {
    return await this.database.transaction(
      async (sql) =>
        await this.selectApps(sql, "a.owner_user_id = $1", [ownerUserId]),
    );
  }

  async hasHandle(handle: string) {
    return await this.database.transaction(async (sql) => {
      const found = await sql.query(
        "SELECT user_id FROM app_creators WHERE handle = $1",
        [handle],
      );
      if (found instanceof Error) return found;
      return found.length > 0;
    });
  }

  /**
   * Issues a 60-second code that signs the user in to one creator host, in
   * the browser whose sign-in state hashes to `state`.
   */
  async createHandoff(ctx: {
    handle: string;
    state: string;
    userId: string;
    email: string;
  }) {
    const code = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    return await this.database.transaction(async (sql) => {
      const expired = await sql.query(
        "DELETE FROM app_handoffs WHERE expires_at < $1",
        [now],
      );
      if (expired instanceof Error) return expired;
      const inserted = await sql.query(
        `INSERT INTO app_handoffs (code_hash, handle, state_hash, user_id, email, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          hash(code),
          ctx.handle,
          hash(ctx.state),
          ctx.userId,
          ctx.email,
          now + 60_000,
        ],
      );
      if (inserted instanceof Error) return inserted;
      return code;
    });
  }

  /**
   * Redeems a handoff once, on the host and in the browser it was issued for,
   * as a session. The DELETE claims the code, so concurrent redemptions on
   * any database get at most one session.
   */
  async redeemHandoff(ctx: { handle: string; code: string; state: string }) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    return await this.database.transaction(async (sql) => {
      const claimed = await sql.query<{ user_id: string; email: string }>(
        `DELETE FROM app_handoffs
         WHERE code_hash = $1 AND handle = $2 AND state_hash = $3 AND expires_at >= $4
         RETURNING user_id, email`,
        [hash(ctx.code), ctx.handle, hash(ctx.state), now],
      );
      if (claimed instanceof Error) return claimed;
      const handoff = claimed[0];
      if (handoff === undefined) return undefined;
      const inserted = await sql.query(
        `INSERT INTO app_viewer_sessions (token_hash, handle, user_id, email, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          hash(token),
          ctx.handle,
          handoff.user_id,
          handoff.email,
          now + viewerSessionMs,
        ],
      );
      if (inserted instanceof Error) return inserted;
      return token;
    });
  }

  async findViewerSession(ctx: { handle: string; token: string }) {
    return await this.database.transaction(async (sql) => {
      const found = await sql.query<{ user_id: string; email: string }>(
        `SELECT user_id, email FROM app_viewer_sessions
         WHERE token_hash = $1 AND handle = $2 AND expires_at >= $3`,
        [hash(ctx.token), ctx.handle, Date.now()],
      );
      if (found instanceof Error) return found;
      const session = found[0];
      if (session === undefined) return undefined;
      return { userId: session.user_id, email: session.email };
    });
  }

  async deleteViewerSession(token: string) {
    return await this.database.transaction(async (sql) => {
      const deleted = await sql.query(
        "DELETE FROM app_viewer_sessions WHERE token_hash = $1",
        [hash(token)],
      );
      if (deleted instanceof Error) return deleted;
    });
  }

  /** Counts one use; returns false once the window's limit is exceeded. */
  async consume(ctx: {
    appId: string;
    kind: string;
    limit: number;
    windowMs: number;
  }) {
    const windowStart = Math.floor(Date.now() / ctx.windowMs) * ctx.windowMs;
    return await this.database.transaction(async (sql) => {
      const counted = await sql.query<{ count: number }>(
        `INSERT INTO app_usage (app_id, kind, window_start, count) VALUES ($1, $2, $3, 1)
         ON CONFLICT (app_id, kind, window_start) DO UPDATE SET count = app_usage.count + 1
         RETURNING count`,
        [ctx.appId, ctx.kind, windowStart],
      );
      if (counted instanceof Error) return counted;
      return (counted[0]?.count ?? Number.POSITIVE_INFINITY) <= ctx.limit;
    });
  }

  /** Advances one publication step only from the stage the caller observed. */
  async advance(ctx: { appId: string; from: AppStage; to: AppStage }) {
    return await this.database.transaction(async (sql) => {
      const updated = await sql.query(
        `UPDATE apps SET stage = $1 WHERE app_id = $2 AND stage = $3`,
        [ctx.to, ctx.appId, ctx.from],
      );
      if (updated instanceof Error) return updated;
      const apps = await this.selectApps(sql, "a.app_id = $1", [ctx.appId]);
      if (apps instanceof Error) return apps;
      if (apps[0]?.stage !== ctx.to)
        return new AppConflictError({ reason: "Publication changed" });
      return apps[0];
    });
  }

  async updateAccess(ctx: {
    appId: string;
    access?: { visibility: "public" | "invited"; members: string[] };
    published?: boolean;
  }) {
    return await this.database.transaction(async (sql) => {
      if (ctx.access !== undefined) {
        const updated = await sql.query(
          "UPDATE apps SET visibility = $1 WHERE app_id = $2",
          [ctx.access.visibility, ctx.appId],
        );
        if (updated instanceof Error) return updated;
        const members = await this.replaceMembers(
          sql,
          ctx.appId,
          ctx.access.members,
        );
        if (members instanceof Error) return members;
      }
      if (ctx.published !== undefined) {
        const updated = await sql.query(
          "UPDATE apps SET published = $1 WHERE app_id = $2",
          [ctx.published ? 1 : 0, ctx.appId],
        );
        if (updated instanceof Error) return updated;
      }
      const apps = await this.selectApps(sql, "a.app_id = $1", [ctx.appId]);
      if (apps instanceof Error) return apps;
      return apps[0]!;
    });
  }

  async actions(appId: string) {
    return await this.database.transaction(async (sql) => {
      const rows = await sql.query<ActionRow>(
        `SELECT name, description, address, arguments, sample_result
         FROM app_actions WHERE app_id = $1 ORDER BY name`,
        [appId],
      );
      if (rows instanceof Error) return rows;
      return errore.try({
        try: () =>
          rows.map((row) => {
            const action: AppAction = {
              name: row.name,
              description: row.description,
              address: row.address,
              // SAFETY: Rows are written only by replaceActionRows from validated JSON.
              arguments: JSON.parse(row.arguments) as Record<string, AppJson>,
            };
            if (row.sample_result !== null)
              // SAFETY: Written only by replaceActionRows from validated JSON.
              action.sampleResult = JSON.parse(row.sample_result) as AppJson;
            return action;
          }),
        catch: (cause) =>
          new AppConflictError({
            reason: "Stored action is unreadable",
            cause,
          }),
      });
    });
  }

  /** Records what the frozen package declares, before any copy is installed. */
  async define(ctx: {
    appId: string;
    displayName: string;
    syncAccess: SyncAccess;
    actions: AppAction[];
  }) {
    return await this.database.transaction(async (sql) => {
      const updated = await sql.query(
        `UPDATE apps SET display_name = $1, sync_access = $2
         WHERE app_id = $3 AND stage = 'frozen'`,
        [ctx.displayName, ctx.syncAccess, ctx.appId],
      );
      if (updated instanceof Error) return updated;
      const actions = await this.replaceActionRows(sql, ctx.appId, ctx.actions);
      if (actions instanceof Error) return actions;
      const apps = await this.selectApps(sql, "a.app_id = $1", [ctx.appId]);
      if (apps instanceof Error) return apps;
      if (apps[0]?.stage !== "frozen")
        return new AppConflictError({ reason: "Publication changed" });
      return apps[0];
    });
  }

  async replaceActions(ctx: { appId: string; actions: AppAction[] }) {
    return await this.database.transaction(
      async (sql) => await this.replaceActionRows(sql, ctx.appId, ctx.actions),
    );
  }

  async delete(appId: string) {
    return await this.database.transaction(async (sql) => {
      for (const table of ["app_actions", "app_members", "apps"]) {
        const deleted = await sql.query(
          `DELETE FROM ${table} WHERE app_id = $1`,
          [appId],
        );
        if (deleted instanceof Error) return deleted;
      }
    });
  }

  private async replaceMembers(
    sql: SqlTransaction,
    appId: string,
    members: string[],
  ) {
    const deleted = await sql.query(
      "DELETE FROM app_members WHERE app_id = $1",
      [appId],
    );
    if (deleted instanceof Error) return deleted;
    for (const email of new Set(members.map((item) => item.toLowerCase()))) {
      const inserted = await sql.query(
        "INSERT INTO app_members (app_id, email) VALUES ($1, $2)",
        [appId, email],
      );
      if (inserted instanceof Error) return inserted;
    }
  }

  private async replaceActionRows(
    sql: SqlTransaction,
    appId: string,
    actions: AppAction[],
  ) {
    const deleted = await sql.query(
      "DELETE FROM app_actions WHERE app_id = $1",
      [appId],
    );
    if (deleted instanceof Error) return deleted;
    for (const action of actions) {
      const inserted = await sql.query(
        `INSERT INTO app_actions (app_id, name, description, address, arguments, sample_result)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          appId,
          action.name,
          action.description,
          action.address,
          JSON.stringify(action.arguments),
          action.sampleResult === undefined
            ? null
            : JSON.stringify(action.sampleResult),
        ],
      );
      if (inserted instanceof Error) return inserted;
    }
  }

  private async selectApps(
    sql: SqlTransaction,
    where: string,
    parameters: string[],
  ) {
    const rows = await sql.query<AppRow>(
      `SELECT ${appColumns} FROM apps a
       JOIN app_creators c ON c.user_id = a.owner_user_id
       WHERE ${where} ORDER BY a.created_at`,
      parameters,
    );
    if (rows instanceof Error) return rows;
    const records: AppRecord[] = [];
    for (const row of rows) {
      const members = await sql.query<{ email: string }>(
        "SELECT email FROM app_members WHERE app_id = $1 ORDER BY email",
        [row.app_id],
      );
      if (members instanceof Error) return members;
      records.push({
        appId: row.app_id,
        ownerUserId: row.owner_user_id,
        handle: row.handle,
        extensionId: row.extension_id,
        slug: row.slug,
        displayName: row.display_name,
        visibility: row.visibility,
        members: members.map((member) => member.email),
        published: row.published === 1,
        stage: row.stage,
        syncAccess: row.sync_access,
        credentialGeneration: row.credential_generation,
        installId: row.install_id,
      });
    }
    return records;
  }
}
