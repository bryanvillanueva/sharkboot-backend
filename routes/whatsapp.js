const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const db = require('../db');
const authGuard = require('../middlewares/authGuard');

const router = express.Router();

// ============== CONFIGURACIÓN ==============

// Límites por plan
const PLAN_LIMITS = {
  FREE: 1,
  STARTER: 3,
  PRO: 5,
  ENTERPRISE: 20,
};

// Headers helper para Meta APIs
const getMetaHeaders = (accessToken) => ({
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json'
});

// Helper para obtener token de Facebook del usuario
async function getFacebookToken(userId) {
  try {
    const [[provider]] = await db.execute(
      'SELECT access_token_enc FROM user_providers WHERE user_id = ? AND provider = "FACEBOOK"',
      [userId]
    );
    
    if (!provider || !provider.access_token_enc) {
      throw new Error('Facebook no está vinculado a tu cuenta');
    }
    
    return provider.access_token_enc;
  } catch (error) {
    throw new Error('Error obteniendo token de Facebook: ' + error.message);
  }
}

// Helper para verificar límites del plan
async function checkPlanLimits(clientId) {
  try {
    // Obtener plan del cliente
    const [[client]] = await db.execute(
      'SELECT plan FROM clients WHERE id = ?',
      [clientId]
    );
    
    if (!client) {
      throw new Error('Cliente no encontrado');
    }
    
    const plan = client.plan || 'FREE';
    const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;
    
    // Contar números existentes
    const [[count]] = await db.execute(
      'SELECT COUNT(*) as count FROM whatsapp_numbers WHERE client_id = ?',
      [clientId]
    );
    
    return {
      current: count.count,
      limit,
      plan,
      canAdd: count.count < limit
    };
  } catch (error) {
    throw new Error('Error verificando límites: ' + error.message);
  }
}

// ============== ENDPOINTS PRINCIPALES ==============

// 1. GET /whatsapp/numbers - Listar números de WhatsApp del cliente
router.get('/numbers', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  
  try {
    const [numbers] = await db.execute(`
      SELECT 
        wn.id,
        wn.phone_number_id,
        wn.waba_id,
        wn.display_name,
        wn.phone_number,
        wn.status,
        wn.assistant_id,
        wn.created_at,
        a.name as assistant_name
      FROM whatsapp_numbers wn
      LEFT JOIN assistants a ON wn.assistant_id = a.id
      WHERE wn.client_id = ?
      ORDER BY wn.created_at DESC
    `, [clientId]);
    
    // Obtener límites del plan
    const planInfo = await checkPlanLimits(clientId);
    
    res.json({
      numbers,
      plan_info: planInfo
    });
    
  } catch (error) {
    console.error('Error listando números WhatsApp:', error);
    res.status(500).json({ 
      error: 'Error listando números de WhatsApp',
      details: error.message
    });
  }
});

// 2. POST /whatsapp/setup - Iniciar Embedded Signup
router.post('/setup', authGuard, async (req, res) => {
  const { userId, clientId } = req.auth;
  
  try {
    // Verificar límites del plan
    const planInfo = await checkPlanLimits(clientId);
    if (!planInfo.canAdd) {
      return res.status(403).json({
        error: 'Límite de números alcanzado',
        plan: planInfo.plan,
        current: planInfo.current,
        limit: planInfo.limit
      });
    }
    
    // Obtener token de Facebook
    const accessToken = await getFacebookToken(userId);
    
    // Generar URL de Embedded Signup
    const state = Buffer.from(JSON.stringify({
      userId,
      clientId,
      timestamp: Date.now(),
      source: 'whatsapp_setup'
    })).toString('base64');
    
    const embedSignupUrl = `https://www.facebook.com/v23.0/dialog/oauth` +
      `?client_id=${process.env.FACEBOOK_APP_ID}` +
      `&redirect_uri=${encodeURIComponent('https://sharkboot-backend-production.up.railway.app/auth/facebook/callback')}` +
      `&scope=whatsapp_business_management,whatsapp_business_messaging` +
      `&state=${state}` +
      `&response_type=code`;
    
    res.json({
      success: true,
      embed_signup_url: embedSignupUrl,
      plan_info: planInfo
    });
    
  } catch (error) {
    console.error('Error en setup WhatsApp:', error);
    res.status(500).json({
      error: 'Error configurando WhatsApp',
      details: error.message
    });
  }
});

