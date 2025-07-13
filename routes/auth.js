const express   = require('express');
const passport  = require('passport');
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db        = require('../db');
const { sign, verify } = require('../helpers/jwt');

const router = express.Router();

/*---------------------------------------------------------------
  1) REGISTRO POR E-MAIL
  -------------------------------------------------------------*/
router.post('/register', async (req, res) => {
  const {
    name, email, password, company,
    phone, dob, country, city, role
  } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña requeridos' });

  /* 1) e-mail único */
  const [[dup]] = await db.execute(
    'SELECT 1 FROM user_providers WHERE provider="EMAIL" AND provider_id=?',
    [email]
  );
  if (dup) return res.status(409).json({ error: 'Email ya registrado' });

  /* 2) genera UUIDs en código */
  const clientId = uuidv4();
  const userId   = uuidv4();
  const providerId = uuidv4();

  /* 3) insertar client */
  await db.execute(
    'INSERT INTO clients (id, name) VALUES (?, ?)',
    [clientId, company || `Cliente de ${name || email}`]
  );

  /* 4) insertar user con todos los campos */
  await db.execute(
    `INSERT INTO users
       (id, client_id, name, email, phone, dob, country, city, role)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      clientId,
      name || email,
      email,
      phone || null,
      dob   || null,
      country || null,
      city || null,
      role || null,
    ]
  );

  /* 5) proveedor EMAIL */
  await db.execute(
    `INSERT INTO user_providers
       (id, user_id, provider, provider_id, password_hash)
     VALUES (?, ?, 'EMAIL', ?, ?)`,
    [
      providerId,
      userId,
      email,
      bcrypt.hashSync(password, 12),
    ]
  );

  /* 6) token JWT */
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
  'http://localhost:3000',
  'https://boot.sharkagency.co'
];

/*---------------------------------------------------------------
  3) FACEBOOK AUTH START - Nuevo endpoint siguiendo el patrón de referencia
  -------------------------------------------------------------*/
router.get('/facebook/start', (req, res) => {
  console.log('🚀 Iniciando proceso de autenticación con Facebook...');
  
  if (!process.env.FACEBOOK_APP_ID) {
    console.error('❌ FACEBOOK_APP_ID no está configurado');
    return res.redirect('https://boot.sharkagency.co/login?error=facebook_not_configured');
  }

  // Obtener la URL del frontend desde el query parameter
  const frontendUrl = req.query.frontend_url || 'https://boot.sharkagency.co';
  console.log('📍 Frontend URL recibida:', frontendUrl);

  // Construir estado con información del frontend
  const state = Buffer.from(JSON.stringify({
    timestamp: Date.now(),
    source: 'sharkboot_login',
    frontend_url: frontendUrl
  })).toString('base64');

  // Permisos requeridos de Facebook
  const scopes = [
    'email',
    'public_profile'
  ].join(',');

  const redirectUri = 'https://sharkboot-backend-production.up.railway.app/auth/facebook/callback';

  // Construir URL de autorización de Facebook
  const facebookAuthUrl = 'https://www.facebook.com/v23.0/dialog/oauth' +
    `?client_id=${process.env.FACEBOOK_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&state=${state}` +
    `&response_type=code`;

  console.log('✅ Redirigiendo a Facebook para autorización...');
  
  // Redirigir directamente a Facebook
  res.redirect(facebookAuthUrl);
});

/*---------------------------------------------------------------
   4) CALLBACK Facebook - Nuevo endpoint manual
  -------------------------------------------------------------*/
router.get('/facebook/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    if (!code) {
      console.error('❌ No se recibió código de autorización');
      return res.redirect('https://boot.sharkagency.co/login?error=no_code');
    }

    // Decodificar y verificar estado
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    } catch (e) {
      console.error('❌ Error decodificando state:', e);
      return res.redirect('https://boot.sharkagency.co/login?error=invalid_state');
    }

    // Verificar que el estado sea válido (no mayor a 1 hora)
    if (!stateData || !stateData.timestamp || Date.now() - stateData.timestamp > 3600000) {
      const frontendUrl = stateData?.frontend_url || 'https://boot.sharkagency.co';
      return res.redirect(`${frontendUrl}/login?error=expired_state`);
    }

    // Intercambiar el código por un token de acceso
    const axios = require('axios');
    const tokenResponse = await axios.get('https://graph.facebook.com/v23.0/oauth/access_token', {
      params: {
        client_id: process.env.FACEBOOK_APP_ID,
        redirect_uri: 'https://sharkboot-backend-production.up.railway.app/auth/facebook/callback',
        client_secret: process.env.FACEBOOK_APP_SECRET,
        code
      }
    });

    const { access_token } = tokenResponse.data;

    // Obtener información del perfil
    const profileResponse = await axios.get('https://graph.facebook.com/me', {
      params: {
        fields: 'id,name,email',
        access_token
      }
    });

    const facebookProfile = profileResponse.data;
    const { id: facebookId, name, email } = facebookProfile;

    console.log('📱 Perfil de Facebook obtenido:', { facebookId, name, email });

    let userId, clientId, userName;

    // Verificar si ya existe un usuario con este Facebook ID
    const [[existingUser]] = await db.execute(
      `SELECT up.user_id, u.client_id, u.name
         FROM user_providers up
         JOIN users u ON u.id = up.user_id
        WHERE up.provider='FACEBOOK' AND up.provider_id=?`,
      [facebookId]
    );

    if (existingUser) {
      // Usuario existente - login
      console.log('👤 Usuario existente encontrado');
      userId = existingUser.user_id;
      clientId = existingUser.client_id;
      userName = existingUser.name;
    } else {
      // Nuevo usuario - registro automático
      console.log('🆕 Creando nuevo usuario');
      
      const newClientId = uuidv4();
      const newUserId = uuidv4();
      const newProviderId = uuidv4();

      // Crear client
      await db.execute(
        'INSERT INTO clients (id, name) VALUES (?, ?)',
        [newClientId, `Cliente de ${name}`]
      );

      // Crear user
      await db.execute(
        `INSERT INTO users (id, client_id, name, email) VALUES (?, ?, ?, ?)`,
        [newUserId, newClientId, name, email]
      );

      // Crear provider
      await db.execute(
        `INSERT INTO user_providers (id, user_id, provider, provider_id, access_token)
         VALUES (?, ?, 'FACEBOOK', ?, ?)`,
        [newProviderId, newUserId, facebookId, access_token]
      );

      userId = newUserId;
      clientId = newClientId;
      userName = name;
    }

    // Generar JWT
    const token = sign({ userId, clientId, name: userName });

    // Usar la URL del frontend del estado
    const frontendUrl = stateData.frontend_url || 'https://boot.sharkagency.co';

    // Construir URL de redirección con datos
    const redirectUrl = new URL(frontendUrl + '/login');
    redirectUrl.searchParams.set('fb_token', access_token);
    redirectUrl.searchParams.set('fb_id', facebookId);
    redirectUrl.searchParams.set('name', userName);
    redirectUrl.searchParams.set('email', email || '');
    redirectUrl.searchParams.set('auth_token', token);

    console.log('🔄 Redirigiendo a:', redirectUrl.toString());
    return res.redirect(redirectUrl.toString());

  } catch (error) {
    console.error('❌ Error en callback de Facebook:', error.response?.data || error.message);
    return res.redirect('https://boot.sharkagency.co/login?error=facebook_auth_failed');
  }
});

/*---------------------------------------------------------------
  5) LOGIN con FACEBOOK usando Passport (mantener para compatibilidad)
  -------------------------------------------------------------*/
router.get('/facebook', (req, res, next) => {
  const redirect = req.query.redirect;
  if (redirect && !ALLOWED_REDIRECTS.includes(redirect)) {
    return res.status(400).send('Redirect no permitido');
  }

  // Pasamos la URL en el parámetro `state`
  const stateData = redirect ? Buffer.from(redirect).toString('base64') : '';
  
  passport.authenticate('facebook', {
    scope: ['email'],
    state: stateData,
  })(req, res, next);
});

/*---------------------------------------------------------------
   6) CALLBACK Facebook usando Passport (mantener para compatibilidad)
  -------------------------------------------------------------*/
router.get(
  '/facebook/callback-passport',
  passport.authenticate('facebook', { session: false, failureRedirect: '/login' }),
  async (req, res) => {
    const { facebookId, displayName, email, linkToUserId, accessToken } = req.user;

    let userId, clientId, name;

    if (linkToUserId) {
      // Vincular a cuenta existente
      userId = linkToUserId;

      await db.execute(
        `INSERT IGNORE INTO user_providers (id,user_id,provider,provider_id,access_token)
         VALUES (UUID(),?,'FACEBOOK',?,?)`,
        [userId, facebookId, accessToken]
      );

      const [[u]] = await db.execute('SELECT client_id,name FROM users WHERE id=?', [userId]);
      clientId = u.client_id;
      name = u.name;
    } else {
      // Login normal con Facebook
      const [[row]] = await db.execute(
        `SELECT up.user_id, u.client_id, u.name
           FROM user_providers up
           JOIN users u ON u.id=up.user_id
          WHERE up.provider='FACEBOOK' AND up.provider_id=?`,
        [facebookId]
      );

      if (row) {
        // Usuario existente
        userId = row.user_id;
        clientId = row.client_id;
        name = row.name;
      } else {
        // Crear nuevo usuario
        const newClientId = uuidv4();
        const newUserId = uuidv4();
        const newProviderId = uuidv4();

        await db.execute(
          'INSERT INTO clients (id,name) VALUES (?,?)',
          [newClientId, `Cliente ${displayName}`]
        );

        await db.execute(
          'INSERT INTO users (id,client_id,name,email) VALUES (?,?,?,?)',
          [newUserId, newClientId, displayName, email]
        );

        await db.execute(
          `INSERT INTO user_providers (id,user_id,provider,provider_id,access_token)
           VALUES (?,?,'FACEBOOK',?,?)`,
          [newProviderId, newUserId, facebookId, accessToken]
        );

        userId = newUserId;
        clientId = newClientId;
        name = displayName;
      }
    }

    const token = sign({ userId, clientId, name });

    // Recupera y decodifica la URL de retorno
    let redirectUrl = 'https://boot.sharkagency.co';
    if (req.query.state) {
      try {
        redirectUrl = Buffer.from(req.query.state, 'base64').toString('utf8');
      } catch (e) {
        console.error('Error decodificando redirect URL:', e);
      }
    }
    
    // Validar que esté en la lista blanca
    if (!ALLOWED_REDIRECTS.includes(redirectUrl)) {
      redirectUrl = 'https://boot.sharkagency.co';
    }

    res.redirect(`${redirectUrl}/login?token=${token}`);
  }
);

/*---------------------------------------------------------------
  7) VERIFICAR TOKEN FACEBOOK
  -------------------------------------------------------------*/
router.get('/facebook/verify', async (req, res) => {
  const { fb_token } = req.query;
  
  if (!fb_token) {
    return res.status(400).json({ error: 'Token requerido' });
  }

  try {
    const axios = require('axios');
    // Verificar que el token siga siendo válido
    const verifyRes = await axios.get('https://graph.facebook.com/v23.0/me', {
      params: {
        access_token: fb_token,
        fields: 'id,name,email'
      }
    });
    
    res.json({ 
      valid: true, 
      user: verifyRes.data,
      message: 'Token válido'
    });
  } catch (error) {
    res.status(401).json({ 
      valid: false, 
      error: 'Token inválido o expirado' 
    });
  }
});

/*---------------------------------------------------------------
  8) INICIAR proceso de vínculo Facebook desde el frontend
     (requiere JWT en Authorization)
  -------------------------------------------------------------*/
const authGuard = require('../middlewares/authGuard');

router.get(
  '/link/facebook',
  authGuard,
  (req, res, next) => {
    const { userId } = req.auth;
    const stateData = Buffer.from(JSON.stringify({
      linkToUserId: userId,
      timestamp: Date.now()
    })).toString('base64');
    
    passport.authenticate('facebook', {
      scope: ['email'],
      state: stateData,
    })(req, res, next);
  }
);

module.exports = router;