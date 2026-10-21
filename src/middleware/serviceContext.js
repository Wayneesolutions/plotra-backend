/**
 * For routes that legitimately need cross-tenant DB access and already
 * have their own independent authorization check:
 *   - Admin routes: adminGuard verifies a JWT with role=super_admin
 *   - Webhook routes: an HMAC signature from the BSP/payment provider
 *
 * Neither of those is "tenant matching," so wrapping them in
 * tenantTransaction (which sets app.current_tenant_id) doesn't make sense —
 * there's no single tenant to set. Before this middleware existed, these
 * routes used the raw connection pool (req.app.get('db')), which under the
 * Phase 5 RLS policies happened to still work only because those policies
 * allowed everything through when no tenant context was set — the same
 * permissive default that made a forgotten-middleware bug invisible
 * elsewhere. Now that the default is deny, these routes need an explicit,
 * intentional way to say "yes, cross-tenant access is correct here" —
 * this middleware is that explicit opt-in.
 */
module.exports = async function serviceContext(req, res, next) {
  const knex = req.app.get('db');

  let trx;
  try {
    trx = await knex.transaction();
    await trx.raw("SELECT set_config('app.is_service_context', 'true', true)");
    req.dbTrx = trx;
  } catch (err) {
    return next(err);
  }

  const finish = (shouldRollback) => {
    if (trx.isCompleted()) return;
    const op = shouldRollback ? trx.rollback() : trx.commit();
    op.catch(() => {});
  };

  res.on('finish', () => finish(res.statusCode >= 500));
  // 'close' without 'finish' means the caller (e.g. the BSP, after its own
  // timeout) hung up while the handler was still working. Rolling back at
  // that moment made every later query in the handler fail with "Transaction
  // query already complete" (a slow assistant reply lost its history and
  // confirmation, and the BSP's retry ran the whole message again, raising a
  // second support request). Give the handler time to finish and commit its
  // work like a normal request; the timer is only a cap for a stuck handler.
  res.on('close', () => {
    if (res.writableFinished) return finish(false);
    const timer = setTimeout(() => finish(false), Number(process.env.SERVICE_TRX_ABORT_GRACE_MS || 45000));
    timer.unref();
  });

  next();
};
