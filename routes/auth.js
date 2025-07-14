const express   = require('express');
const passport  = require('passport');
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios     = require('axios');
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
  3) FACEBOOK AUTH START - Endpoint con TODOS los permisos aprobados
  -------------------------------------------------------------*/
  router.get('/facebook/start', (req, res) => {
    console.log('🚀 Iniciando proceso de autenticación con Facebook...');
    
    if (!process.env.FACEBOOK_APP_ID) {
      console.error('❌ FACEBOOK_APP_ID no está configurado');
      return res.redirect('http://localhost:5173/login?error=facebook_not_configured');
    }
  
    const frontendUrl = req.query.frontend_url || 'http://localhost:5173';
    console.log('📍 Frontend URL recibida:', frontendUrl);
  
    const state = encodeURIComponent(JSON.stringify({
      timestamp: Date.now(),
      source: 'crm_login',
      frontend_url: frontendUrl
    }));
  
    // ✅ USAR EXACTAMENTE LOS MISMOS PERMISOS QUE EL CRM
    const scopes = [
      'instagram_manage_events',
      'page_events',
      'ads_management',
      'ads_read',
      'business_management',
      'catalog_management',
      'commerce_account_manage_orders',
      'commerce_account_read_orders',
      'commerce_account_read_reports',
      'commerce_account_read_settings',
      'instagram_basic',
      'whatsapp_business_messaging',
      'whatsapp_business_management',
      'whatsapp_business_manage_events',
      'read_page_mailboxes',
      'read_insights',
      'publish_video',
      'pages_show_list',
      'pages_read_user_content',
      'pages_read_engagement',
      'pages_messaging',
      'pages_manage_posts',
      'pages_manage_metadata',
      'pages_manage_instant_articles',
      'pages_manage_engagement',
      'pages_manage_ads',
      'pages_manage_cta',
      'manage_fundraisers',
      'leads_retrieval',
      'instagram_shopping_tag_products',
      'instagram_manage_messages',
      'instagram_manage_insights',
      'instagram_branded_content_ads_brand',
      'instagram_branded_content_brand',
      'instagram_branded_content_creator',
      'instagram_content_publish',
      'instagram_manage_comments',
      'email',
      'public_profile'
    ].join(',');
  
    // ✅ USAR TU URL (ya configurada en Meta)
    const redirectUri = 'https://sharkboot-backend-production.up.railway.app/auth/facebook/callback';
  
    // ✅ USAR LA MISMA VERSIÓN DE API QUE EL CRM (v23.0, no v18.0)
    const facebookAuthUrl = 'https://www.facebook.com/v23.0/dialog/oauth' +
      `?client_id=${process.env.FACEBOOK_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${scopes}` +
      `&state=${state}` +
      `&response_type=code`;
  
    console.log('✅ Usando misma estructura que CRM...');
    console.log('🔍 API Version: v23.0');
    console.log('🔍 Permisos count:', scopes.split(',').length);
    
    res.redirect(facebookAuthUrl);
  });
/*---------------------------------------------------------------
   4) CALLBACK Facebook - Callback que maneja la respuesta de Facebook
  -------------------------------------------------------------*/
