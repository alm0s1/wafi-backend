const jwt = require('jsonwebtoken');

/**
 * Middleware that verifies a JWT Bearer token from the Authorization header.
 * On success, attaches { id, type, email } to req.user.
 * Supports both 'business' and 'customer' token types.
 */
async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization token required' });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authorization token missing' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error('JWT_SECRET is not set in environment');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const decoded = jwt.verify(token, secret);

    if (!decoded.id || !decoded.type) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    req.user = {
      id: decoded.id,
      type: decoded.type,   // 'business' | 'customer'
      email: decoded.email,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    console.error('Auth middleware error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Middleware factory that restricts access to a specific user type.
 * Use after authMiddleware.
 * @param {'business'|'customer'} type
 */
function requireType(type) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.user.type !== type) {
      return res.status(403).json({ error: `Access restricted to ${type} accounts` });
    }
    next();
  };
}

module.exports = { authMiddleware, requireType };
