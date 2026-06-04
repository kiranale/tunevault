module.exports = {
  name: 'add_apps_weblogic_pwd_enc',
  up: async (client) => {
    await client.query(`
      ALTER TABLE oracle_connections
        ADD COLUMN IF NOT EXISTS apps_pwd_enc    TEXT,
        ADD COLUMN IF NOT EXISTS weblogic_pwd_enc TEXT
    `);
  },
};
