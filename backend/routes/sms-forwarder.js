const crypto = require('crypto');
const express = require('express');
const { verifyMessagePair } = require('../services/mpesa-reconciliation');

function configuredToken(req) {
  const authorization = String(req.get('authorization') || '');
  return authorization.replace(/^Bearer\s+/i, '').trim()
    || String(req.get('x-sms-forwarder-token') || '')
    || String(req.query.token || '');
}

function safeEquals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.trim()) || null;
}

function parseForwardedMessage(body) {
  const data = body || {};
  const timestamp = firstString(data.timestamp, data.date, data.receivedAt, data.received_at, data.time);
  const receivedAt = timestamp && !Number.isNaN(Date.parse(timestamp))
    ? new Date(timestamp)
    : new Date();
  const content = firstString(data.message, data.body, data.content, data.text, data.sms);
  const sender = firstString(data.sender, data.from, data.contact, data.phone);
  const externalId = firstString(data.message_id, data.messageId, data.id)
    || crypto.createHash('sha256').update(`${content || ''}|${sender || ''}|${receivedAt.toISOString()}`).digest('hex');
  return { content, sender, receivedAt, externalId };
}

module.exports = function createSmsForwarderRouter({ models, parseMpesaMessage, onTransactionVerified }) {
  const router = express.Router();
  router.post('/sms-forwarder', async (req, res) => {
    const expectedToken = process.env.SMS_FORWARDER_WEBHOOK_TOKEN;
    if (!expectedToken) return res.status(503).json({ success: false, message: 'SMS Forwarder webhook is not configured.' });
    if (!safeEquals(configuredToken(req), expectedToken)) return res.status(401).json({ success: false, message: 'Invalid webhook token.' });

    const inbound = parseForwardedMessage(req.body);
    if (!inbound.content) return res.status(400).json({ success: false, message: 'The webhook did not contain an SMS message.' });

    const parsed = parseMpesaMessage(inbound.content);
    try {
      const inserted = await models.inboundSmsMessages.record({
        externalId: inbound.externalId, body: inbound.content, sender: inbound.sender,
        receivedAt: inbound.receivedAt, mpesaCode: parsed.success ? parsed.mpesaCode : null,
        parsedAmount: parsed.success ? parsed.amount : null, rawEvent: req.body
      });
      if (!inserted) return res.status(200).json({ success: true, duplicate: true });
      if (!parsed.success) {
        await models.inboundSmsMessages.markStatus(inserted.id, 'not_mpesa');
        return res.status(202).json({ success: true, matched: false, reason: 'not_mpesa' });
      }

      const payment = await models.mpesaTransactions.findForSms(parsed.mpesaCode);
      if (!payment) {
        await models.inboundSmsMessages.markStatus(inserted.id, 'unmatched');
        return res.status(202).json({ success: true, matched: false });
      }

      const verification = verifyMessagePair({
        pastedMessage: payment.submitted_message, receivedMessage: inbound.content,
        parseMpesaMessage, expectedAmount: payment.amount
      });
      if (!verification.valid) {
        await models.inboundSmsMessages.markStatus(inserted.id, 'mismatch');
        return res.status(202).json({ success: true, matched: false, reason: verification.reason });
      }

      await models.mpesaTransactions.markVerified(payment.id, inserted.id);
      await models.inboundSmsMessages.markMatched(inserted.id, payment.id);
      if (payment.status === 'awaiting_sms' && typeof onTransactionVerified === 'function') {
        await onTransactionVerified(payment.user_id, payment.task_ai_number, payment.ai_task);
      }
      return res.status(200).json({ success: true, matched: true, transactionId: payment.id, immediateAccess: true });
    } catch (error) {
      console.error('SMS Forwarder webhook error:', error);
      return res.status(500).json({ success: false, message: 'Unable to process the forwarded SMS.' });
    }
  });
  return router;
};
