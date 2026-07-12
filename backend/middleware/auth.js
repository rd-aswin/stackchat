const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtsecretkeysystemchatv2';

const authMiddleware = (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader) {
    return res.status(401).json({ error: 'No token, authorization denied' });
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token is not valid' });
  }
};

const adminMiddleware = (req, res, next) => {
  authMiddleware(req, res, () => {
    if (req.user && req.user.is_admin) {
      next();
    } else {
      res.status(403).json({ error: 'Access denied: Admin role required' });
    }
  });
};

module.exports = {
  authMiddleware,
  adminMiddleware
};
