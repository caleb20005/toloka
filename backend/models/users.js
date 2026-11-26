/**
 * User model. These methods intentionally return the same database rows used
 * by the existing routes; introducing models must not change API contracts.
 */
module.exports = function createUserModel(pool) {
  return {
    findById: async (id) => {
      const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
      return result.rows[0] || null;
    },
    findByPhoneOrReferralCode: async (value) => {
      const result = await pool.query('SELECT * FROM users WHERE phone = $1 OR referralCode = $1', [value]);
      return result.rows[0] || null;
    },
    updateLastLogin: (id) => pool.query('UPDATE users SET lastLogin = CURRENT_TIMESTAMP WHERE id = $1', [id]),
    updateTotalEarned: (id, amount) => pool.query('UPDATE users SET totalEarned = totalEarned + $1 WHERE id = $2', [amount, id])
  };
};