// 3. GET /whatsapp/business-accounts - Obtener cuentas de WhatsApp Business del usuario
router.get('/business-accounts', authGuard, async (req, res) => {
  const { userId } = req.auth;
  
  try {
    const accessToken = await getFacebookToken(userId);
    
    // Obtener negocios del usuario
    const businessesResponse = await axios.get(`https://graph.facebook.com/v23.0/me/businesses`, {
      params: { access_token: accessToken }
    });
    
    let whatsappAccounts = [];
    
    // Para cada negocio, obtener sus WhatsApp Business Accounts
    for (const business of businessesResponse.data.data || []) {
      try {
        const wabaResponse = await axios.get(
          `https://graph.facebook.com/v23.0/${business.id}/owned_whatsapp_business_accounts`,
          { params: { access_token: accessToken } }
        );
        
        for (const waba of wabaResponse.data.data || []) {
          // Obtener números de teléfono para cada WABA
          try {
            const numbersResponse = await axios.get(
              `https://graph.facebook.com/v23.0/${waba.id}/phone_numbers`,
              { 
                params: { 
                  access_token: accessToken,
                  fields: 'id,display_phone_number,verified_name,code_verification_status'
                }
              }
            );
            
            whatsappAccounts.push({
              business_id: business.id,
              business_name: business.name,
              waba_id: waba.id,
              waba_name: waba.name,
              phone_numbers: numbersResponse.data.data || []
            });
          } catch (numbersError) {
            console.error(`Error obteniendo números para WABA ${waba.id}:`, numbersError.message);
          }
        }
      } catch (wabaError) {
        console.error(`Error obteniendo WABAs para business ${business.id}:`, wabaError.message);
      }
    }
    
    res.json({
      whatsapp_accounts: whatsappAccounts
    });
    
  } catch (error) {
    console.error('Error obteniendo cuentas WhatsApp:', error);
    res.status(500).json({
      error: 'Error obteniendo cuentas de WhatsApp Business',
      details: error.message
    });
  }
});

