const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/jwtSecret');

/**
 * The blog admin panel is deliberately separate from the dealer dashboard
 * and the super-admin panel: its own login (BLOG_ADMIN_EMAIL /
 * BLOG_ADMIN_PASSWORD), its own token.
 *
 * Tokens are signed with a key DERIVED from JWT_SECRET rather than
 * JWT_SECRET itself, so the two kinds of token can never be swapped: a blog
 * admin token fails authGuard (middleware/auth.js) and a dashboard/super-
 * admin token fails this guard. No extra secret to provision.
 */
const BLOG_ADMIN_JWT_SECRET = crypto
  .createHmac('sha256', JWT_SECRET)
  .update('plotraa-blog-admin')
  .digest('hex');

const BLOG_ADMIN_TOKEN_TTL = '12h';

function signBlogAdminToken(email) {
  return jwt.sign({ scope: 'blog_admin', email }, BLOG_ADMIN_JWT_SECRET, {
    expiresIn: BLOG_ADMIN_TOKEN_TTL,
  });
}

function blogAdminGuard(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Sign in to the blog admin to continue.' },
    });
  }

  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], BLOG_ADMIN_JWT_SECRET);
    if (decoded.scope !== 'blog_admin') throw new Error('wrong scope');
    req.blogAdmin = { email: decoded.email };
    return next();
  } catch (_err) {
    return res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Your blog admin session has expired. Sign in again.' },
    });
  }
}

module.exports = { blogAdminGuard, signBlogAdminToken };
