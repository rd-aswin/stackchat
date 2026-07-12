const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('CRITICAL CONFIG ERROR: JWT_SECRET environment variable must be defined in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtsecretkeystackchat';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// Register User (No guest users permitted)
router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters long.' });
  }

  // Password strength validation: min 8 chars, at least 1 letter and 1 number
  const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;
  if (!passwordRegex.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long and contain both letters and numbers.' });
  }

  try {
    // Check if user exists
    const userExist = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    if (userExist.rows.length > 0) {
      return res.status(400).json({ error: 'Username is already taken' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await db.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, is_admin',
      [username, passwordHash]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({ token, user: { id: user.id, username: user.username, is_admin: user.is_admin } });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Login User
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    
    let isMatch = false;
    let user = null;

    if (result.rows.length > 0) {
      user = result.rows[0];
      isMatch = await bcrypt.compare(password, user.password_hash);
    } else {
      // Perform a dummy bcrypt comparison to defend against timing side-channel attacks
      await bcrypt.compare(password, '$2b$10$Z3VtbXloYXNoZm9ydGltaW5nYXR0YWNrcw==');
    }

    if (!user || !isMatch) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({ token, user: { id: user.id, username: user.username, is_admin: user.is_admin } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

module.exports = router;
