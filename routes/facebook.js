const express = require('express');
const axios = require('axios');
const db = require('../db');
const authGuard = require('../middlewares/authGuard');

const router = express.Router();

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

// Helper para hacer llamadas a Graph API con manejo de errores
async function callGraphAPI(url, accessToken, description = '') {
  try {
    console.log(`📡 Graph API: ${description} - ${url}`);
    const response = await axios.get(url, {
      params: { access_token: accessToken },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error(`❌ Error en Graph API (${description}):`, error.response?.data || error.message);
    throw new Error(`Error obteniendo ${description}: ${error.response?.data?.error?.message || error.message}`);
  }
}

// ============== ENDPOINTS PRINCIPALES ==============

// 1. GET /facebook/profile - Obtener perfil básico del usuario
router.get('/profile', authGuard, async (req, res) => {
  const { userId } = req.auth;
  
  try {
    const accessToken = await getFacebookToken(userId);
    
    const profile = await callGraphAPI(
      'https://graph.facebook.com/v23.0/me?fields=id,name,email,picture.width(200).height(200)',
      accessToken,
      'perfil básico'
    );
    
    res.json({
      profile: {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        picture_url: profile.picture?.data?.url || null
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo perfil Facebook:', error);
    res.status(500).json({
      error: 'Error obteniendo perfil de Facebook',
      details: error.message
    });
  }
});

// 2. GET /facebook/pages - Obtener páginas del usuario
router.get('/pages', authGuard, async (req, res) => {
  const { userId } = req.auth;
  
  try {
    const accessToken = await getFacebookToken(userId);
    
    const pagesData = await callGraphAPI(
      'https://graph.facebook.com/v23.0/me/accounts?fields=id,name,category,access_token',
      accessToken,
      'páginas del usuario'
    );
    
    const pages = pagesData.data?.map(page => ({
      id: page.id,
      name: page.name,
      category: page.category,
      has_access_token: !!page.access_token
    })) || [];
    
    res.json({
      pages,
      total: pages.length
    });
    
  } catch (error) {
    console.error('Error obteniendo páginas Facebook:', error);
    res.status(500).json({
      error: 'Error obteniendo páginas de Facebook',
      details: error.message
    });
  }
});

// 3. GET /facebook/businesses - Obtener negocios del usuario
router.get('/businesses', authGuard, async (req, res) => {
  const { userId } = req.auth;
  
  try {
    const accessToken = await getFacebookToken(userId);
    
    const businessesData = await callGraphAPI(
      'https://graph.facebook.com/v23.0/me/businesses?fields=id,name,verification_status',
      accessToken,
      'negocios del usuario'
    );
    
    const businesses = businessesData.data?.map(business => ({
      id: business.id,
      name: business.name,
      verification_status: business.verification_status
    })) || [];
    
    res.json({
      businesses,
      total: businesses.length
    });
    
  } catch (error) {
    console.error('Error obteniendo negocios Facebook:', error);
    res.status(500).json({
      error: 'Error obteniendo negocios de Facebook',
      details: error.message
    });
  }
});

// 4. GET /facebook/business/:businessId/assets - Obtener activos de un negocio
router.get('/business/:businessId/assets', authGuard, async (req, res) => {
  const { userId } = req.auth;
  const { businessId } = req.params;
  
  try {
    const accessToken = await getFacebookToken(userId);
    
    // Obtener activos en paralelo
    const [adAccounts, pages, instagramAccounts, whatsappAccounts] = await Promise.allSettled([
      // Ad Accounts
      callGraphAPI(
        `https://graph.facebook.com/v23.0/${businessId}/owned_ad_accounts?fields=id,name,currency,timezone_id,account_status`,
        accessToken,
        'cuentas publicitarias'
      ),
      // Páginas
      callGraphAPI(
        `https://graph.facebook.com/v23.0/${businessId}/owned_pages?fields=id,name,category`,
        accessToken,
        'páginas del negocio'
      ),
      // Instagram Business
      callGraphAPI(
        `https://graph.facebook.com/v23.0/${businessId}/owned_instagram_accounts?fields=id,username,name`,
        accessToken,
        'cuentas Instagram'
      ),
      // WABA
      callGraphAPI(
        `https://graph.facebook.com/v23.0/${businessId}/owned_whatsapp_business_accounts?fields=id,name`,
        accessToken,
        'cuentas WhatsApp Business'
      )
    ]);
    
    const assets = {
      ad_accounts: adAccounts.status === 'fulfilled' ? (adAccounts.value.data || []) : [],
      pages: pages.status === 'fulfilled' ? (pages.value.data || []) : [],
      instagram_accounts: instagramAccounts.status === 'fulfilled' ? (instagramAccounts.value.data || []) : [],
      whatsapp_accounts: whatsappAccounts.status === 'fulfilled' ? (whatsappAccounts.value.data || []) : []
    };
    
    // Log errores si los hay
    [adAccounts, pages, instagramAccounts, whatsappAccounts].forEach((result, index) => {
      if (result.status === 'rejected') {
        const assetTypes = ['ad_accounts', 'pages', 'instagram_accounts', 'whatsapp_accounts'];
        console.error(`⚠️ Error obteniendo ${assetTypes[index]}:`, result.reason.message);
      }
    });
    
    res.json({
      business_id: businessId,
      assets,
      summary: {
        ad_accounts_count: assets.ad_accounts.length,
        pages_count: assets.pages.length,
        instagram_accounts_count: assets.instagram_accounts.length,
        whatsapp_accounts_count: assets.whatsapp_accounts.length
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo activos del negocio:', error);
    res.status(500).json({
      error: 'Error obteniendo activos del negocio',
      details: error.message
    });
  }
});

// 5. GET /facebook/whatsapp/:wabaId/numbers - Obtener números de una WABA
router.get('/whatsapp/:wabaId/numbers', authGuard, async (req, res) => {
  const { userId } = req.auth;
  const { wabaId } = req.params;
  
  try {
    const accessToken = await getFacebookToken(userId);
    
    const numbersData = await callGraphAPI(
      `https://graph.facebook.com/v23.0/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status`,
      accessToken,
      `números WhatsApp de WABA ${wabaId}`
    );
    
    const numbers = numbersData.data?.map(number => ({
      id: number.id,
      display_phone_number: number.display_phone_number,
      verified_name: number.verified_name,
      verification_status: number.code_verification_status
    })) || [];
    
    res.json({
      waba_id: wabaId,
      numbers,
      total: numbers.length
    });
    
  } catch (error) {
    console.error('Error obteniendo números WhatsApp:', error);
    res.status(500).json({
      error: 'Error obteniendo números de WhatsApp',
      details: error.message
    });
  }
});

// 6. GET /facebook/token-info - Obtener información del token
router.get('/token-info', authGuard, async (req, res) => {
  const { userId } = req.auth;
  
  try {
    const accessToken = await getFacebookToken(userId);
    
    // Verificar token y obtener permisos
    const [tokenDebug, permissions] = await Promise.allSettled([
      callGraphAPI(
        `https://graph.facebook.com/v23.0/debug_token?input_token=${accessToken}&access_token=${process.env.FACEBOOK_APP_ID}|${process.env.FACEBOOK_APP_SECRET}`,
        null,
        'información del token'
      ),
      callGraphAPI(
        'https://graph.facebook.com/v23.0/me/permissions',
        accessToken,
        'permisos del usuario'
      )
    ]);
    
    const tokenInfo = tokenDebug.status === 'fulfilled' ? tokenDebug.value.data : null;
    const userPermissions = permissions.status === 'fulfilled' ? permissions.value.data : [];
    
    const grantedPermissions = userPermissions
      .filter(perm => perm.status === 'granted')
      .map(perm => perm.permission);
    
    res.json({
      token_valid: !!tokenInfo?.is_valid,
      expires_at: tokenInfo?.expires_at ? new Date(tokenInfo.expires_at * 1000).toISOString() : null,
      scopes: grantedPermissions,
      app_id: tokenInfo?.app_id,
      user_id: tokenInfo?.user_id
    });
    
  } catch (error) {
    console.error('Error obteniendo info del token:', error);
    res.status(500).json({
      error: 'Error obteniendo información del token',
      details: error.message
    });
  }
});

// 7. GET /facebook/whatsapp-sync - Sincronizar números WhatsApp con BD local
router.get('/whatsapp-sync', authGuard, async (req, res) => {
  const { userId, clientId } = req.auth;
  
  try {
    const accessToken = await getFacebookToken(userId);
    
    // Obtener negocios
    const businessesData = await callGraphAPI(
      'https://graph.facebook.com/v23.0/me/businesses?fields=id,name',
      accessToken,
      'negocios para sync'
    );
    
    let syncedNumbers = [];
    let errors = [];
    
    // Para cada negocio, obtener WABAs y números
    for (const business of businessesData.data || []) {
      try {
        const wabasData = await callGraphAPI(
          `https://graph.facebook.com/v23.0/${business.id}/owned_whatsapp_business_accounts?fields=id,name`,
          accessToken,
          `WABAs del negocio ${business.name}`
        );
        
        for (const waba of wabasData.data || []) {
          try {
            const numbersData = await callGraphAPI(
              `https://graph.facebook.com/v23.0/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status`,
              accessToken,
              `números de WABA ${waba.name}`
            );
            
            // Comparar con números locales
            const [localNumbers] = await db.execute(
              'SELECT phone_number_id, phone_number, display_name FROM whatsapp_numbers WHERE client_id = ?',
              [clientId]
            );
            
            const localNumbersMap = new Map(
              localNumbers.map(num => [num.phone_number_id, num])
            );
            
            for (const number of numbersData.data || []) {
              const localNumber = localNumbersMap.get(number.id);
              
              syncedNumbers.push({
                phone_number_id: number.id,
                display_phone_number: number.display_phone_number,
                verified_name: number.verified_name,
                verification_status: number.code_verification_status,
                waba_id: waba.id,
                waba_name: waba.name,
                business_name: business.name,
                in_local_db: !!localNumber,
                local_display_name: localNumber?.display_name || null
              });
            }
            
          } catch (numberError) {
            errors.push(`Error obteniendo números de WABA ${waba.name}: ${numberError.message}`);
          }
        }
        
      } catch (wabaError) {
        errors.push(`Error obteniendo WABAs de ${business.name}: ${wabaError.message}`);
      }
    }
    
    res.json({
      synced_numbers: syncedNumbers,
      total_remote: syncedNumbers.length,
      total_local: syncedNumbers.filter(num => num.in_local_db).length,
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    console.error('Error sincronizando WhatsApp:', error);
    res.status(500).json({
      error: 'Error sincronizando números de WhatsApp',
      details: error.message
    });
  }
});

module.exports = router;