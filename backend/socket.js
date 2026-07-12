const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { pubClient, subClient } = require('./redis');

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('CRITICAL CONFIG ERROR: JWT_SECRET environment variable must be defined in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtsecretkeystackchat';
const NODE_ID = process.env.NODE_ID || 'Node_01_PROD';

const setupSocket = (server) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',') 
    : '*';

  const io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST']
    },
    // Enable Connection State Recovery (CSR)
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
      skipMiddlewares: true
    }
  });

  // Attach Redis adapter if connected
  if (pubClient.status === 'ready') {
    io.adapter(createAdapter(pubClient, subClient));
    console.log('Socket.IO Redis adapter attached.');
  } else {
    console.log('Redis not ready, operating in standalone memory mode.');
  }

  // 1. Handshake authorization - Stateless validation, ZERO DB HITS!
  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers['authorization']?.replace('Bearer ', '');

    if (!token) {
      return next(new Error('Authentication error: Token not provided'));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (error) {
      console.error('Socket handshake token validation error:', error.message);
      return next(new Error('Authentication error: Token is invalid'));
    }
  });

  // Keep track of node health
  const reportNodeHealth = async () => {
    try {
      const health = {
        lastActive: Date.now(),
        activeSockets: io.engine.clientsCount,
        status: 'Active'
      };
      await pubClient.hset('nodes_health', NODE_ID, JSON.stringify(health));
    } catch (err) {
      // Quietly ignore if Redis standalone is running without hashing capabilities
    }
  };
  
  if (pubClient.status === 'ready') {
    setInterval(reportNodeHealth, 10000);
    reportNodeHealth();
  }

  io.on('connection', async (socket) => {
    const userId = socket.user.id;
    const username = socket.user.username;

    console.log(`User connected: ${username} (${userId}) on ${NODE_ID}. Socket ID: ${socket.id}`);

    // Join user to their personal room (useful for direct notifications)
    socket.join(userId);

    // Register presence in Redis (with 15s expiration)
    const updatePresence = async () => {
      try {
        await pubClient.set(`presence:${userId}`, NODE_ID, 'EX', 15);
        // Broadcast presence update to conversations the user is in
        const userConversations = await db.query(
          'SELECT conversation_id FROM participants WHERE user_id = $1',
          [userId]
        );
        userConversations.rows.forEach((row) => {
          socket.to(row.conversation_id).emit('user_status_changed', {
            userId,
            username,
            status: 'online'
          });
        });
      } catch (err) {
        // Fallback for standalone
      }
    };

    await updatePresence();

    // Join conversation rooms
    socket.on('join_conversations', async () => {
      try {
        const rooms = await db.query(
          'SELECT conversation_id FROM participants WHERE user_id = $1',
          [userId]
        );
        console.log(`Socket ${socket.id} (User: ${username}) joining rooms:`, rooms.rows.map(r => r.conversation_id));
        rooms.rows.forEach((row) => {
          socket.join(row.conversation_id);
          // Update delivery cursor on join
          db.query(
            `UPDATE participants 
             SET last_delivered_seq = COALESCE((SELECT MAX(sequence_id) FROM messages WHERE conversation_id = $1), 0)
             WHERE conversation_id = $1 AND user_id = $2`,
            [row.conversation_id, userId]
          ).catch(e => console.error(e));
        });
      } catch (err) {
        console.error('Error joining conversations:', err);
      }
    });

    // Explicit room join
    socket.on('join_room', (conversationId) => {
      socket.join(conversationId);
      console.log(`Socket ${socket.id} joined room ${conversationId}`);
    });

    // Heartbeat from client to maintain presence
    socket.on('heartbeat', async () => {
      await updatePresence();
    });

    // Message Ingestion and Routing
    socket.on('send_message', async (data, callback) => {
      const { conversationId, body } = data;

      if (!conversationId || !body || body.trim() === '') {
        if (callback) callback({ error: 'Conversation ID and body are required' });
        return;
      }

      try {
        // Validate user is a participant
        const checkPart = await db.query(
          'SELECT 1 FROM participants WHERE conversation_id = $1 AND user_id = $2',
          [conversationId, userId]
        );
        if (checkPart.rows.length === 0) {
          if (callback) callback({ error: 'Access denied: not a participant' });
          return;
        }

        // Self-heal: Ensure sender socket is joined to this room to receive the broadcast
        socket.join(conversationId);

        // Insert message & increment sequence_id atomically per conversation (with unique constraint retry support)
        let msgResult;
        let retries = 3;
        while (retries > 0) {
          try {
            msgResult = await db.query(
              `INSERT INTO messages (conversation_id, sender_id, body, sequence_id)
               VALUES ($1, $2, $3, COALESCE((SELECT MAX(sequence_id) FROM messages WHERE conversation_id = $1), 0) + 1)
               RETURNING id, conversation_id, sender_id, body, sequence_id, created_at`,
              [conversationId, userId, body]
            );
            break;
          } catch (insertError) {
            if (insertError.code === '23505' && retries > 1) {
              retries--;
              console.warn(`Concurrency collision on sequence_id for conversation ${conversationId}. Retrying... (${retries} attempts left)`);
              await new Promise((resolve) => setTimeout(resolve, Math.random() * 50));
            } else {
              throw insertError;
            }
          }
        }

        const newMessage = {
          ...msgResult.rows[0],
          sender_name: username
        };

        // Broadcast message to conversation room (handled by Redis adapter across servers)
        console.log(`Server broadcasting new_message to room ${conversationId}:`, newMessage);
        io.to(conversationId).emit('new_message', newMessage);

        // Update sender's cursors instantly
        await db.query(
          `UPDATE participants 
           SET last_delivered_seq = $1, last_read_seq = $1 
           WHERE conversation_id = $2 AND user_id = $3`,
          [newMessage.sequence_id, conversationId, userId]
        );

        if (callback) callback({ success: true, message: newMessage });
      } catch (err) {
        console.error('Error processing send_message:', err);
        if (callback) callback({ error: 'Server failed to store message' });
      }
    });

    // Typing Indicators - Purely Ephemeral Relay
    socket.on('typing:start', (conversationId) => {
      socket.to(conversationId).emit('typing:status', {
        conversationId,
        userId,
        username,
        isTyping: true
      });
    });

    socket.on('typing:stop', (conversationId) => {
      socket.to(conversationId).emit('typing:status', {
        conversationId,
        userId,
        username,
        isTyping: false
      });
    });

    // Cursor-Based Read Receipts (Updates database cursor & broadcasts receipt in real-time)
    socket.on('read_receipt', async (data) => {
      const { conversationId, sequenceId } = data;
      if (!conversationId || !sequenceId) return;

      try {
        // Update database cursor to the highest known sequence
        await db.query(
          `UPDATE participants 
           SET last_read_seq = GREATEST(last_read_seq, $1) 
           WHERE conversation_id = $2 AND user_id = $3`,
          [sequenceId, conversationId, userId]
        );

        // Broadcast update to other members of the conversation
        socket.to(conversationId).emit('read_receipt_updated', {
          conversationId,
          userId,
          lastReadSeq: sequenceId
        });
      } catch (err) {
        console.error('Error updating read receipt:', err);
      }
    });

    // User logging out or disconnecting
    socket.on('disconnect', async () => {
      console.log(`Socket disconnected: ${socket.id} (User: ${username})`);

      // Check if user has other active connections on this server or cluster
      // Since a single user can have multiple tabs open, we only mark offline when all sockets drop
      setTimeout(async () => {
        try {
          const activeSockets = io.sockets.adapter.rooms.get(userId);
          const hasLocalConnections = activeSockets && activeSockets.size > 0;

          if (!hasLocalConnections) {
            // Delete presence key in Redis
            await pubClient.del(`presence:${userId}`);

            // Broadcast offline status
            const userConversations = await db.query(
              'SELECT conversation_id FROM participants WHERE user_id = $1',
              [userId]
            );
            userConversations.rows.forEach((row) => {
              io.to(row.conversation_id).emit('user_status_changed', {
                userId,
                username,
                status: 'offline'
              });
            });
            console.log(`User ${username} marked offline.`);
          }
        } catch (err) {
          // Ignore
        }
      }, 2000); // 2 second delay to prevent rapid toggle during page refreshes/switching
    });
  });

  // Admin disconnect listener - forced user disconnect by admin
  io.of('/').adapter.on('admin_disconnect_user', (userId) => {
    const clients = io.sockets.adapter.rooms.get(userId);
    if (clients) {
      for (const clientId of clients) {
        const clientSocket = io.sockets.sockets.get(clientId);
        if (clientSocket) {
          clientSocket.disconnect(true);
        }
      }
    }
  });

  return io;
};

module.exports = setupSocket;
