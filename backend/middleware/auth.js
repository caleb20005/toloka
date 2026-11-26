const crypto = require('crypto');

const configuredSecret = process.env.AUTH_SECRET;
if (process.env.NODE_ENV === 'production' && !configuredSecret) {
  throw new Error('AUTH_SECRET must be configured in production.');
}

// Development gets an ephemeral secret rather than a predictable hard-coded
// token key. Production must provide AUTH_SECRET through its environment.
const AUTH_SECRET = configuredSecret || crypto.randomBytes(48).toString('hex');
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createToken(userId) {
  const payload = String(userId);
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(`${payload}.${expiresAt}`).digest('hex');
  return `${payload}.${signature}.${expiresAt}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, signature, expiresAt] = token.split('.');
  if (!payload || !signature || !expiresAt || !/^\d+$/.test(payload) || !/^\d+$/.test(expiresAt)) return null;
  if (Date.now() > Number(expiresAt)) return null;
  const expectedSignature = crypto.createHmac('sha256', AUTH_SECRET).update(`${payload}.${expiresAt}`).digest('hex');
  const provided = Buffer.from(signature, 'hex');
  const expected = Buffer.from(expectedSignature, 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  return payload;
}

function parseCookies(req) {
  return (req.headers.cookie || '').split(';').reduce((cookies, item) => {
    const index = item.indexOf('=');
    if (index > -1) cookies[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
    return cookies;
  }, {});
}

function getRequestToken(req) {
  const authorization = req.get('authorization') || '';
  if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();
  return req.get('x-auth-token') || parseCookies(req).authToken || null;
}

function setAuthCookie(res, token) {
  res.cookie('authToken', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: TOKEN_TTL_MS
  });
}

function requireAuth(req, res, next) {
  const userId = verifyToken(getRequestToken(req));
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
  req.authUserId = userId;
  const pathUserMatch = req.path.match(/^\/(\d+)(?:\/|$)/);
  const requestedUserId = req.body?.userId || req.params?.userId || (pathUserMatch ? pathUserMatch[1] : null);
  if (requestedUserId && String(requestedUserId) !== String(userId)) return res.status(403).json({ success: false, message: 'Forbidden' });
  next();
}

function requireLocalControlTower(req, res, next) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoopback) return res.status(403).json({ success: false, message: 'Control Tower is available only on this computer.' });
  next();
}

function normalisePhone(phone) {
  return String(phone || '').replace(/\D/g, '').replace(/^0(?=\d{9}$)/, '254');
}

// A local development machine can use the legacy operator flow when no admin
// list is configured. Once CONTROL_TOWER_ADMIN_PHONES is set (as it must be
// in production), every request—including a reverse proxy's loopback hop—must
// belong to one of those operator accounts.
function createRequireControlTowerAccess(pool) {
  const allowedPhones = new Set(
    String(process.env.CONTROL_TOWER_ADMIN_PHONES || '')
      .split(',')
      .map(normalisePhone)
      .filter(Boolean)
  );
  return async (req, res, next) => {
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (isLoopback && !allowedPhones.size) return next();

    const userId = verifyToken(getRequestToken(req));
    if (!userId) return res.status(401).json({ success: false, message: 'Control Tower sign-in required.' });
    if (!allowedPhones.size) return res.status(403).json({ success: false, message: 'Remote Control Tower access has not been configured.' });
    try {
      const user = await pool.query('SELECT phone FROM users WHERE id = $1', [userId]);
      if (!user.rows.length || !allowedPhones.has(normalisePhone(user.rows[0].phone))) {
        return res.status(403).json({ success: false, message: 'This account is not a Control Tower administrator.' });
      }
      req.authUserId = userId;
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { AUTH_SECRET, createToken, verifyToken, getRequestToken, setAuthCookie, requireAuth, requireLocalControlTower, createRequireControlTowerAccess };
