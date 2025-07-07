const express   = require('express');
const passport  = require('passport');
const bcrypt    = require('bcryptjs');
const db        = require('../db');
const { sign, verify } = require('../helpers/jwt');

const router = express.Router();

/*---------------------------------------------------------------
  1) REGISTRO POR E-MAIL
  -------------------------------------------------------------*/
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  // ¿ya existe proveedor EMAIL?
  const [[dup]] = await db.execute(
    'SELECT 1 FROM user_providers WHERE provider="EMAIL" AND provider_id=?',
    [email]
  );
  if (dup) return res.status(409).json({ error: 'Email ya registrado' });

  /* create client & user */
  const [cRes] = await db.execute(
    'INSERT INTO clients (id,name) VALUES (UUID(),?)',
    [`Cliente de ${name || email}`]
  );
  const clientId = cRes.insertId;

  const [uRes] = await db.execute(
    'INSERT INTO users (id,client_id,name,email) VALUES (UUID(),?,?,?)',
    [clientId, name || email, email]
  );
  const userId = uRes.insertId;

  /* save provider */
  await db.execute(
    `INSERT INTO user_providers (id,user_id,provider,provider_id,password_hash)
     VALUES (UUID(),?,'EMAIL',?,?)`,
    [userId, email, bcrypt.hashSync(password, 12)]
  );

  const token = sign({ userId, clientId, name: name || email });
  res.json({ token });
});

/*---------------------------------------------------------------
  2) LOGIN POR E-MAIL
  -------------------------------------------------------------*/
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const [[prov]] = await db.execute(
    `SELECT up.user_id, up.password_hash, u.client_id, u.name
       FROM user_providers up
       JOIN users u ON u.id = up.user_id
      WHERE up.provider='EMAIL' AND up.provider_id=?`,
    [email]
  );
  if (!prov || !bcrypt.compareSync(password, prov.password_hash))
    return res.status(401).json({ error: 'Credenciales inválidas' });

  const token = sign({ userId: prov.user_id, clientId: prov.client_id, name: prov.name });
  res.json({ token });
});

// Lista blanca de front-ends permitidos
const ALLOWED_REDIRECTS = [
  'https://crm.sharkagency.co',
  'http://localhost:5173',
  'https://boot.sharkagency.co'
];

/*---------------------------------------------------------------
  3) LOGIN con FACEBOOK  (OAuth inicio)
  -------------------------------------------------------------*/
router.get('/facebook', (req, res, next) => {
  const redirect = req.query.redirect;
  if (!ALLOWED_REDIRECTS.includes(redirect)) return res.status(400).send('Redirect no permitido');

  // Pasamos la URL en el parámetro `state`
  passport.authenticate('facebook', {
    scope: ['email'],
    state: Buffer.from(redirect).toString('base64'),
  })(req, res, next);
});

/*---------------------------------------------------------------
   4) CALLBACK Facebook
      - Si viene un JWT en ?state, lo usamos para VINCULAR.
  -------------------------------------------------------------*/
router.get(
  '/facebook/callback',
  passport.authenticate('facebook', { session: false, failureRedirect: '/login' }),
  async (req, res) => {
    /* passport strategy in app.js pone { facebookId, displayName, email } en req.user */
    const { facebookId, displayName, email, linkToUserId } = req.user; // ver más abajo

    let userId, clientId, name;

    if (linkToUserId) {
      /* ---- 4.a  VINCULAR a cuenta existente ---- */
      userId = linkToUserId;

      await db.execute(
        `INSERT IGNORE INTO user_providers (id,user_id,provider,provider_id)
         VALUES (UUID(),?,'FACEBOOK',?)`,
        [userId, facebookId]
      );

      const [[u]] = await db.execute('SELECT client_id,name FROM users WHERE id=?', [userId]);
      clientId = u.client_id;
      name = u.name;
    } else {
      /* ---- 4.b  LOGIN normal con Facebook ---- */
      const [[row]] = await db.execute(
        `SELECT up.user_id, u.client_id, u.name
           FROM user_providers up
           JOIN users u ON u.id=up.user_id
          WHERE up.provider='FACEBOOK' AND up.provider_id=?`,
        [facebookId]
      );

      if (row) {
        // ya existe
        userId = row.user_id;
        clientId = row.client_id;
        name = row.name;
      } else {
        // crea nuevo client + user
        const [cRes] = await db.execute(
          'INSERT INTO clients (id,name) VALUES (UUID(),?)',
          [`Cliente ${displayName}`]
        );
        clientId = cRes.insertId;

        const [uRes] = await db.execute(
          'INSERT INTO users (id,client_id,name,email) VALUES (UUID(),?,?,?)',
          [clientId, displayName, email]
        );
        userId = uRes.insertId;

        await db.execute(
          `INSERT INTO user_providers (id,user_id,provider,provider_id)
           VALUES (UUID(),?,'FACEBOOK',?)`,
          [userId, facebookId]
        );

        name = displayName;
      }
    }

    const token = sign({ userId, clientId, name });

    // Recupera y decodifica la URL de retorno
    const redirectUrl = Buffer.from(req.query.state, 'base64').toString('utf8');
    // (extra) valida otra vez que esté en la lista blanca
    if (!ALLOWED_REDIRECTS.includes(redirectUrl)) return res.status(400).send('Redirect no permitido');

    res.redirect(`${redirectUrl}/login?token=${token}`);
  }
);

/*---------------------------------------------------------------
  5) INICIAR proceso de vínculo Facebook desde el frontend
     (requiere JWT en Authorization)
  -------------------------------------------------------------*/
const authGuard = require('../middlewares/authGuard');

router.get(
  '/link/facebook',
  authGuard,
  passport.authenticate('facebook', {
    scope: ['email'],
    state: (req) => verify(req.headers.authorization.split(' ')[1]).userId, // pasa userId en state
  })
);

module.exports = router;
