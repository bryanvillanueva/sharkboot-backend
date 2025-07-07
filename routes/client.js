const express  = require('express');
const db       = require('../db');
const authGuard = require('../middlewares/authGuard');

const router = express.Router();
router.use(authGuard);

/* 1. Perfil completo del cliente + usuario actual ------------- */
router.get('/profile', async (req, res) => {
  const { clientId, userId } = req.auth;

  /* info del workspace (clients) */
  const [[client]] = await db.execute(
    'SELECT id, name, plan, created_at FROM clients WHERE id=?',
    [clientId]
  );

  /* info del usuario */
  const [[user]] = await db.execute(
    `SELECT name, email, phone, dob, country, city, role
       FROM users
      WHERE id=?`,
    [userId]
  );

  res.json({ client, user });
});

/* 2. Estadísticas del tenant ----------------------------------- */
router.get('/stats', async (req, res) => {
  const { clientId } = req.auth;

  /* nº de asistentes */
  const [[{ assistants }]] = await db.execute(
    'SELECT COUNT(*) AS assistants FROM assistants WHERE client_id=?',
    [clientId]
  );

  /* nº de usuarios (equipo) */
  const [[{ members }]] = await db.execute(
    'SELECT COUNT(*) AS members FROM users WHERE client_id=?',
    [clientId]
  );

  /* consumo de requests y tokens del día actual */
  const [[usage]] = await db.execute(
    `SELECT requests, prompt_tokens, completion_tokens, cost_usd
       FROM usage_daily
      WHERE client_id=? AND date=CURDATE()`,
    [clientId]
  );

  res.json({
    assistants,
    members,
    usage: usage || { requests: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 },
  });
});

module.exports = router; 