const nodemailer = require('nodemailer');

/**
 * Transactional email service. Every function here is best-effort and
 * never throws — a failed/unconfigured email must never block an API
 * response (onboarding, payment confirmation, etc. all still succeed and
 * return whatever data the caller needs even if the email didn't send).
 *
 * Configure via env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM.
 * Works with any standard SMTP provider (Gmail app password, SendGrid,
 * Postmark, Amazon SES SMTP, etc.) — nothing provider-specific is assumed.
 * Leave SMTP_HOST unset in dev and every function below silently no-ops
 * and logs to console instead, exactly like the existing
 * WHATSAPP_WEBHOOK_SECRET / BSP pattern already in this codebase.
 */

let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

const FROM = process.env.EMAIL_FROM || 'Wayne AI <no-reply@wayneesolutions.com>';
const APP_URL = process.env.PUBLIC_APP_URL || 'http://localhost:3000';

async function send({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[emailService] SMTP not configured — skipped email "${subject}" to ${to}`);
    return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };
  }

  try {
    await t.sendMail({ from: FROM, to, subject, html });
    return { sent: true };
  } catch (error) {
    console.error(`[emailService] Failed to send "${subject}" to ${to}:`, error.message);
    return { sent: false, reason: error.message };
  }
}

/**
 * Sent when a tenant account is created (approved request OR direct admin
 * creation). Carries the temp password — this is the ONLY delivery
 * channel for it besides the API response the admin sees once.
 */
async function sendOnboardingEmail({ to, businessName, contactName, email, tempPassword }) {
  const html = `
    <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <div style="background: #0c1b2e; padding: 24px; border-radius: 12px 12px 0 0;">
        <span style="color: #c8a96e; font-weight: 800; letter-spacing: 1px; font-size: 13px; text-transform: uppercase;">PropertyPro</span>
      </div>
      <div style="border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px; padding: 28px 24px;">
        <h2 style="color: #0c1b2e; margin: 0 0 8px;">Welcome, ${escapeHtml(contactName)} 👋</h2>
        <p style="color: #475569; line-height: 1.6;">
          Your account for <strong>${escapeHtml(businessName)}</strong> is ready on PropertyPro.
        </p>
        <div style="background: #f8fafd; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 18px; margin: 20px 0;">
          <p style="margin: 0 0 6px; font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Login Email</p>
          <p style="margin: 0 0 14px; font-size: 15px; color: #0c1b2e; font-weight: 600;">${escapeHtml(email)}</p>
          <p style="margin: 0 0 6px; font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Temporary Password</p>
          <p style="margin: 0; font-size: 15px; color: #0c1b2e; font-weight: 700; font-family: monospace;">${escapeHtml(tempPassword)}</p>
        </div>
        <a href="${APP_URL}/login" style="display: inline-block; background: linear-gradient(135deg, #0c1b2e, #1a3558); color: #fff; text-decoration: none; padding: 12px 26px; border-radius: 9px; font-weight: 700; font-size: 14px;">
          Log In Now
        </a>
        <p style="color: #94a3b8; font-size: 12px; margin-top: 20px;">
          For security, please change this password after your first login.
        </p>
      </div>
    </div>
  `;

  return send({ to, subject: `Your PropertyPro account is ready — ${businessName}`, html });
}

/**
 * Sent after a successful billing payment (order verified or webhook
 * confirmed). Doubles as a lightweight receipt.
 */
async function sendPaymentReceiptEmail({ to, businessName, plan, amountINR, currentPeriodEnd }) {
  const formattedAmount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amountINR);
  const formattedDate = new Date(currentPeriodEnd).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  const html = `
    <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <div style="background: #0c1b2e; padding: 24px; border-radius: 12px 12px 0 0;">
        <span style="color: #c8a96e; font-weight: 800; letter-spacing: 1px; font-size: 13px; text-transform: uppercase;">PropertyPro</span>
      </div>
      <div style="border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px; padding: 28px 24px;">
        <h2 style="color: #0c1b2e; margin: 0 0 8px;">Payment received ✓</h2>
        <p style="color: #475569; line-height: 1.6;">
          Thanks — we've received your payment for <strong>${escapeHtml(businessName)}</strong>.
        </p>
        <div style="background: #f0fdf4; border: 1px solid #a7f3d0; border-radius: 10px; padding: 16px 18px; margin: 20px 0;">
          <p style="margin: 0 0 4px; font-size: 13px; color: #64748b;">Plan</p>
          <p style="margin: 0 0 12px; font-size: 15px; color: #0c1b2e; font-weight: 700; text-transform: capitalize;">${escapeHtml(plan)}</p>
          <p style="margin: 0 0 4px; font-size: 13px; color: #64748b;">Amount</p>
          <p style="margin: 0 0 12px; font-size: 15px; color: #0c1b2e; font-weight: 700;">${formattedAmount}</p>
          <p style="margin: 0 0 4px; font-size: 13px; color: #64748b;">Valid Until</p>
          <p style="margin: 0; font-size: 15px; color: #0c1b2e; font-weight: 700;">${formattedDate}</p>
        </div>
      </div>
    </div>
  `;

  return send({ to, subject: `Payment received — ${plan} plan renewed`, html });
}

/**
 * Sent when a user requests a password reset. Link contains a single-use,
 * time-limited token — see authController.js forgotPassword/resetPassword.
 */
async function sendPasswordResetEmail({ to, resetUrl }) {
  const html = `
    <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <div style="background: #0c1b2e; padding: 24px; border-radius: 12px 12px 0 0;">
        <span style="color: #c8a96e; font-weight: 800; letter-spacing: 1px; font-size: 13px; text-transform: uppercase;">PropertyPro</span>
      </div>
      <div style="border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px; padding: 28px 24px;">
        <h2 style="color: #0c1b2e; margin: 0 0 8px;">Reset your password</h2>
        <p style="color: #475569; line-height: 1.6;">
          We received a request to reset your PropertyPro password. This link expires in 30 minutes.
        </p>
        <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #0c1b2e, #1a3558); color: #fff; text-decoration: none; padding: 12px 26px; border-radius: 9px; font-weight: 700; font-size: 14px; margin: 12px 0;">
          Reset Password
        </a>
        <p style="color: #94a3b8; font-size: 12px; margin-top: 20px;">
          If you didn't request this, you can safely ignore this email — your password won't be changed.
        </p>
      </div>
    </div>
  `;

  return send({ to, subject: 'Reset your PropertyPro password', html });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { sendOnboardingEmail, sendPaymentReceiptEmail, sendPasswordResetEmail };
