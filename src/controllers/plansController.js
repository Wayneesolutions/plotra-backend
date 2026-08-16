/**
 * Super-admin management of subscription plans (gap #3). Mounted under
 * /api/v1/admin, which already applies authGuard + adminGuard +
 * serviceContext in routes/admin.js.
 */

async function listPlansAdmin(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  try {
    const plans = await knex('plans').orderBy('sort_order', 'asc');
    return res.json({ success: true, plans });
  } catch (error) {
    console.error('Failed to list plans:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch plans.' } });
  }
}

/**
 * PATCH /api/v1/admin/plans/:key
 * Partial update — price, listing limit, features, active status, or
 * display order. The plan `key` itself is immutable (it's the primary key
 * and is referenced by tenants.plan) — create a new plan row instead of
 * renaming an existing key if a whole new tier is needed.
 */
async function updatePlan(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { key } = req.params;
  const allowedFields = ['label', 'price_inr', 'listing_limit', 'features', 'is_active', 'sort_order'];

  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No valid fields provided to update.' } });
  }

  if (updates.price_inr !== undefined && (!Number.isFinite(updates.price_inr) || updates.price_inr <= 0)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'price_inr must be a positive number.' } });
  }

  if (updates.listing_limit !== undefined && updates.listing_limit !== null && (!Number.isInteger(updates.listing_limit) || updates.listing_limit <= 0)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'listing_limit must be a positive integer, or null for unlimited.' } });
  }

  if (updates.features !== undefined) {
    updates.features = JSON.stringify(updates.features);
  }

  updates.updated_at = knex.fn.now();

  try {
    const existing = await knex('plans').where({ key }).first();
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found.' } });
    }

    const [plan] = await knex('plans').where({ key }).update(updates).returning('*');
    return res.json({ success: true, plan });
  } catch (error) {
    console.error('Failed to update plan:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update plan.' } });
  }
}

/**
 * POST /api/v1/admin/plans
 * Creates a whole new plan tier.
 */
async function createPlan(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { key, label, price_inr, listing_limit = null, features = [], sort_order = 0 } = req.body;

  if (!key || !label || !Number.isFinite(price_inr) || price_inr <= 0) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'key, label, and a positive price_inr are required.' },
    });
  }

  try {
    const existing = await knex('plans').where({ key }).first();
    if (existing) {
      return res.status(409).json({ error: { code: 'DUPLICATE_ENTRY', message: `A plan with key "${key}" already exists.` } });
    }

    const [plan] = await knex('plans')
      .insert({
        key,
        label,
        price_inr,
        listing_limit,
        features: JSON.stringify(features),
        sort_order,
        is_active: true,
      })
      .returning('*');

    return res.status(201).json({ success: true, plan });
  } catch (error) {
    console.error('Failed to create plan:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create plan.' } });
  }
}

/**
 * DELETE /api/v1/admin/plans/:key
 * Hard-deletes a plan only if no tenants are currently subscribed to it.
 * If tenants exist on this plan, returns 409 — deactivate instead.
 */
async function deletePlan(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { key } = req.params;

  try {
    const existing = await knex('plans').where({ key }).first();
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found.' } });
    }

    const { count } = await knex('tenants').where({ plan: key }).count('id as count').first();
    if (parseInt(count, 10) > 0) {
      return res.status(409).json({
        error: {
          code: 'PLAN_IN_USE',
          message: `Cannot delete — ${count} tenant(s) are on this plan. Deactivate it instead to hide it from new signups.`,
        },
      });
    }

    await knex('plans').where({ key }).delete();
    return res.json({ success: true, message: `Plan "${key}" has been deleted.` });
  } catch (error) {
    console.error('Failed to delete plan:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete plan.' } });
  }
}

module.exports = { listPlansAdmin, updatePlan, createPlan, deletePlan };
