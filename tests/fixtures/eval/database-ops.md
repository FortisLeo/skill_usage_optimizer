---
name: database-ops
description: Database operations and management
---

# Database Operations

This skill covers common database operations for PostgreSQL and SQLite.

Always configure DATABASE_URL before running any operation.

## Setup

Database connection configuration.

```python
import os
DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql://localhost:5432/mydb')
```

Supported drivers: `psycopg2` for PostgreSQL, `sqlite3` for SQLite.

## Querying

Execute SELECT queries and process results.

```python
import sqlite3
conn = sqlite3.connect(DATABASE_URL)
cursor = conn.execute('SELECT * FROM users WHERE active = ?', (1,))
rows = cursor.fetchall()
```

Use parameterized queries to prevent SQL injection.

## Migrations

<!-- requires: setup -->

Run database schema migrations.

```bash
alembic upgrade head
```

For SQLite, migrations use raw SQL files in `migrations/` directory. Always backup before migrating.

## Backup

Create and restore database backups.

```bash
pg_dump mydb > backup_$(date +%Y%m%d).sql
```

For SQLite: `sqlite3 mydb.db ".backup backup.db"`

Verify backup integrity before removing old backups.

## Troubleshooting

Common database issues and solutions.

- Connection refused: check if database server is running
- Locked database: ensure no concurrent write operations
- Migration conflicts: use `alembic history` to check state
- Slow queries: run `EXPLAIN ANALYZE` on the query