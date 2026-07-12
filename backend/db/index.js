const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  queryOne: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows[0] || null;
  },
  queryMany: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows;
  },
  pool
};
