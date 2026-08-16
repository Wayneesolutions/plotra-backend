/**
 * Sits after authGuard in the chain. authGuard already verified the JWT
 * and populated req.user — this just enforces the super_admin role gate.
 */
module.exports = function adminGuard(req, res, next) {
  if (req.user?.role !== 'super_admin') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Super admin access required.' }
    });
  }
  next();
};
