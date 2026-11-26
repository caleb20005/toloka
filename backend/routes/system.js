const express = require('express');

function getEATTime() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 3 * 60 * 60000);
}

module.exports = function createSystemRouter({ pool } = {}) {
  const router = express.Router();
  router.get('/health', (req, res) => res.json({ status: 'online', service: 'toloka-api', message: 'Server is running', timezone: 'EAT (UTC+3)', currentTime: getEATTime().toISOString() }));
  router.get(['/ready', '/system/ready'], async (req, res) => {
    try {
      if (pool) await pool.query('SELECT 1');
      res.json({ status: 'ready', service: 'toloka-api', database: pool?.databaseClient || 'postgres' });
    } catch (error) {
      res.status(503).json({ status: 'not_ready', service: 'toloka-api', database: pool?.databaseClient || 'postgres' });
    }
  });
  router.get('/server-time', (req, res) => res.json({ serverTime: getEATTime().toISOString(), timezone: 'EAT' }));
  return router;
};
