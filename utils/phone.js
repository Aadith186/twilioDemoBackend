const { Lead } = require('../models');

/** Twilio From vs stored Lead.phone often differ (+1… vs digits) — try variants so lookups match. */
function callerPhoneVariants(callerPhone) {
  if (!callerPhone || callerPhone === 'unknown') return [];
  const raw = String(callerPhone).trim();
  const variants = new Set([raw]);
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    variants.add(last10);
    variants.add(`+1${last10}`);
    variants.add(`1${last10}`);
    variants.add(`+${digits}`);
  }
  return [...variants];
}

function isPhoneInputValid(input) {
  const digits = String(input || '').replace(/\D/g, '');
  return digits.length >= 10;
}

/** Normalize user or Twilio input to a stable stored string (E.164-style when possible). */
function normalizePhoneForLead(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return raw;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

async function findLeadByCallerPhone(callerPhone) {
  const variants = callerPhoneVariants(callerPhone);
  if (variants.length === 0) return null;
  return Lead.findOne({ phone: { $in: variants } });
}

function leadNeedsPhone(lead) {
  return !lead?.phone || !String(lead.phone).trim();
}

module.exports = {
  callerPhoneVariants,
  findLeadByCallerPhone,
  normalizePhoneForLead,
  isPhoneInputValid,
  leadNeedsPhone,
};