/*---------------------------------------------------------------
   CALLBACK Facebook COMPLETO - v23.0 (igual que CRM)
  -------------------------------------------------------------*/
  router.get('/facebook/callback', async (req, res) => {
    try {
      const { code, state, error, error_description } = req.query;
      
      // Manejar errores de Facebook
      if (error) {
        console.error('❌ Error de Facebook:', error, error_description);
        const stateData = state ? JSON.parse(decodeURIComponent(state)) : {};
        const frontendUrl = stateData?.frontend_url || 'http://localhost:5173';
        return res.redirect(`${frontendUrl}/login?error=${error}&error_description=${encodeURIComponent(error_description || 'Error desconocido')}`);
      }
  
      const stateData = JSON.parse(decodeURIComponent(state));
  
      // Verificar que el estado sea válido (no mayor a 1 hora)
      if (!stateData || !stateData.timestamp || Date.now() - stateData.timestamp > 3600000) {
        const frontendUrl = stateData?.frontend_url || 'http://localhost:5173';
        return res.redirect(`${frontendUrl}/login?error=invalid_state`);
      }
  
      console.log('🔄 Intercambiando código por token de acceso...');
  
      // ✅ Intercambiar el código por un token de acceso (v23.0)
      const tokenResponse = await axios.get('https://graph.facebook.com/v23.0/oauth/access_token', {
        params: {
          client_id: process.env.FACEBOOK_APP_ID,
          redirect_uri: 'https://sharkboot-backend-production.up.railway.app/auth/facebook/callback',
          client_secret: process.env.FACEBOOK_APP_SECRET,
          code
        }
      });
  
      const { access_token } = tokenResponse.data;
      console.log('✅ Token de acceso obtenido');
  
      // ✅ Obtener información del perfil con permisos extendidos (v23.0)
      const profileResponse = await axios.get('https://graph.facebook.com/v23.0/me', {
        params: {
          fields: 'id,name,email,accounts{id,name,access_token},businesses{id,name}',
          access_token
        }
      });
  
      const facebookProfile = profileResponse.data;
      console.log('✅ Perfil obtenido con datos extendidos');
  
      // Guardar o actualizar usuario en la base de datos usando la estructura existente
      const { id: facebook_id, name, email } = facebookProfile;
  
      try {
        // Verificar si ya existe un usuario con este Facebook ID
        const [[existingUser]] = await db.execute(
          `SELECT up.user_id, u.client_id, u.name
             FROM user_providers up
             JOIN users u ON u.id = up.user_id
            WHERE up.provider='FACEBOOK' AND up.provider_id=?`,
          [facebook_id]
        );
  
        if (existingUser) {
          // Usuario existente - actualizar token
          console.log('👤 Usuario existente encontrado, actualizando token');
          await db.execute(
            `UPDATE user_providers SET access_token = ? WHERE user_id = ? AND provider = 'FACEBOOK'`,
            [access_token, existingUser.user_id]
          );
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
            [newProviderId, newUserId, facebook_id, access_token]
          );
  
          console.log('✅ Usuario guardado en DB:', facebook_id);
        }
      } catch (dbError) {
        console.error('❌ Error guardando usuario en DB:', dbError.message);
      }
  
      // Usar la URL del frontend del estado
      const frontendUrl = stateData.frontend_url || 'http://localhost:5173';
  
      // Obtener userId y clientId para generar JWT
      let userId, clientId, userName;
      try {
        const [[userData]] = await db.execute(
          `SELECT up.user_id, u.client_id, u.name
             FROM user_providers up
             JOIN users u ON u.id = up.user_id
            WHERE up.provider='FACEBOOK' AND up.provider_id=?`,
          [facebook_id]
        );
        
        if (userData) {
          userId = userData.user_id;
          clientId = userData.client_id;
          userName = userData.name;
        }
      } catch (e) {
        console.error('❌ Error obteniendo datos de usuario:', e.message);
      }
  
      // Generar JWT si tenemos los datos
      const token = userId && clientId ? sign({ userId, clientId, name: userName || name }) : null;
  
      // Redirigir al frontend con los datos completos
      const redirectUrl = new URL(frontendUrl + '/login');
      redirectUrl.searchParams.set('fb_token', access_token);
      redirectUrl.searchParams.set('fb_id', facebookProfile.id);
      redirectUrl.searchParams.set('name', facebookProfile.name);
      redirectUrl.searchParams.set('email', facebookProfile.email || '');
      if (token) {
        redirectUrl.searchParams.set('auth_token', token);
      }
  
      console.log('🔄 Redirigiendo al frontend:', redirectUrl.toString());
      return res.redirect(redirectUrl.toString());
      
    } catch (error) {
      console.error('❌ Error en callback de Facebook:', error.response?.data || error.message);
      
      // Intentar obtener frontend URL del state para redirección de error
      let frontendUrl = 'http://localhost:5173';
      try {
        if (req.query.state) {
          const stateData = JSON.parse(decodeURIComponent(req.query.state));
          frontendUrl = stateData.frontend_url || frontendUrl;
        }
      } catch (e) {
        // Usar URL por defecto si hay error parseando state
      }
      
      return res.redirect(`${frontendUrl}/login?error=callback_error&error_description=${encodeURIComponent('Error procesando autenticación')}`);
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
    // Verificar que el token siga siendo válido
    const verifyRes = await axios.get('https://graph.facebook.com/v18.0/me', {
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
  8) ENDPOINT ADICIONAL para verificar permisos obtenidos
  -------------------------------------------------------------*/
router.get('/facebook/permissions', async (req, res) => {
  const { access_token } = req.query;
  
  if (!access_token) {
    return res.status(400).json({ error: 'access_token requerido' });
  }

  try {
    // Verificar qué permisos fueron realmente otorgados
    const permissionsResponse = await axios.get('https://graph.facebook.com/v18.0/me/permissions', {
      params: { access_token }
    });
    
    const grantedPermissions = permissionsResponse.data.data
      .filter(perm => perm.status === 'granted')
      .map(perm => perm.permission);
    
    console.log('✅ Permisos otorgados:', grantedPermissions);
    
    res.json({ 
      granted_permissions: grantedPermissions,
      total_granted: grantedPermissions.length
    });
  } catch (error) {
    console.error('❌ Error verificando permisos:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error verificando permisos' });
  }
});

/*---------------------------------------------------------------
  9) INICIAR proceso de vínculo Facebook desde el frontend
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