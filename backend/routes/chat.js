const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

// Get all conversations for the logged in user
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.type, c.created_at,
              p.last_read_seq, p.last_delivered_seq,
              (
                SELECT json_agg(json_build_object('id', u.id, 'username', u.username, 'last_read_seq', p2.last_read_seq))
                FROM participants p2
                JOIN users u ON u.id = p2.user_id
                WHERE p2.conversation_id = c.id
              ) as participants,
              COALESCE((SELECT MAX(sequence_id) FROM messages m WHERE m.conversation_id = c.id), 0) as max_sequence_id
       FROM conversations c
       JOIN participants p ON p.conversation_id = c.id
       WHERE p.user_id = $1
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Fetch conversations error:', error);
    res.status(500).json({ error: 'Server error fetching conversations' });
  }
});

// Create a new conversation
router.post('/conversations', authMiddleware, async (req, res) => {
  const { name, type, participantIds } = req.body; // participantIds should be array of UUIDs
  const currentUserId = req.user.id;

  if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
    return res.status(400).json({ error: 'Participants are required' });
  }

  // Deduplicate and ensure current user is included
  const allParticipants = Array.from(new Set([...participantIds, currentUserId]));

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // For direct message, verify if a 1:1 room already exists between the exact pair
    if (type === 'DIRECT' && allParticipants.length === 2) {
      const existingDM = await client.query(
        `SELECT p1.conversation_id 
         FROM participants p1
         JOIN participants p2 ON p1.conversation_id = p2.conversation_id
         JOIN conversations c ON c.id = p1.conversation_id
         WHERE c.type = 'DIRECT' AND p1.user_id = $1 AND p2.user_id = $2`,
        [allParticipants[0], allParticipants[1]]
      );

      if (existingDM.rows.length > 0) {
        // Return existing conversation id
        await client.query('ROLLBACK');
        return res.json({ id: existingDM.rows[0].conversation_id, existing: true });
      }
    }

    // Create the conversation
    const convName = type === 'DIRECT' ? null : (name || 'Group Chat');
    const convResult = await client.query(
      'INSERT INTO conversations (name, type) VALUES ($1, $2) RETURNING *',
      [convName, type || 'DIRECT']
    );
    const conversationId = convResult.rows[0].id;

    // Add participants
    for (const userId of allParticipants) {
      await client.query(
        'INSERT INTO participants (conversation_id, user_id) VALUES ($1, $2)',
        [conversationId, userId]
      );
    }

    await client.query('COMMIT');

    // Fetch newly created conversation with participant profiles
    const fullConvDetails = await db.query(
      `SELECT c.id, c.name, c.type, c.created_at,
              0 as last_read_seq, 0 as last_delivered_seq,
              (
                SELECT json_agg(json_build_object('id', u.id, 'username', u.username, 'last_read_seq', p2.last_read_seq))
                FROM participants p2
                JOIN users u ON u.id = p2.user_id
                WHERE p2.conversation_id = c.id
              ) as participants,
              0 as max_sequence_id
       FROM conversations c
       WHERE c.id = $1`,
      [conversationId]
    );

    const createdRoom = fullConvDetails.rows[0];
    const io = req.app.get('io');
    if (io) {
      allParticipants.forEach((pId) => {
        io.to(pId).emit('conversation_created', createdRoom);
      });
    }

    res.status(201).json(createdRoom);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Server error creating conversation' });
  } finally {
    client.release();
  }
});

// Get historical messages for a conversation (Uses leftmost prefix index idx_messages_conversation_created)
router.get('/conversations/:id/messages', authMiddleware, async (req, res) => {
  const conversationId = req.params.id;
  const currentUserId = req.user.id;
  const limit = parseInt(req.query.limit, 10) || 50;
  const beforeTime = req.query.beforeTime; // ISO timestamp for pagination

  try {
    // Verify user is a participant
    const checkParticipant = await db.query(
      'SELECT 1 FROM participants WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, currentUserId]
    );

    if (checkParticipant.rows.length === 0) {
      return res.status(403).json({ error: 'You are not a participant in this conversation' });
    }

    let queryText = `
      SELECT m.id, m.conversation_id, m.sender_id, m.body, m.sequence_id, m.created_at, u.username as sender_name
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1
    `;
    const params = [conversationId];

    if (beforeTime) {
      queryText += ` AND m.created_at < $2`;
      params.push(beforeTime);
    }

    queryText += `
      ORDER BY m.conversation_id, m.created_at DESC
      LIMIT $${params.length + 1}
    `;
    params.push(limit);

    const result = await db.query(queryText, params);

    // Messages are fetched DESC. Reverse them for chronological delivery to client
    const messages = result.rows.reverse();

    res.json(messages);
  } catch (error) {
    console.error('Fetch messages error:', error);
    res.status(500).json({ error: 'Server error fetching messages' });
  }
});

// Search messages using PostgreSQL GIN index and tsquery
router.get('/search/messages', authMiddleware, async (req, res) => {
  const { query } = req.query;
  const currentUserId = req.user.id;

  if (!query || query.trim() === '') {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    // Find messages matching query but only from conversations the user has access to
    const result = await db.query(
      `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.sequence_id, m.created_at,
              u.username as sender_name, c.name as conversation_name, c.type as conversation_type
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       JOIN conversations c ON c.id = m.conversation_id
       JOIN participants p ON p.conversation_id = c.id
       WHERE p.user_id = $1
         AND to_tsvector('english', m.body) @@ plainto_tsquery('english', $2)
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [currentUserId, query]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Search messages error:', error);
    res.status(500).json({ error: 'Server error searching messages' });
  }
});

// Get list of all users (excluding current user) to start new chat
router.get('/users', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, username, is_admin FROM users WHERE id != $1 ORDER BY username ASC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Fetch users error:', error);
    res.status(500).json({ error: 'Server error fetching users' });
  }
});

module.exports = router;
