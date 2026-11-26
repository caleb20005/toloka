module.exports = function createTaskResponseModel(pool) {
  return {
    findByChallenge: async (challengeHash) => {
      const result = await pool.query('SELECT * FROM task_choice_responses WHERE challenge_hash = $1', [challengeHash]);
      return result.rows[0] || null;
    },
    create: (data) => pool.query(
      `INSERT INTO task_choice_responses
       (challenge_hash, user_id, task_ai_number, question_key, question, response_value, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [data.challengeHash, data.userId, data.taskAiNumber, data.questionKey, data.question,
        data.responseValue, JSON.stringify(data.options || [])]
    )
  };
};
