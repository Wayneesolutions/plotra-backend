const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/jwtSecret');

/**
 * Protects backoffice dashboard routes, authenticates claims, and binds tenant IDs securely.
 */
module.exports = function authGuard(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Access denied. Missing bearer authorization header.' }
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Inject immutable contextual constraints into downstream request processors
    req.user = {
      id: decoded.userId,
      tenant_id: decoded.tenantId,
      role: decoded.role
    };

    next();
  } catch (err) {
    return res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Authentication handshake token has expired or is structurally malformed.' }
    });
  }
};