const express   = require('express');
const cors      = require('cors');
const passport  = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;

const authRoutes = require('./routes/auth');
const db         = require('./db');       // tu pool MySQL
const { sign }   = require('./helpers/jwt');

const app = express();
app.use(cors());
app.use(express.json());
app.use(passport.initialize());

passport.use(
  new FacebookStrategy(
    {
      clientID:     process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      callbackURL:  'https://sharkboot-backend-production.up.railway.app/auth/facebook/callback',
      profileFields: ['id', 'displayName', 'email'],
    },
    async (accessToken, _refreshToken, profile, done) => {
      try {
        // 1️⃣ Busca o crea cliente/usuario
        const [{ length }] = await db.execute(
          'SELECT id FROM users WHERE provider="FACEBOOK" AND provider_id=?',
          [profile.id]
        );

        let userId, clientId;
        if (length) {
          // Usuario ya existe
          const [[user]] = await db.execute(
            'SELECT id, client_id FROM users WHERE provider="FACEBOOK" AND provider_id=?',
            [profile.id]
          );
          userId = user.id;
          clientId = user.client_id;
        } else {
          // Crea client + user
          const [cRes] = await db.execute(
            'INSERT INTO clients (id, name) VALUES (UUID(), ?)',
            [`Cliente ${profile.displayName}`]
          );
          clientId = cRes.insertId;

          const [uRes] = await db.execute(
            `INSERT INTO users (id, client_id, provider, provider_id, name)
             VALUES (UUID(), ?, 'FACEBOOK', ?, ?)`,
            [clientId, profile.id, profile.displayName]
          );
          userId = uRes.insertId;
        }

        // 2️⃣ Genera JWT
        const token = sign({ userId, clientId, name: profile.displayName });
        return done(null, { token });
      } catch (err) {
        return done(err);
      }
    }
  )
);

app.use('/auth', authRoutes);

// Ruta prueba
app.get('/', (_, res) => res.json({ ok: true, node: process.version }));

// Puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
