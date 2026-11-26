module.exports = function createInboundSmsMessageModel(pool) {
  return {
    record: async (message) => {
      // A duplicate delivery is normal for phone-forwarding apps. Store the
      // first copy only, then make the endpoint safely idempotent.
      const existing = await pool.query(
        'SELECT id FROM inbound_sms_messages WHERE external_id = $1 LIMIT 1',
        [message.externalId]
      );
      if (existing.rows.length) return null;
      try {
        const result = await pool.query(
          `INSERT INTO inbound_sms_messages
             (external_id, sms_body, sender_phone, received_at, mpesa_code, parsed_amount, raw_event)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [message.externalId, message.body, message.sender, message.receivedAt,
            message.mpesaCode, message.parsedAmount, JSON.stringify(message.rawEvent)]
        );
        return result.rows[0] || null;
      } catch (error) {
        if (error.code === '23505' || error.code === 'ER_DUP_ENTRY') return null;
        throw error;
      }
    },
    findUnmatchedByCode: async (mpesaCode, amount) => {
      const result = await pool.query(
        `SELECT id, sms_body, sender_phone, received_at, mpesa_code, parsed_amount
           FROM inbound_sms_messages
          WHERE mpesa_code = $1 AND parsed_amount BETWEEN $2 - 1 AND $2 + 1
            AND verification_status = 'unmatched'
          ORDER BY received_at DESC LIMIT 1`,
        [mpesaCode, amount]
      );
      return result.rows[0] || null;
    },
    markStatus: (id, status, transactionId = null) => pool.query(
      `UPDATE inbound_sms_messages
          SET verification_status = $1, matched_transaction_id = COALESCE($2, matched_transaction_id)
        WHERE id = $3`,
      [status, transactionId, id]
    ),
    markMatched: (id, transactionId) => pool.query(
      `UPDATE inbound_sms_messages
          SET verification_status = 'matched', matched_transaction_id = $1
        WHERE id = $2`,
      [transactionId, id]
    )
  };
};
