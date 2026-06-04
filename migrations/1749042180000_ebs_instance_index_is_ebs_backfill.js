module.exports = {
  name: 'ebs_instance_index_is_ebs_backfill',
  up: async (client) => {
    // Fast lookup for fleet grouping queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_oc_ebs_instance_name
        ON oracle_connections (ebs_instance_name)
        WHERE ebs_instance_name IS NOT NULL
    `);

    // Backfill is_ebs for existing connections: app/both server types are EBS by definition,
    // and any connection assigned to an EBS instance should be flagged too.
    await client.query(`
      UPDATE oracle_connections
         SET is_ebs = true
       WHERE is_ebs IS NOT TRUE
         AND (
           server_type IN ('apps', 'both')
           OR ebs_instance_name IS NOT NULL
         )
    `);
  },
};
