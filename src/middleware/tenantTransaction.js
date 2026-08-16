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
 */
module.exports = async function tenantTransaction(req, res, next) {
  const knex = req.app.get('db');
  const tenantId = req.user?.tenant_id;

  if (!tenantId) return next();

  let trx;
  try {
    trx = await knex.transaction();
    await trx.raw('SELECT set_config(?, ?, true)', ['app.current_tenant_id', String(tenantId)]);
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
