const express   = require('express');
const cors      = require('cors');
const passport  = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;

const authRoutes = require('./routes/auth');
const db         = require('./db');       // tu pool MySQL
const { sign }   = require('./helpers/jwt');
const { db }     = require('./db');

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
      passReqToCallback: true,
    },
    async (req, accessToken, _refreshToken, profile, done) => {
      try {
        done(null, {
          facebookId: profile.id,
          displayName: profile.displayName,
          email: profile.emails?.[0]?.value || null,
          linkToUserId: req.query.state || null,
        });
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