// 4. POST /whatsapp/register-number - Registrar número específico de WhatsApp
router.post('/register-number', authGuard, async (req, res) => {
  const { userId, clientId } = req.auth;
  const { waba_id, phone_number_id, display_name } = req.body;
  
  if (!waba_id || !phone_number_id || !display_name) {
    return res.status(400).json({
      error: 'Datos requeridos: waba_id, phone_number_id, display_name'
    });
  }
  
  try {
    // Verificar límites del plan
    const planInfo = await checkPlanLimits(clientId);
    if (!planInfo.canAdd) {
      return res.status(403).json({
        error: 'Límite de números alcanzado',
        plan: planInfo.plan,
        current: planInfo.current,
        limit: planInfo.limit
      });
    }
    
    const accessToken = await getFacebookToken(userId);
    
    // Obtener información detallada del número desde Meta
    const numberResponse = await axios.get(
      `https://graph.facebook.com/v23.0/${phone_number_id}`,
      { 
        params: { 
          access_token: accessToken,
          fields: 'id,display_phone_number,verified_name,code_verification_status'
        }
      }
    );
    
    const numberInfo = numberResponse.data;
    
    // Verificar que el número esté verificado
    if (numberInfo.code_verification_status !== 'VERIFIED') {
      return res.status(400).json({
        error: 'El número debe estar verificado antes de registrarlo',
        status: numberInfo.code_verification_status
      });
    }
    
    // Guardar en la base de datos
    const numberId = uuidv4();
    await db.execute(`
      INSERT INTO whatsapp_numbers 
      (id, client_id, phone_number_id, waba_id, display_name, phone_number, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `, [
      numberId,
      clientId,
      phone_number_id,
      waba_id,
      display_name,
      numberInfo.display_phone_number
    ]);
    
    // Guardar credenciales en whatsapp_credentials
    const credentialId = uuidv4();
    await db.execute(`
      INSERT INTO whatsapp_credentials
      (id, client_id, waba_id, phone_number_id, token_enc, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `, [
      credentialId,
      clientId,
      waba_id,
      phone_number_id,
      accessToken
    ]);
    
    console.log('Número WhatsApp registrado:', {
      numberId,
      phone_number_id,
      display_name,
      clientId
    });
    
    res.json({
      success: true,
      number_id: numberId,
      phone_number_id,
      display_name,
      phone_number: numberInfo.display_phone_number,
      status: 'active'
    });
    
  } catch (error) {
    console.error('Error registrando número WhatsApp:', error);
    res.status(500).json({
      error: 'Error registrando número de WhatsApp',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// 5. POST /whatsapp/:numberId/assign - Asignar asistente a número de WhatsApp
router.post('/:numberId/assign', authGuard, async (req, res) => {
  const { numberId } = req.params;
  const { clientId } = req.auth;
  const { assistant_id } = req.body;
  
  if (!assistant_id) {
    return res.status(400).json({
      error: 'assistant_id es requerido'
    });
  }
  
  try {
    // Verificar que el número pertenece al cliente
    const [[number]] = await db.execute(
      'SELECT id, assistant_id FROM whatsapp_numbers WHERE id = ? AND client_id = ?',
      [numberId, clientId]
    );
    
    if (!number) {
      return res.status(404).json({
        error: 'Número de WhatsApp no encontrado'
      });
    }
    
    // Verificar que el asistente pertenece al cliente
    const [[assistant]] = await db.execute(
      'SELECT id, name FROM assistants WHERE id = ? AND client_id = ?',
      [assistant_id, clientId]
    );
    
    if (!assistant) {
      return res.status(404).json({
        error: 'Asistente no encontrado'
      });
    }
    
    // Verificar que el asistente no esté ya asignado a otro número
    const [[existingAssignment]] = await db.execute(
      'SELECT id FROM whatsapp_numbers WHERE assistant_id = ? AND id != ?',
      [assistant_id, numberId]
    );
    
    if (existingAssignment) {
      return res.status(409).json({
        error: 'El asistente ya está asignado a otro número de WhatsApp'
      });
    }
    
    // Asignar asistente al número
    await db.execute(
      'UPDATE whatsapp_numbers SET assistant_id = ?, updated_at = NOW() WHERE id = ?',
      [assistant_id, numberId]
    );
    
    // Crear configuración del asistente para WhatsApp
    const configId = uuidv4();
    await db.execute(`
      INSERT INTO assistant_whatsapp_config 
      (id, assistant_id, whatsapp_number_id, auto_reply_enabled, welcome_message)
      VALUES (?, ?, ?, TRUE, 'Hola! Soy tu asistente virtual. ¿En qué puedo ayudarte?')
      ON DUPLICATE KEY UPDATE 
      whatsapp_number_id = VALUES(whatsapp_number_id),
      updated_at = NOW()
    `, [configId, assistant_id, numberId]);
    
    console.log('Asistente asignado a WhatsApp:', {
      assistant_id,
      assistant_name: assistant.name,
      number_id: numberId
    });
    
    res.json({
      success: true,
      assistant_id,
      assistant_name: assistant.name,
      number_id: numberId,
      auto_reply_enabled: true
    });
    
  } catch (error) {
    console.error('Error asignando asistente:', error);
    res.status(500).json({
      error: 'Error asignando asistente',
      details: error.message
    });
  }
});

// 6. DELETE /whatsapp/:numberId/unassign - Desasignar asistente de número
router.delete('/:numberId/unassign', authGuard, async (req, res) => {
  const { numberId } = req.params;
  const { clientId } = req.auth;
  
  try {
    // Verificar que el número pertenece al cliente
    const [[number]] = await db.execute(
      'SELECT id, assistant_id FROM whatsapp_numbers WHERE id = ? AND client_id = ?',
      [numberId, clientId]
    );
    
    if (!number) {
      return res.status(404).json({
        error: 'Número de WhatsApp no encontrado'
      });
    }
    
    if (!number.assistant_id) {
      return res.status(400).json({
        error: 'No hay asistente asignado a este número'
      });
    }
    
    // Desasignar asistente
    await db.execute(
      'UPDATE whatsapp_numbers SET assistant_id = NULL, updated_at = NOW() WHERE id = ?',
      [numberId]
    );
    
    // Eliminar configuración
    await db.execute(
      'DELETE FROM assistant_whatsapp_config WHERE whatsapp_number_id = ?',
      [numberId]
    );
    
    console.log('Asistente desasignado de WhatsApp:', {
      number_id: numberId,
      previous_assistant_id: number.assistant_id
    });
    
    res.json({
      success: true,
      number_id: numberId,
      message: 'Asistente desasignado correctamente'
    });
    
  } catch (error) {
    console.error('Error desasignando asistente:', error);
    res.status(500).json({
      error: 'Error desasignando asistente',
      details: error.message
    });
  }
});

// 7. GET /whatsapp/:numberId/config - Obtener configuración del número
router.get('/:numberId/config', authGuard, async (req, res) => {
  const { numberId } = req.params;
  const { clientId } = req.auth;
  
  try {
    const [[config]] = await db.execute(`
      SELECT 
        wn.id,
        wn.display_name,
        wn.phone_number,
        wn.status,
        wn.assistant_id,
        a.name as assistant_name,
        awc.auto_reply_enabled,
        awc.welcome_message,
        awc.response_delay_seconds
      FROM whatsapp_numbers wn
      LEFT JOIN assistants a ON wn.assistant_id = a.id
      LEFT JOIN assistant_whatsapp_config awc ON awc.whatsapp_number_id = wn.id
      WHERE wn.id = ? AND wn.client_id = ?
    `, [numberId, clientId]);
    
    if (!config) {
      return res.status(404).json({
        error: 'Número de WhatsApp no encontrado'
      });
    }
    
    res.json(config);
    
  } catch (error) {
    console.error('Error obteniendo configuración:', error);
    res.status(500).json({
      error: 'Error obteniendo configuración',
      details: error.message
    });
  }
});

// 8. PUT /whatsapp/:numberId/config - Actualizar configuración del número
router.put('/:numberId/config', authGuard, async (req, res) => {
  const { numberId } = req.params;
  const { clientId } = req.auth;
  const { auto_reply_enabled, welcome_message, response_delay_seconds } = req.body;
  
  try {
    // Verificar que el número pertenece al cliente y tiene asistente asignado
    const [[number]] = await db.execute(
      'SELECT id, assistant_id FROM whatsapp_numbers WHERE id = ? AND client_id = ?',
      [numberId, clientId]
    );
    
    if (!number) {
      return res.status(404).json({
        error: 'Número de WhatsApp no encontrado'
      });
    }
    
    if (!number.assistant_id) {
      return res.status(400).json({
        error: 'Debe asignar un asistente antes de configurar'
      });
    }
    
    // Actualizar configuración
    await db.execute(`
      UPDATE assistant_whatsapp_config 
      SET 
        auto_reply_enabled = COALESCE(?, auto_reply_enabled),
        welcome_message = COALESCE(?, welcome_message),
        response_delay_seconds = COALESCE(?, response_delay_seconds),
        updated_at = NOW()
      WHERE whatsapp_number_id = ?
    `, [
      auto_reply_enabled,
      welcome_message,
      response_delay_seconds,
      numberId
    ]);
    
    res.json({
      success: true,
      number_id: numberId,
      message: 'Configuración actualizada correctamente'
    });
    
  } catch (error) {
    console.error('Error actualizando configuración:', error);
    res.status(500).json({
      error: 'Error actualizando configuración',
      details: error.message
    });
  }
});

// 9. DELETE /whatsapp/:numberId - Eliminar número de WhatsApp
router.delete('/:numberId', authGuard, async (req, res) => {
  const { numberId } = req.params;
  const { clientId } = req.auth;
  
  try {
    // Verificar que el número pertenece al cliente
    const [[number]] = await db.execute(
      'SELECT id, phone_number_id FROM whatsapp_numbers WHERE id = ? AND client_id = ?',
      [numberId, clientId]
    );
    
    if (!number) {
      return res.status(404).json({
        error: 'Número de WhatsApp no encontrado'
      });
    }
    
    // Eliminar en cascada (las FK se encargan del resto)
    await db.execute('DELETE FROM whatsapp_numbers WHERE id = ?', [numberId]);
    
    console.log('Número WhatsApp eliminado:', {
      number_id: numberId,
      phone_number_id: number.phone_number_id,
      client_id: clientId
    });
    
    res.json({
      success: true,
      number_id: numberId,
      message: 'Número de WhatsApp eliminado correctamente'
    });
    
  } catch (error) {
    console.error('Error eliminando número WhatsApp:', error);
    res.status(500).json({
      error: 'Error eliminando número de WhatsApp',
      details: error.message
    });
  }
});

// 10. GET /whatsapp/assistants-available - Listar asistentes disponibles para asignar
router.get('/assistants-available', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  
  try {
    const [assistants] = await db.execute(`
      SELECT 
        a.id,
        a.name,
        a.instructions,
        a.created_at,
        wn.id as assigned_to_whatsapp
      FROM assistants a
      LEFT JOIN whatsapp_numbers wn ON wn.assistant_id = a.id
      WHERE a.client_id = ?
      ORDER BY a.created_at DESC
    `, [clientId]);
    
    res.json({
      assistants: assistants.map(assistant => ({
        ...assistant,
        available: !assistant.assigned_to_whatsapp
      }))
    });
    
  } catch (error) {
    console.error('Error listando asistentes:', error);
    res.status(500).json({
      error: 'Error listando asistentes',
      details: error.message
    });
  }
});

module.exports = router;