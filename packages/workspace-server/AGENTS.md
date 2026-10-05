# Workspace server

## Turso

This package uses embedded Turso through `@tursodatabase/database`. Turso is SQLite-compatible, but it is not SQLite.

Before designing or changing SQL, migrations, transactions, pragmas, database types, connection behavior, or other Turso-dependent code:

- Check the exact installed `@tursodatabase/database` version.
- Read the installed package documentation and the official [Turso compatibility status](https://github.com/tursodatabase/turso/blob/main/COMPAT.md). Check version-specific release notes when behavior may have changed.
- Do not infer support or semantics from SQLite documentation alone.
- Verify behavior that affects correctness with a focused test or throwaway query against the installed Turso package.
