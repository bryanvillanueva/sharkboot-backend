const { verify } = require('../helpers/jwt');

module.exports = function authGuard(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s/, '');
  
  if (!token) {
    return res.status(401).json({ 
      error: 'No token provided',
      message: 'Se requiere autenticación para acceder a este recurso'
    });
  }

  try {
    //console.log('🔍 [authGuard] token crudo:', JSON.stringify(token));
    const decoded = verify(token);
    
    // Verificar que el token tenga los campos requeridos
    if (!decoded.userId || !decoded.clientId) {
      return res.status(401).json({ 
        error: 'Invalid token structure',
        message: 'El token no contiene la información requerida'
      });
    }

    // Adjuntar información del usuario al request
    req.auth = {
      userId: decoded.userId,
      clientId: decoded.clientId,
      name: decoded.name || 'Usuario',
      token: token
    };
    
    next();
  } catch (error) {
    console.error('Error verificando token:', error.message);
    
    let errorMessage = 'Token inválido';
    if (error.name === 'TokenExpiredError') {
      errorMessage = 'Token expirado';
    } else if (error.name === 'JsonWebTokenError') {
      errorMessage = 'Token malformado';
    }
    
    return res.status(401).json({ 
      error: 'Invalid token',
      message: errorMessage
    });
  }
};