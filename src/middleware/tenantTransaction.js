/**
 * Wraps every tenant-scoped dashboard request in a single Knex transaction
 * and sets SET LOCAL app.current_tenant_id inside it.
 *
 * Why a transaction per request (not a one-off set_config call):
 *   Knex uses a connection pool. A bare knex.raw("SET LOCAL ...") runs on
 *   whichever pooled connection it happens to get — the very next query in
 *   the same request can land on a different connection that never had the
 *   tenant ID set on it. SET LOCAL (unlike SET) is scoped to the current
 *   transaction, so pinning the whole request to one transaction guarantees
 *   every query in that request sees the same tenant context.
 *
 * Must be applied AFTER authGuard — req.user.tenant_id must already exist.
 *
 * Controllers access the transaction via req.dbTrx. The fallback to
 * req.app.get('db') keeps older code paths working if this middleware is
 * ever not applied.
 *
 * Dashboard-access gate (Part 2, build-order item 5): this is the ONE place
 * every dashboard route passes through (every route.js line applies
 * authGuard + tenantTransaction — confirmed by grep, nothing else uses this
 * middleware), so it's where plans.dashboard_access is enforced, rather than
 * repeating a check on every individual route. A Tier 1 tenant should never
 * actually reach this — the WhatsApp self-serve onboarding flow (Part 3)
 * never creates a users row for one in the first place, so there's no
 * credential to log in with — but this still blocks the one real edge case
 * that isn't "no account exists": an existing Tier 2/3 tenant whose plan
 * gets downgraded to one with dashboard_access = false, whose users rows
 * and JWTs still exist until this catches them.
 */
module.exports = async function tenantTransaction(req, res, next) {
  const knex = req.app.get('db');
  const tenantId = req.user?.tenant_id;

  if (!tenantId) return next();

  let trx;
  try {
    trx = await knex.transaction();
    await trx.raw('SELECT set_config(?, ?, true)', ['app.current_tenant_id', String(tenantId)]);

    const tenant = await trx('tenants')
      .join('plans', 'plans.key', 'tenants.plan')
      .where('tenants.id', tenantId)
      .select('plans.dashboard_access')
      .first();

    // tenant/plan not found (shouldn't happen for a valid JWT, but fail
    // closed rather than open) or the plan explicitly excludes dashboard
    // access — reject before any dashboard query runs, not after.
    if (!tenant || tenant.dashboard_access === false) {
      await trx.rollback().catch(() => {});
      return res.status(403).json({
        error: { code: 'PLAN_RESTRICTED', message: 'Your current plan does not include dashboard access.' }
      });
    }

    req.dbTrx = trx;
  } catch (err) {
    return next(err);
  }

  const finish = (shouldRollback) => {
    if (trx.isCompleted()) return;
    const op = shouldRollback ? trx.rollback() : trx.commit();
    op.catch(() => {}); // nothing useful to do if this fails after response is sent
  };

  res.on('finish', () => finish(res.statusCode >= 500));
  res.on('close', () => finish(true)); // connection dropped mid-request

  next();
};
