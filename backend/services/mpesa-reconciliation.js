const MAX_MESSAGE_AGE_MS = Number(process.env.MPESA_MAX_MESSAGE_AGE_MS || 24 * 60 * 60 * 1000);
const MAX_TIME_DIFFERENCE_MS = Number(process.env.MPESA_MESSAGE_TIME_TOLERANCE_MS || 2 * 60 * 1000);
const MIN_CONTENT_SIMILARITY = Number(process.env.MPESA_MESSAGE_SIMILARITY || 0.9);

function normaliseText(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function normaliseRecipient(value) {
  return normaliseText(value).replace(/\s+FOR\s+ACCOUNT.*$/, '').trim();
}

function tokenSimilarity(left, right) {
  const leftTokens = new Set(normaliseText(left).split(' ').filter(Boolean));
  const rightTokens = new Set(normaliseText(right).split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let common = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) common += 1;
  return common / Math.max(leftTokens.size, rightTokens.size);
}

function verifyMessagePair({ pastedMessage, receivedMessage, parseMpesaMessage, expectedAmount, expectedRecipient }) {
  const pasted = parseMpesaMessage(pastedMessage);
  const received = parseMpesaMessage(receivedMessage);
  if (!pasted.success || !received.success) return { valid: false, reason: 'Both payment messages must be valid M-PESA confirmations.' };
  if (String(pasted.mpesaCode).toUpperCase() !== String(received.mpesaCode).toUpperCase()) return { valid: false, reason: 'The M-PESA codes do not match.' };
  if (Math.abs(Number(pasted.amount) - Number(received.amount)) > 0.01) return { valid: false, reason: 'The M-PESA amounts do not match.' };
  if (Math.abs(Number(pasted.amount) - Number(expectedAmount)) > 0.01) return { valid: false, reason: 'The M-PESA amount does not match this Task AI level.' };
  return { valid: true, parsed: pasted, similarity: 1.0 };
}

module.exports = { normaliseRecipient, verifyMessagePair };
