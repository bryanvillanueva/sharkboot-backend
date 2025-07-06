const express = require('express');
const db = require('../db');
const { sign } = require('../helpers/jwt');

const router = express.Router();

router.post('/facebook', async (req, res) => {
  const { facebookId, name } = req.body;
  if (!facebookId) return res.status(400).json({ error: 'facebookId required' });

  // 1. comprobar si existe user
  const [users] = await db.execute(
    'SELECT id, client_id FROM users WHERE provider="FACEBOOK" AND provider_id=?',
    [facebookId]
  );

  let userId, clientId;
  if (users.length) {
    ({ id: userId, client_id: clientId } = users[0]);
  } else {
    // crear client + user
    const [clientRes] = await db.execute(
      'INSERT INTO clients (id, name) VALUES (UUID(), ?)',
      [`Cliente ${name}`]
    );
    clientId = clientRes.insertId;

    const [userRes] = await db.execute(
      `INSERT INTO users (id, client_id, provider, provider_id, name)
       VALUES (UUID(), ?, "FACEBOOK", ?, ?)`,
      [clientId, facebookId, name]
    );
    userId = userRes.insertId;
  }

  const token = sign({ userId, clientId, name });
  res.json({ token });
});

router.get('/me', require('../middlewares/authGuard'), async (req, res) => {
  const { userId } = req.auth;
  const [rows] = await db.execute(
    'SELECT name, email, role FROM users WHERE id=?',
    [userId]
  );
  res.json(rows[0]);
});

module.exports = router;
