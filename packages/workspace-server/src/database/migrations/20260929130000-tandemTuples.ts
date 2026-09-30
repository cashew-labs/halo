import type { Migration } from "../Migration.js";

export const tandemTuplesMigration: Migration = {
  id: "20260929130000-tandem-tuples",
  sql: `CREATE TABLE halo_tandem_tuples (
    namespace TEXT NOT NULL,
    key BLOB NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  );`,
};
