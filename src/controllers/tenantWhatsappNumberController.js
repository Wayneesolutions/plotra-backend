// src/controllers/tenantWhatsappNumberController.js
//
// Owner-only management of a tenant's WhatsApp numbers — same access
// pattern as userInviteController.js's team invites. Mounted under
// /api/v1/dashboard, so authGuard + tenantTransaction already ran.

const { WhatsappNumberLimitError, listNumbers, addNumber, removeNumber, setDefault } = require('../services/tenantWhatsappNumberService');

async function getWhatsappNumbers(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id } = req.user;

  try {
    const numbers = await listNumbers(knex, tenant_id);
    return res.json({ success: true, numbers });
  } catch (error) {
    console.error('Failed to list WhatsApp numbers:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load WhatsApp numbers.' } });
  }
}

async function postWhatsappNumber(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;
  const { whatsappNumber, phoneNumberId, label } = req.body;

  if (role !== 'owner') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only tenant owners can manage WhatsApp numbers.' } });
  }
  if (!whatsappNumber) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'whatsappNumber is required.' } });
  }

  try {
    const row = await addNumber(knex, { tenantId: tenant_id, whatsappNumber, phoneNumberId, label });
    return res.status(201).json({ success: true, number: row });
  } catch (error) {
    if (error instanceof WhatsappNumberLimitError) {
      return res.status(403).json({ error: { code: 'PLAN_LIMIT', message: error.message } });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.message } });
    }
    if (error.code === '23505') { // unique_violation — number already registered (to this or another tenant)
      return res.status(409).json({ error: { code: 'DUPLICATE_ENTRY', message: 'This WhatsApp number is already registered.' } });
    }
    console.error('Failed to add WhatsApp number:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to add WhatsApp number.' } });
  }
}

async function deleteWhatsappNumber(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;
  const { id } = req.params;

  if (role !== 'owner') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only tenant owners can manage WhatsApp numbers.' } });
  }

  try {
    await removeNumber(knex, { tenantId: tenant_id, numberId: id });
    return res.json({ success: true });
  } catch (error) {
    if (error.name === 'NotFoundError') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: error.message } });
    }
    console.error('Failed to remove WhatsApp number:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to remove WhatsApp number.' } });
  }
}

async function patchWhatsappNumberDefault(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { tenant_id, role } = req.user;
  const { id } = req.params;

  if (role !== 'owner') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only tenant owners can manage WhatsApp numbers.' } });
  }

  try {
    const row = await setDefault(knex, { tenantId: tenant_id, numberId: id });
    return res.json({ success: true, number: row });
  } catch (error) {
    if (error.name === 'NotFoundError') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: error.message } });
    }
    console.error('Failed to set default WhatsApp number:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to set default WhatsApp number.' } });
  }
}

module.exports = { getWhatsappNumbers, postWhatsappNumber, deleteWhatsappNumber, patchWhatsappNumberDefault };
