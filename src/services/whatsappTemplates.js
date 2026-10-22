// src/services/whatsappTemplates.js
//
// Every WhatsApp template Plotraa sends, in one place: its name (env
// override), language, how many body variables Meta's approved text has, and
// the exact text to submit for approval (docs/WHATSAPP_TEMPLATES.md is
// generated from this). A template with the wrong number of variables is
// rejected by Meta, so the count is checked in code before sending
// (assertParamCount) and in test/whatsappTemplates.test.js.
//
// Why templates: free text only reaches a number that messaged us in the last
// 24 hours. Dealer welcome, sub-dealer invite, password reset, trial
// reminders and lead alerts go to people who usually have NOT messaged
// recently, so they must be templates. The worker sends free text instead
// when the 24h window is open (templateMode 'auto').

const DEFAULT_LANG = process.env.WA_TPL_LANG || 'en';

// key -> definition. `params` names the {{n}} variables in order.
const PLOTRAA_TEMPLATES = {
  dealer_welcome: {
    env: 'WA_TPL_DEALER_WELCOME',
    defaultName: 'plotraa_dealer_welcome',
    category: 'UTILITY',
    params: ['name', 'trial_end_date', 'login_id', 'set_password_link'],
    body: 'Welcome to Plotraa, {{1}}! Your dealer account is approved and your free trial runs till {{2}}. Login ID: {{3}}. Set your password here (one-time link, valid 7 days): {{4}}. Then send your first property details on this chat.',
  },
  subdealer_invite: {
    env: 'WA_TPL_SUBDEALER_INVITE',
    defaultName: 'plotraa_subdealer_invite',
    category: 'UTILITY',
    params: ['name', 'dealer_name', 'login_id', 'set_password_link'],
    body: 'Hello {{1}}, {{2}} has added you as a sub-dealer on Plotraa. Login ID: {{3}}. Set your password here (one-time link, valid 7 days): {{4}}. You can send property details on this chat to create listings.',
  },
  password_reset: {
    env: 'WA_TPL_PASSWORD_RESET',
    defaultName: 'plotraa_password_reset',
    category: 'AUTHENTICATION_OR_UTILITY',
    params: ['reset_link', 'valid_minutes'],
    body: 'Your Plotraa password reset link: {{1}} . It is valid for {{2}} minutes. If you did not ask for it, ignore this message.',
  },
  trial_reminder: {
    env: 'WA_TPL_TRIAL_REMINDER',
    defaultName: 'plotraa_trial_reminder',
    category: 'UTILITY',
    params: ['name', 'time_left', 'trial_end_date', 'pay_link_or_hint'],
    body: 'Hello {{1}}, your Plotraa free trial ends in {{2}} (on {{3}}). To keep adding listings, choose a plan and pay: {{4}}',
  },
  trial_expired: {
    env: 'WA_TPL_TRIAL_EXPIRED',
    defaultName: 'plotraa_trial_expired',
    category: 'UTILITY',
    params: ['name', 'trial_end_date', 'pay_link_or_hint'],
    body: 'Hello {{1}}, your Plotraa free trial ended on {{2}}. New listings are paused until you pay; your existing listings stay live. Pay here: {{3}}',
  },
  payment_received: {
    env: 'WA_TPL_PAYMENT_RECEIVED',
    defaultName: 'plotraa_payment_received',
    category: 'UTILITY',
    params: ['name', 'plan_label'],
    body: 'Hello {{1}}, we received your Plotraa payment for the {{2}} plan. Thank you! Your plan is active and new listings and leads are switched on.',
  },
  lead_assigned: {
    env: 'WA_TPL_LEAD_ASSIGNED',
    defaultName: 'plotraa_lead_assigned',
    category: 'UTILITY',
    params: ['dealer_name', 'lead_name', 'lead_phone', 'lead_details'],
    body: 'Hello {{1}}, new Plotraa lead: {{2}} ({{3}}). Details: {{4}}. Please contact them soon. It is also in the Leads section of your panel.',
  },
};

// Templates that already existed before this registry. Their approved
// variable counts were read from the code that fills them:
//   support_alert    supportRequestService.js  -> supportAlertParams(): 3
//   call_enquiry     callEnquiryService.js     -> buildTemplateJob(): 3 body + 1 quick-reply button
//   reengagement     whatsappOutboundWorker.js -> 1 body variable
// Compare these with what is approved in Meta Business Manager.
const EXISTING_TEMPLATES = {
  support_alert: { env: 'SUPPORT_ALERT_TEMPLATE_NAME', bodyParams: 3, buttons: 0, source: 'src/services/supportRequestService.js (supportAlertParams)' },
  call_enquiry: { env: 'WHATSAPP_CALL_ENQUIRY_TEMPLATE_NAME', bodyParams: 3, buttons: 1, source: 'src/services/callEnquiryService.js (buildTemplateJob)' },
  reengagement: { env: 'WHATSAPP_REENGAGEMENT_TEMPLATE_NAME', bodyParams: 1, buttons: 0, source: 'src/workers/whatsappOutboundWorker.js (window-closed branch)' },
};

/** WhatsApp rejects variables with newlines, tabs, >4 spaces, or empty text. */
function sanitizeParam(value, fallback = '-') {
  const text = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return (text || fallback).slice(0, 1000);
}

function templateName(key) {
  const def = PLOTRAA_TEMPLATES[key];
  if (!def) throw new Error(`whatsappTemplates: unknown template "${key}"`);
  return (process.env[def.env] || def.defaultName).trim();
}

function assertParamCount(key, params) {
  const def = PLOTRAA_TEMPLATES[key];
  if (!def) throw new Error(`whatsappTemplates: unknown template "${key}"`);
  if (!Array.isArray(params) || params.length !== def.params.length) {
    throw new Error(`Template "${key}" needs ${def.params.length} variables (${def.params.join(', ')}) but got ${Array.isArray(params) ? params.length : 0}.`);
  }
}

/**
 * Builds the `template` object for enqueueAgentWhatsappSend. `values` is an
 * object keyed by the variable names in PLOTRAA_TEMPLATES[key].params.
 * templateMode 'auto' = the worker uses free text while the person's 24h
 * window is open and the template otherwise.
 */
function buildTemplate(key, values = {}) {
  const def = PLOTRAA_TEMPLATES[key];
  if (!def) throw new Error(`whatsappTemplates: unknown template "${key}"`);
  const bodyParams = def.params.map((p) => sanitizeParam(values[p]));
  assertParamCount(key, bodyParams);
  return {
    key,
    name: templateName(key),
    lang: process.env[`${def.env}_LANG`] || DEFAULT_LANG,
    bodyParams,
    expectedParams: def.params.length,
    templateMode: 'auto',
  };
}

module.exports = {
  PLOTRAA_TEMPLATES,
  EXISTING_TEMPLATES,
  sanitizeParam,
  templateName,
  assertParamCount,
  buildTemplate,
};
