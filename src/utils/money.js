// src/utils/money.js
//
// Indian-style short rupee text for WhatsApp replies (23 Oct): buyers and
// dealers read "₹50 lakh" / "₹2.7 crore", not "₹50,00,000".

function trimDecimals(n, max = 2) {
  return Number(n.toFixed(max)).toString();
}

/** 5000000 -> "₹50 lakh", 27000000 -> "₹2.7 crore", 85000 -> "₹85,000". null -> null. */
function formatInrShort(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e7) return `₹${trimDecimals(n / 1e7)} crore`;
  if (n >= 1e5) return `₹${trimDecimals(n / 1e5)} lakh`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

module.exports = { formatInrShort };
