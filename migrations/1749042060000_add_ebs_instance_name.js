module.exports = {
  name: 'add_ebs_instance_name',
  up: async (client) => {
    await client.query(`
      ALTER TABLE oracle_connections
        ADD COLUMN IF NOT EXISTS ebs_instance_name VARCHAR(64)
    `);
  },
};
