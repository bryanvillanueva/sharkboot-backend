const express  = require('express');
const cors     = require('cors');
const mysql    = require('mysql2/promise');
const OpenAI   = require('openai').default;          // v5 - importación CJS
const multer   = require('multer');                  // 2.x
const bcrypt   = require('bcryptjs');
const upload   = multer();                           // memoria, cambias luego

// Pool MySQL
const db = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(cors());
app.use(express.json());

// Ruta prueba
app.get('/', (_, res) => res.json({ ok: true, node: process.version }));

// Crear asistente (demo mínimo)
app.post('/assistants', async (req, res) => {
  const { name, instructions } = req.body;
  try {
    const assistant = await openai.beta.assistants.create({
      name, instructions,
      tools: [{ type: 'file_search', vector_store_ids: [process.env.VECTOR_STORE_ID] }],
    });

    // guarda assistant.id en BD…

    res.json({ assistantId: assistant.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'OpenAI error' });
  }
});

// Puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
