'use strict';

module.exports = {
  name: 'ebs_jobs',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ebs_jobs (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        connection_id INTEGER NOT NULL REFERENCES oracle_connections(id) ON DELETE CASCADE,
        op_key        VARCHAR(64) NOT NULL,
        status        TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','done','failed','timeout')),
        ok            BOOLEAN,
        stdout        TEXT,
        exit_code     INTEGER,
        duration_ms   INTEGER,
        created_by    INTEGER REFERENCES users(id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at    TIMESTAMPTZ,
        finished_at   TIMESTAMPTZ
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS ebs_jobs_connection_status
       ON ebs_jobs (connection_id, status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ebs_jobs_created_at
       ON ebs_jobs (created_at)`
    );
  },
};
