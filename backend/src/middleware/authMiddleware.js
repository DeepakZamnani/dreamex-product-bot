const jwt = require('jsonwebtoken');

// Basic authentication middleware
const authMiddleware = (req, res, next) => {
  try {
    // Get token from header
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

// Admin-only middleware
const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      message: 'Access denied. Admin privileges required.' 
    });
  }
  next();
};

// Client-only middleware
const clientOnly = (req, res, next) => {
  if (req.user.role !== 'client') {
    return res.status(403).json({ 
      message: 'Access denied. Client privileges required.' 
    });
  }
  next();
};

// Allow both admin and client
const authenticatedOnly = authMiddleware;

module.exports = {
  authMiddleware,
  adminOnly,
  clientOnly,
  authenticatedOnly
};