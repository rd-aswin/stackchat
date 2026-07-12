const express = require('express');
const router = express.Router();
const db = require('../db');
const { adminMiddleware } = require('../middleware/auth');
const { pubClient } = require('../redis');

// Admin panel dashboard statistics
router.get('/stats', adminMiddleware, async (req, res) => {
  try {
    // 1. Fetch PostgreSQL metrics
    const userCountRes = await db.query('SELECT COUNT(*) FROM users');
    const conversationCountRes = await db.query('SELECT COUNT(*) FROM conversations');
    const messageCountRes = await db.query('SELECT COUNT(*) FROM messages');

    // 2. Fetch database size metrics (PostgreSQL specific)
    const dbSizeRes = await db.query(
      "SELECT pg_size_pretty(pg_database_size(current_database())) as db_size"
    );
    const messagesTableSizeRes = await db.query(
      "SELECT pg_size_pretty(pg_total_relation_size('messages')) as table_size"
    );

    // 3. Scan Redis for active WebSocket presence keys
    // In a multi-node cluster, we store presence as presence:${userId} with TTL
    let activeConnectionsCount = 0;
    try {
      let cursor = '0';
      let keysCount = 0;
      do {
        const [nextCursor, keys] = await pubClient.scan(cursor, 'MATCH', 'presence:*', 'COUNT', 100);
        cursor = nextCursor;
        keysCount += keys.length;
      } while (cursor !== '0');
      activeConnectionsCount = keysCount;
    } catch (redisError) {
      console.error('Error scanning Redis presence keys:', redisError);
      // Fallback: query active sockets on this local node if Redis fails
      activeConnectionsCount = req.app.get('io') ? req.app.get('io').engine.clientsCount : 0;
    }

    // 4. Retrieve list of active servers (nodes) reporting presence
    // In our cluster, each server registers its own health periodically in a Redis Hash 'nodes_health'
    let serverNodes = [];
    try {
      const nodesData = await pubClient.hgetall('nodes_health');
      serverNodes = Object.entries(nodesData).map(([nodeId, healthJson]) => {
        try {
          return { nodeId, ...JSON.parse(healthJson) };
        } catch {
          return { nodeId, lastActive: healthJson };
        }
      });
    } catch (redisErr) {
      serverNodes = [{ nodeId: process.env.NODE_ID || 'Node_01_PROD', activeSockets: activeConnectionsCount, status: 'Active' }];
    }

    res.json({
      dbStats: {
        totalUsers: parseInt(userCountRes.rows[0].count, 10),
        totalConversations: parseInt(conversationCountRes.rows[0].count, 10),
        totalMessages: parseInt(messageCountRes.rows[0].count, 10),
        dbSize: dbSizeRes.rows[0]?.db_size || 'N/A',
        messagesTableSize: messagesTableSizeRes.rows[0]?.table_size || 'N/A',
      },
      realtimeStats: {
        activeSockets: activeConnectionsCount,
        serverNodes
      }
    });
  } catch (error) {
    console.error('Fetch admin stats error:', error);
    res.status(500).json({ error: 'Server error fetching admin stats' });
  }
});

// Admin endpoint to delete a user (and clean up connections)
router.delete('/users/:id', adminMiddleware, async (req, res) => {
  const userIdToDelete = req.params.id;

  if (userIdToDelete === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own admin account.' });
  }

  try {
    // Delete user (Postgres cascade rules will wipe participants and messages)
    const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING username', [userIdToDelete]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Clean up presence in Redis
    try {
      await pubClient.del(`presence:${userIdToDelete}`);
    } catch (redisErr) {
      console.error('Redis delete presence error:', redisErr);
    }

    // Force disconnect this user's WS sockets by publishing an admin event to the cluster
    const io = req.app.get('io');
    if (io) {
      // Broadcast disconnect signal across cluster
      io.emit('admin_disconnect_user', userIdToDelete);
    }

    res.json({ message: `Successfully deleted user ${result.rows[0].username}` });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Server error deleting user' });
  }
});

module.exports = router;
