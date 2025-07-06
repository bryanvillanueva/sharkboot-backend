const { verify } = require('../helpers/jwt');

module.exports = function authGuard(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s/, '');
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    req.auth = verify(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};
