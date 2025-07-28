const express   = require('express');
const passport  = require('passport');
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios     = require('axios');
const db        = require('../db');
const { sign, verify } = require('../helpers/jwt');

const router = express.Router();
const authGuard = require('../middlewares/authGuard');

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
  ENDPOINT PARA VINCULAR FACEBOOK - Para usuarios ya logueados
  -------------------------------------------------------------*/

/*---------------------------------------------------------------
  SOLUCIÓN: Agregar ruta alternativa que NO requiera JWT en el header
  -------------------------------------------------------------*/

// Opción 1: Modificar la ruta existente para aceptar token como query parameter
router.get('/facebook/link', async (req, res) => {
  console.log('🔗 Iniciando vinculación de Facebook');
  
  if (!process.env.FACEBOOK_APP_ID) {
    console.error('❌ FACEBOOK_APP_ID no está configurado');
    return res.redirect('/dashboard?error=facebook_not_configured');
  }

  // ✅ OBTENER TOKEN DE MÚLTIPLES FUENTES
  let token = null;
  let userId = null;

  // 1. Intentar desde header Authorization (método original)
  const authHeader = req.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }
  
  // 2. Intentar desde query parameter (método nuevo para window.location.href)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  // Verificar y decodificar el token
  if (!token) {
    const frontendUrl = req.query.frontend_url || 'http://localhost:5173';
    return res.redirect(`${frontendUrl}/accounts?error=no_token`);
  }

  try {
    // Verificar el token JWT
    const decoded = verify(token); // Tu función de verificación JWT
    userId = decoded.userId;
    
    if (!userId) {
      throw new Error('Token inválido');
    }
    
    console.log('👤 Usuario logueado solicitando vinculación:', userId);
  } catch (error) {
    console.error('❌ Token inválido:', error.message);
    const frontendUrl = req.query.frontend_url || 'http://localhost:5173';
    return res.redirect(`${frontendUrl}/accounts?error=invalid_token`);
  }

  const frontendUrl = req.query.frontend_url || req.get('Referer') || 'http://localhost:5173';

  // Construir estado con información de vinculación
  const state = encodeURIComponent(JSON.stringify({
    timestamp: Date.now(),
    source: 'link_facebook',
    frontend_url: frontendUrl,
    linkToUserId: userId // ← ESTE ES EL IDENTIFICADOR CLAVE
  }));

  // Usar los mismos permisos que el registro normal
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

  const redirectUri = 'https://sharkboot-backend-production.up.railway.app/auth/facebook/callback';

  // Construir URL de Facebook (misma estructura que el registro)
  const facebookAuthUrl = 'https://www.facebook.com/v23.0/dialog/oauth' +
    `?client_id=${process.env.FACEBOOK_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&state=${state}` +
    `&response_type=code`;

  console.log('✅ Redirigiendo a Facebook para vinculación...');
  console.log('🔍 Usuario a vincular:', userId);
  console.log('🔍 Frontend URL:', frontendUrl);
  
  res.redirect(facebookAuthUrl);
});

/*---------------------------------------------------------------
  ENDPOINT PARA VERIFICAR ESTADO DE VINCULACIÓN
  -------------------------------------------------------------*/
router.get('/facebook/status', authGuard, async (req, res) => {
  try {
    const { userId } = req.auth;
    
    // Verificar si el usuario tiene Facebook vinculado
    const [[facebookProvider]] = await db.execute(
      'SELECT provider_id, created_at FROM user_providers WHERE user_id = ? AND provider = "FACEBOOK"',
      [userId]
    );
    
    if (facebookProvider) {
      res.json({
        linked: true,
        facebook_id: facebookProvider.provider_id,
        linked_at: facebookProvider.created_at
      });
    } else {
      res.json({
        linked: false
      });
    }
    
  } catch (error) {
    console.error('❌ Error verificando estado de Facebook:', error.message);
    res.status(500).json({ error: 'Error verificando estado de vinculación' });
  }
});

