const express = require('express');
const http = require('http');
const cors = require('cors');
require('dotenv').config();

const initDb = require('./db/init');
const db = require('./db');
const { pubClient, subClient } = require('./redis');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');
const setupSocket = require('./socket');

const app = express();
const server = http.createServer(app);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : 'http://localhost:3000';

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

const rateLimiter = require('./middleware/rateLimit');
const authLimiter = rateLimiter(100, 15 * 60 * 1000); // Limit IP to 100 req per 15 minutes

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);

// Simple Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    nodeId: process.env.NODE_ID || 'Node_01_PROD',
    db: db.pool ? 'CONNECTED' : 'DISCONNECTED',
    redis: pubClient.status
  });
});

// Port and server initialization
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // 1. Initialize Database schema and seeding with retry backoff
    console.log('Initializing PostgreSQL Database...');
    let retries = 5;
    let dbConnected = false;
    while (retries > 0 && !dbConnected) {
      try {
        await initDb();
        dbConnected = true;
      } catch (dbErr) {
        retries--;
        console.error(`PostgreSQL connection failed: ${dbErr.message}. Retrying in 3 seconds... (${retries} attempts remaining)`);
        if (retries === 0) {
          throw new Error('PostgreSQL database initialization failed after maximum retries.');
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
    }

    // 2. Connect Redis clients if urls provided
    if (pubClient.status !== 'ready' && pubClient.status !== 'connecting') {
      try {
        await pubClient.connect();
        await subClient.connect();
        console.log('Redis Clients connected successfully.');
      } catch (redisErr) {
        console.warn('Redis connection failed, working in standalone memory fallback mode.', redisErr.message);
      }
    }

    // 3. Setup Socket.IO Server
    console.log('Setting up Socket.IO orchestration...');
    const io = setupSocket(server);
    app.set('io', io);
    // Wait, let's attach it inside setupSocket, or we can just capture the returned io instance.
    // Let's modify socket.io setup inside setupSocket to return the io instance!
    
    // Bind server to port
    server.listen(PORT, () => {
      console.log(`Server Node is running on port ${PORT}`);
      console.log(`WebSocket handler configured, Node ID: ${process.env.NODE_ID || 'Node_01_PROD'}`);
    });
  } catch (err) {
    console.error('Critical server startup failure:', err);
    process.exit(1);
  }
};

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Shutdown signal received. Closing database and caching pools...');
  
  server.close(() => {
    console.log('HTTP server closed.');
  });

  try {
    await db.pool.end();
    console.log('Postgres connection pool terminated.');
  } catch (dbErr) {
    console.error('Error closing Postgres pool:', dbErr);
  }

  try {
    await pubClient.quit();
    await subClient.quit();
    console.log('Redis connections closed.');
  } catch (redisErr) {
    console.error('Error closing Redis connections:', redisErr);
  }

  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

startServer();
