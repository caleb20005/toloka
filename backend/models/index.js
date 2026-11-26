const createUserModel = require('./users');
const createMpesaTransactionModel = require('./mpesa-transactions');
const createInboundSmsMessageModel = require('./inbound-sms-messages');
const createTaskResponseModel = require('./task-responses');
const createReferralModel = require('./referrals');

/** Domain models share the configured pool and are deliberately additive. */
module.exports = function createModels(pool) {
  return {
    users: createUserModel(pool),
    mpesaTransactions: createMpesaTransactionModel(pool),
    inboundSmsMessages: createInboundSmsMessageModel(pool),
    taskResponses: createTaskResponseModel(pool),
    referrals: createReferralModel(pool)
  };
};