/*---------------------------------------------------------------
  ENDPOINT PARA DESVINCULAR FACEBOOK
  -------------------------------------------------------------*/
router.delete('/facebook/unlink', authGuard, async (req, res) => {
  try {
    const { userId } = req.auth;
    
    // Eliminar la vinculación de Facebook
    const [result] = await db.execute(
      'DELETE FROM user_providers WHERE user_id = ? AND provider = "FACEBOOK"',
      [userId]
    );
    
    if (result.affectedRows > 0) {
      console.log('✅ Facebook desvinculado para usuario:', userId);
      res.json({ success: true, message: 'Facebook desvinculado correctamente' });
    } else {
      res.status(404).json({ error: 'No se encontró vinculación de Facebook' });
    }
    
  } catch (error) {
    console.error('❌ Error desvinculando Facebook:', error.message);
    res.status(500).json({ error: 'Error desvinculando Facebook' });
  }
});

/*---------------------------------------------------------------
   CALLBACK Facebook COMPLETO - v23.0 (igual que CRM)
  -------------------------------------------------------------*/
 /*---------------------------------------------------------------
   CALLBACK Facebook COMPLETO - CON FALLBACK DE WHATSAPP
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

    // ✅ PARSING SEGURO DEL STATE
    let stateData;
    try {
      // Intentar decodificar como JSON primero
      const decodedState = decodeURIComponent(state);
      console.log('🔍 State decodificado:', decodedState);
      
      // Verificar si es un JWT (empieza con eyJ)
      if (decodedState.startsWith('eyJ')) {
        console.log('🔑 State parece ser un JWT, intentando decodificar...');
        try {
          // Decodificar JWT
          const jwtParts = decodedState.split('.');
          if (jwtParts.length === 3) {
            const payload = JSON.parse(atob(jwtParts[1]));
            console.log('📋 JWT payload:', payload);
            
            // Crear stateData desde el JWT
            stateData = {
              timestamp: Date.now(), // Timestamp actual
              source: 'whatsapp_setup', // Asumir que es setup de WhatsApp
              frontend_url: 'http://localhost:5173', // URL por defecto
              userId: payload.userId || payload.user_id || payload.sub,
              clientId: payload.clientId || payload.client_id
            };
            
            console.log('✅ State reconstruido desde JWT:', stateData);
          } else {
            throw new Error('JWT malformado');
          }
        } catch (jwtError) {
          console.error('❌ Error decodificando JWT:', jwtError);
          throw new Error('State JWT inválido');
        }
      } else {
        // Intentar parsear como JSON normal
        stateData = JSON.parse(decodedState);
        console.log('✅ State parseado como JSON:', stateData);
      }
    } catch (parseError) {
      console.error('❌ Error parseando state:', parseError);
      console.log('🔍 State original:', state);
      
      // Fallback: crear state básico
      stateData = {
        timestamp: Date.now(),
        source: 'whatsapp_setup',
        frontend_url: 'http://localhost:5173'
      };
      console.log('🔄 Usando fallback state:', stateData);
    }

    // Verificar que el estado sea válido (no mayor a 1 hora)
    if (!stateData || !stateData.timestamp || Date.now() - stateData.timestamp > 3600000) {
      const frontendUrl = stateData?.frontend_url || 'http://localhost:5173';
      return res.redirect(`${frontendUrl}/login?error=invalid_state`);
    }

    console.log('🔄 Intercambiando código por token de acceso...');

    // Intercambiar el código por un token de acceso (v23.0)
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

    // Obtener información del perfil con permisos extendidos (v23.0)
    const profileResponse = await axios.get('https://graph.facebook.com/v23.0/me', {
      params: {
        fields: 'id,name,email,accounts{id,name,access_token_enc},businesses{id,name}',
        access_token
      }
    });

    const facebookProfile = profileResponse.data;
    console.log('✅ Perfil obtenido con datos extendidos');

    const { id: facebook_id, name, email } = facebookProfile;
    
    // ✅ DETECTAR TIPO DE FLUJO
    const isLinking = stateData.linkToUserId ? true : false;
    const isWhatsAppSetup = stateData.source === 'whatsapp_setup';

    // 🔧 MANEJO ESPECIAL: Setup de WhatsApp
    if (isWhatsAppSetup) {
      console.log('🔧 Procesando setup de WhatsApp...');
      
      try {
        // Verificar que el usuario existe y obtener su información
        const [[existingUser]] = await db.execute(
          'SELECT id, client_id, name FROM users WHERE id = ?',
          [stateData.userId]
        );
        
        if (!existingUser) {
          throw new Error('Usuario no encontrado para setup de WhatsApp');
        }
        
        // Actualizar o crear el provider de Facebook si no existe
        const [[existingProvider]] = await db.execute(
          'SELECT id FROM user_providers WHERE user_id = ? AND provider = "FACEBOOK"',
          [stateData.userId]
        );
        
        if (existingProvider) {
          // Actualizar token existente
          await db.execute(
            'UPDATE user_providers SET access_token_enc = ?, updated_at = NOW() WHERE user_id = ? AND provider = "FACEBOOK"',
            [access_token, stateData.userId]
          );
          console.log('✅ Token de Facebook actualizado para setup de WhatsApp');
        } else {
          // Crear nueva vinculación de Facebook
          const newProviderId = uuidv4();
          await db.execute(
            'INSERT INTO user_providers (id, user_id, provider, provider_id, access_token_enc, created_at) VALUES (?, ?, "FACEBOOK", ?, ?, NOW())',
            [newProviderId, stateData.userId, facebook_id, access_token]
          );
          console.log('✅ Facebook vinculado para setup de WhatsApp');
        }
        
        // 🎯 INTENTAR EMBEDDED SIGNUP AUTOMÁTICO
        try {
          console.log('🚀 Intentando setup automático de WhatsApp...');
          
          // Verificar permisos del token
          const permissionsResponse = await axios.get('https://graph.facebook.com/v23.0/me/permissions', {
            params: { access_token }
          });
          
          const grantedPermissions = permissionsResponse.data.data
            .filter(perm => perm.status === 'granted')
            .map(perm => perm.permission);
          
          console.log('📋 Permisos otorgados:', grantedPermissions);
          
          const hasWhatsAppPerms = grantedPermissions.includes('whatsapp_business_management') && 
                                  grantedPermissions.includes('whatsapp_business_messaging');
          
          if (!hasWhatsAppPerms) {
            throw new Error('INSUFFICIENT_PERMISSIONS');
          }
          
          // Obtener negocios disponibles
          const businessesResponse = await axios.get(`https://graph.facebook.com/v23.0/me/businesses`, {
            params: { access_token }
          });
          
          const businesses = businessesResponse.data.data || [];
          console.log(`📊 Encontrados ${businesses.length} negocios`);
          
          if (businesses.length === 0) {
            throw new Error('NO_BUSINESSES_FOUND');
          }
          
          // Buscar WABAs en los negocios
          let availableWabas = [];
          let totalPhoneNumbers = 0;
          
          for (const business of businesses) {
            try {
              const wabaResponse = await axios.get(
                `https://graph.facebook.com/v23.0/${business.id}/owned_whatsapp_business_accounts`,
                { params: { access_token } }
              );
              
              for (const waba of wabaResponse.data.data || []) {
                // Obtener números de teléfono para cada WABA
                try {
                  const numbersResponse = await axios.get(
                    `https://graph.facebook.com/v23.0/${waba.id}/phone_numbers`,
                    { 
                      params: { 
                        access_token,
                        fields: 'id,display_phone_number,verified_name,code_verification_status'
                      }
                    }
                  );
                  
                  const phoneNumbers = numbersResponse.data.data || [];
                  totalPhoneNumbers += phoneNumbers.length;
                  
                  availableWabas.push({
                    business_id: business.id,
                    business_name: business.name,
                    waba_id: waba.id,
                    waba_name: waba.name,
                    phone_numbers: phoneNumbers
                  });
                } catch (numbersError) {
                  console.log(`⚠️ Error obteniendo números para WABA ${waba.id}:`, numbersError.message);
                }
              }
            } catch (wabaError) {
              console.log(`⚠️ No se pudieron obtener WABAs para business ${business.id}:`, wabaError.message);
            }
          }
          
          console.log(`📱 Encontrados ${availableWabas.length} WABAs con ${totalPhoneNumbers} números totales`);
          
          if (availableWabas.length === 0) {
            throw new Error('NO_WABAS_FOUND');
          }
          
          if (totalPhoneNumbers === 0) {
            throw new Error('NO_PHONE_NUMBERS_FOUND');
          }
          
          // ✅ ÉXITO: Redirigir al frontend con datos de WABAs disponibles
          const frontendUrl = stateData.frontend_url || 'http://localhost:5173';
          const redirectUrl = new URL(frontendUrl + '/whatsapp/setup');
          redirectUrl.searchParams.set('status', 'success');
          redirectUrl.searchParams.set('setup_method', 'automatic');
          redirectUrl.searchParams.set('wabas_count', availableWabas.length);
          redirectUrl.searchParams.set('phone_numbers_count', totalPhoneNumbers);
          
          console.log('✅ Setup automático exitoso, redirigiendo al frontend');
          return res.redirect(redirectUrl.toString());
          
        } catch (autoSetupError) {
          // 🔄 FALLBACK: Setup manual
          console.log('⚠️ Setup automático falló, iniciando fallback manual:', autoSetupError.message);
          
          const frontendUrl = stateData.frontend_url || 'http://localhost:5173';
          const redirectUrl = new URL(frontendUrl + '/whatsapp/setup');
          
          // Determinar el tipo de fallback según el error
          let fallbackReason = 'unknown';
          let fallbackInstructions = [];
          let manualSetupUrl = 'https://business.facebook.com/wa/manage/';
          let fallbackTitle = 'Configuración manual requerida';
          
          if (autoSetupError.message === 'INSUFFICIENT_PERMISSIONS') {
            fallbackReason = 'insufficient_permissions';
            fallbackTitle = 'Permisos insuficientes';
            fallbackInstructions = [
              '1. Ve a Meta Business Manager',
              '2. Asegúrate de tener rol de Administrador',
              '3. Verifica que tu negocio esté aprobado',
              '4. Intenta el proceso nuevamente'
            ];
            manualSetupUrl = 'https://business.facebook.com/settings/';
          } else if (autoSetupError.message === 'NO_BUSINESSES_FOUND') {
            fallbackReason = 'no_business_manager';
            fallbackTitle = 'Business Manager requerido';
            fallbackInstructions = [
              '1. Ve a Meta Business Manager',
              '2. Crea una cuenta de negocio si no tienes una',
              '3. Verifica tu negocio proporcionando documentos oficiales',
              '4. Asegúrate de tener rol de Administrador',
              '5. Regresa aquí para continuar'
            ];
            manualSetupUrl = 'https://business.facebook.com/overview';
          } else if (autoSetupError.message === 'NO_WABAS_FOUND') {
            fallbackReason = 'no_whatsapp_account';
            fallbackTitle = 'WhatsApp Business Account requerido';
            fallbackInstructions = [
              '1. Ve a WhatsApp Manager',
              '2. Crea una cuenta de WhatsApp Business',
              '3. Completa la verificación del negocio',
              '4. Regresa aquí para sincronizar'
            ];
            manualSetupUrl = 'https://business.facebook.com/wa/manage/';
          } else if (autoSetupError.message === 'NO_PHONE_NUMBERS_FOUND') {
            fallbackReason = 'no_phone_numbers';
            fallbackTitle = 'Número de teléfono requerido';
            fallbackInstructions = [
              '1. Ve a WhatsApp Manager',
              '2. Agrega un número de teléfono a tu cuenta',
              '3. Verifica el número con el código SMS',
              '4. Regresa aquí para sincronizar'
            ];
            manualSetupUrl = 'https://business.facebook.com/wa/manage/phone-numbers/';
          } else {
            fallbackReason = 'unknown_error';
            fallbackTitle = 'Error en la configuración';
            fallbackInstructions = [
              '1. Verifica que tienes todos los permisos necesarios',
              '2. Asegúrate de que tu Business Manager esté verificado',
              '3. Contacta al administrador si es necesario',
              '4. Intenta nuevamente en unos minutos'
            ];
          }
          
          // Enviar información del fallback al frontend
          redirectUrl.searchParams.set('status', 'fallback');
          redirectUrl.searchParams.set('setup_method', 'manual');
          redirectUrl.searchParams.set('fallback_reason', fallbackReason);
          redirectUrl.searchParams.set('fallback_title', encodeURIComponent(fallbackTitle));
          redirectUrl.searchParams.set('manual_setup_url', manualSetupUrl);
          redirectUrl.searchParams.set('instructions', encodeURIComponent(JSON.stringify(fallbackInstructions)));
          
          console.log(`🔄 Redirigiendo a fallback manual: ${fallbackReason}`);
          return res.redirect(redirectUrl.toString());
        }
        
      } catch (setupError) {
        console.error('❌ Error crítico en setup de WhatsApp:', setupError.message);
        console.error('Stack:', setupError.stack);
        
        const frontendUrl = stateData.frontend_url || 'http://localhost:5173';
        return res.redirect(`${frontendUrl}/whatsapp/setup?error=setup_failed&error_description=${encodeURIComponent(setupError.message)}`);
      }
    }
    
    if (isLinking) {
      // 🔗 ESCENARIO 1: VINCULAR FACEBOOK A CUENTA EXISTENTE
      console.log('🔗 Vinculando Facebook a cuenta existente:', stateData.linkToUserId);
      
      try {
        // Verificar que el usuario existe
        const [[existingUser]] = await db.execute(
          'SELECT id, client_id, name FROM users WHERE id = ?',
          [stateData.linkToUserId]
        );
        
        if (!existingUser) {
          throw new Error('Usuario no encontrado');
        }
        
        // Verificar si ya tiene Facebook vinculado
        const [[existingProvider]] = await db.execute(
          'SELECT id FROM user_providers WHERE user_id = ? AND provider = "FACEBOOK"',
          [stateData.linkToUserId]
        );
        
        if (existingProvider) {
          // Actualizar token existente
          await db.execute(
            'UPDATE user_providers SET provider_id = ?, access_token_enc = ?, updated_at = NOW() WHERE user_id = ? AND provider = "FACEBOOK"',
            [facebook_id, access_token, stateData.linkToUserId]
          );
          console.log('✅ Facebook actualizado para usuario existente');
        } else {
          // Crear nueva vinculación
          const newProviderId = uuidv4();
          await db.execute(
            'INSERT INTO user_providers (id, user_id, provider, provider_id, access_token_enc, created_at) VALUES (?, ?, "FACEBOOK", ?, ?, NOW())',
            [newProviderId, stateData.linkToUserId, facebook_id, access_token]
          );
          console.log('✅ Facebook vinculado a usuario existente');
        }
        
        // Generar JWT para el usuario existente
        const token = sign({ 
          userId: existingUser.id, 
          clientId: existingUser.client_id, 
          name: existingUser.name 
        });
        
        const frontendUrl = stateData.frontend_url || 'http://localhost:5173';
        const redirectUrl = new URL(frontendUrl + '/dashboard'); // Redirigir al dashboard, no al login
        redirectUrl.searchParams.set('linked', 'facebook');
        redirectUrl.searchParams.set('auth_token', token);
        
        console.log('🔄 Facebook vinculado, redirigiendo al dashboard');
        return res.redirect(redirectUrl.toString());
        
      } catch (linkError) {
        console.error('❌ Error vinculando Facebook:', linkError.message);
        const frontendUrl = stateData.frontend_url || 'http://localhost:5173';
        return res.redirect(`${frontendUrl}/dashboard?error=link_failed`);
      }
      
    } else {
      // 🆕 ESCENARIO 2: REGISTRO NUEVO CON FACEBOOK
      console.log('🆕 Registro nuevo con Facebook');
      
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
          // Usuario existente - actualizar token y hacer login
          console.log('👤 Usuario Facebook existente encontrado, actualizando token');
          await db.execute(
            'UPDATE user_providers SET access_token_enc = ?, updated_at = NOW() WHERE user_id = ? AND provider = "FACEBOOK"',
            [access_token, existingUser.user_id]
          );
          
          // Generar JWT y redirigir
          const token = sign({ 
            userId: existingUser.user_id, 
            clientId: existingUser.client_id, 
            name: existingUser.name 
          });
          
          const frontendUrl = stateData.frontend_url || 'http://localhost:5173';
          const redirectUrl = new URL(frontendUrl + '/login');
          redirectUrl.searchParams.set('auth_token', token);
          redirectUrl.searchParams.set('fb_token', access_token);
          
          console.log('🔄 Login exitoso con Facebook existente');
          return res.redirect(redirectUrl.toString());
          
        } else {
          // ✅ NUEVO USUARIO - CREAR TODO DESDE CERO
          console.log('🆕 Creando nuevo usuario completo desde Facebook');
          
          const newClientId = uuidv4();
          const newUserId = uuidv4();
          const newProviderId = uuidv4();
          
          // ✅ 1. Crear CLIENT
          await db.execute(
            'INSERT INTO clients (id, name, plan, created_at) VALUES (?, ?, ?, NOW())',
            [
              newClientId, 
              `Cliente de ${name || 'Usuario Facebook'}`,
              'FREE'
            ]
          );
          console.log('✅ Cliente creado:', newClientId);

          // ✅ 2. Crear USER
          await db.execute(
            'INSERT INTO users (id, client_id, name, email, created_at) VALUES (?, ?, ?, ?, NOW())',
            [
              newUserId, 
              newClientId, 
              name || 'Usuario Facebook',
              email || null
            ]
          );
          console.log('✅ Usuario creado:', newUserId);

          // ✅ 3. Crear USER_PROVIDER
          await db.execute(
            'INSERT INTO user_providers (id, user_id, provider, provider_id, access_token_enc, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
            [
              newProviderId, 
              newUserId, 
              'FACEBOOK', 
              facebook_id, 
              access_token
            ]
          );
          console.log('✅ Provider creado:', newProviderId);

          // Generar JWT
          const token = sign({ 
            userId: newUserId, 
            clientId: newClientId, 
            name: name || 'Usuario Facebook'
          });

          // Redirigir al frontend indicando que es un nuevo usuario
          const frontendUrl = stateData.frontend_url || 'http://localhost:5173';
          const redirectUrl = new URL(frontendUrl + '/login');
          redirectUrl.searchParams.set('auth_token', token);
          redirectUrl.searchParams.set('fb_token', access_token);
          redirectUrl.searchParams.set('fb_id', facebook_id);
          redirectUrl.searchParams.set('name', name || '');
          redirectUrl.searchParams.set('email', email || '');
          redirectUrl.searchParams.set('new_user', 'true');
          
          console.log('🔄 Usuario nuevo creado, redirigiendo al frontend');
          return res.redirect(redirectUrl.toString());
        }
        
      } catch (dbError) {
        console.error('❌ Error en base de datos:', dbError.message);
        console.error('Stack:', dbError.stack);
        
        const frontendUrl = stateData.frontend_url || 'http://localhost:5173';
        return res.redirect(`${frontendUrl}/login?error=database_error&error_description=${encodeURIComponent('Error creando usuario')}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error en callback de Facebook:', error.response?.data || error.message);
    console.error('Stack:', error.stack);
    
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
        `INSERT IGNORE INTO user_providers (id,user_id,provider,provider_id,access_token_enc)
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
          `INSERT INTO user_providers (id,user_id,provider,provider_id,access_token_enc)
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