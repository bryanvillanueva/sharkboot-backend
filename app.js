const express   = require('express');
const cors      = require('cors');
const passport  = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;

const authRoutes = require('./routes/auth');
const db         = require('./db');       // tu pool MySQL
const { sign }   = require('./helpers/jwt');
const openaiRoutes = require('./routes/OpenAI');
const clientRoutes = require('./routes/client');
const fileRoutes = require('./routes/files');
const whatsappRoutes = require('./routes/whatsapp');
const facebookRoutes = require('./routes/facebook');

const app = express();
app.use(cors());
app.use(express.json());
app.use(passport.initialize());

// ✅ Configuración completa de Facebook Strategy
passport.use(
  new FacebookStrategy(
    {
      clientID:     process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      callbackURL:  'https://sharkboot-backend-production.up.railway.app/auth/facebook/callback',
      profileFields: ['id', 'displayName', 'email'],
      passReqToCallback: true, // Permite acceso a req en el callback
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        // Obtener datos del perfil
        const facebookId = profile.id;
        const displayName = profile.displayName;
        const email = profile.emails?.[0]?.value || null;
        
        // Verificar si hay un linkToUserId en el state (para vincular cuentas)
        let linkToUserId = null;
        try {
          if (req.query.state) {
            const stateData = JSON.parse(Buffer.from(req.query.state, 'base64').toString('utf8'));
            linkToUserId = stateData.linkToUserId;
          }
        } catch (parseError) {
          console.log('No se pudo parsear state:', parseError.message);
        }

        done(null, {
          facebookId,
          displayName,
          email,
          linkToUserId,
          accessToken
        });
      } catch (err) {
        return done(err);
      }
    }
  )
);

app.use('/auth', authRoutes);
app.use('/assistants', openaiRoutes);
app.use('/client', clientRoutes);
app.use('/assistants', fileRoutes);
app.use('/whatsapp', whatsappRoutes);
app.use('/facebook', facebookRoutes);

// Ruta prueba
app.get('/', (_, res) => res.json({ ok: true, node: process.version }));

// Puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));