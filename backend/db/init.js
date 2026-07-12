const db = require('./index');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const ensureDatabaseExists = async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;

  let connectionString = databaseUrl;
  let dbName = 'stackchat';
  
  const lastSlashIndex = databaseUrl.lastIndexOf('/');
  if (lastSlashIndex !== -1) {
    const questionMarkIndex = databaseUrl.indexOf('?', lastSlashIndex);
    if (questionMarkIndex !== -1) {
      dbName = databaseUrl.substring(lastSlashIndex + 1, questionMarkIndex);
      connectionString = databaseUrl.substring(0, lastSlashIndex) + '/postgres' + databaseUrl.substring(questionMarkIndex);
    } else {
      dbName = databaseUrl.substring(lastSlashIndex + 1);
      connectionString = databaseUrl.substring(0, lastSlashIndex) + '/postgres';
    }
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
    const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (res.rows.length === 0) {
      console.log(`Database "${dbName}" does not exist. Creating...`);
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Database "${dbName}" created successfully.`);
    }
  } catch (err) {
    console.error(`Error checking/creating database "${dbName}":`, err.message);
  } finally {
    try {
      await client.end();
    } catch (e) {
      // Ignore
    }
  }
};

const initDb = async () => {
  // Ensure the target database exists on the PostgreSQL server
  await ensureDatabaseExists();

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Enable pgcrypto extension for gen_random_uuid
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    // 1. Create Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Create Conversations Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100),
        type VARCHAR(20) DEFAULT 'DIRECT',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. Create Participants Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS participants (
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        last_delivered_seq INT DEFAULT 0,
        last_read_seq INT DEFAULT 0,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (conversation_id, user_id)
      )
    `);

    // 4. Create Messages Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        sequence_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 5. Create B-Tree index for conversation-based chronological query
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created 
      ON messages (conversation_id, created_at DESC)
    `);

    // 6. Create GIN index for full-text search
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_body_search 
      ON messages USING GIN (to_tsvector('english', body))
    `);

    // 7. Create Unique Index to prevent sequence_id duplication per conversation
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_sequence 
      ON messages (conversation_id, sequence_id)
    `);

    // Seed default users if empty
    const userCountRes = await client.query('SELECT COUNT(*) FROM users');
    const userCount = parseInt(userCountRes.rows[0].count, 10);

    if (userCount === 0) {
      console.log('Seeding initial database data...');
      
      const adminHash = await bcrypt.hash('admin123', 10);
      const userHash = await bcrypt.hash('password123', 10);

      // Insert users
      const adminRes = await client.query(
        'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id',
        ['admin', adminHash, true]
      );
      const user1Res = await client.query(
        'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id',
        ['sarah_chen', userHash, false]
      );
      const user2Res = await client.query(
        'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id',
        ['marcus_johnson', userHash, false]
      );
      const user3Res = await client.query(
        'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id',
        ['alex_lee', userHash, false]
      );

      const adminId = adminRes.rows[0].id;
      const user1Id = user1Res.rows[0].id;
      const user2Id = user2Res.rows[0].id;
      const user3Id = user3Res.rows[0].id;

      // Create a default group conversation: #incident-response-34
      const groupConvRes = await client.query(
        "INSERT INTO conversations (name, type) VALUES ($1, $2) RETURNING id",
        ['incident-response-34', 'GROUP']
      );
      const groupConvId = groupConvRes.rows[0].id;

      // Add participants to the group conversation
      const participants = [adminId, user1Id, user2Id, user3Id];
      for (const userId of participants) {
        await client.query(
          'INSERT INTO participants (conversation_id, user_id) VALUES ($1, $2)',
          [groupConvId, userId]
        );
      }

      // Seed some initial messages
      const messages = [
        { sender: user1Id, body: 'CRITICAL: High latency detected on database shard 04.' },
        { sender: user2Id, body: "I'm looking into this now. It looks like a runaway query from the new analytics dashboard deployment." },
        { sender: adminId, body: "Good catch. I'll temporarily disable the analytics cron job to relieve pressure on the shard." }
      ];

      let seq = 1;
      for (const msg of messages) {
        await client.query(
          'INSERT INTO messages (conversation_id, sender_id, body, sequence_id) VALUES ($1, $2, $3, $4)',
          [groupConvId, msg.sender, msg.body, seq]
        );
        seq++;
      }

      // Update participant sequences to match the last seeded message (sequence_id = 3)
      await client.query(
        'UPDATE participants SET last_delivered_seq = 3, last_read_seq = 3 WHERE conversation_id = $1',
        [groupConvId]
      );

      console.log('Seeding complete.');
    }

    await client.query('COMMIT');
    console.log('Database initialized successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Database initialization failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = initDb;
