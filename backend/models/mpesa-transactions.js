module.exports = function createMpesaTransactionModel(pool) {
  return {
    findForSms: async (mpesaCode) => {
      const result = await pool.query(
        `SELECT id, user_id, task_ai_number, ai_task, amount, status, recipient_name, transaction_time, submitted_message
         FROM mpesa_transactions
         WHERE mpesa_code = $1 AND status IN ('awaiting_sms', 'completed')
         ORDER BY created_at DESC LIMIT 1`,
        [mpesaCode]
      );
      return result.rows[0] || null;
    },
    createPurchase: (data, db = pool) => db.query(
      `INSERT INTO mpesa_transactions
       (user_id, user_phone, amount, mpesa_code, recipient_name, transaction_time,
        ai_task, task_ai_number, deposit_number, status, submitted_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [data.userId, data.phone, data.amount, data.mpesaCode, data.recipientName,
        data.transactionTime, data.aiTask, data.taskAiNumber, data.depositNumber,
        data.status, data.submittedMessage]
    ),
    markVerified: (id, smsMessageId) => pool.query(
      `UPDATE mpesa_transactions
       SET status = 'completed', verified_by_sms_forwarder = true, sms_forwarder_message_id = $1,
           unlock_completed = true
       WHERE id = $2`,
      [smsMessageId, id]
    )
  };
};
