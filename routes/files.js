const express  = require('express');
const multer   = require('multer');
const { v4: uuid } = require('uuid');
const db       = require('../db');
const authGuard = require('../middlewares/authGuard');
const { openai } = require('../helpers/openai');
const { getOrCreateVectorStore } = require('../helpers/vectorStore');

const router = express.Router();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

router.use(authGuard);

/* -------- POST /assistants/:id/files  (multipart) -------- */
router.post('/:id/files', upload.array('files'), async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;

  /* 1. Comprueba ownership */
  const [[assistant]] = await db.execute(
    'SELECT id, openai_id, tool_config FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!assistant) return res.status(404).json({ error: 'Asistente no encontrado' });

  /* 2. Crea (o recupera) vector-store */
  const storeId = await getOrCreateVectorStore(assistant);

  const results = [];

  for (const file of req.files) {
    try {
      /* A. Sube a OpenAI como file */
      const uploadResult = await openai.files.create({
        file: new File([file.buffer], file.originalname),  // v5 File API
        purpose: 'assistants',
      });

      /* B. Asocia al vector store */
      await openai.beta.vectorStores.files.create(storeId, { file_id: uploadResult.id });

      /* C. Guarda metadatos locales */
      await db.execute(
        `INSERT INTO assistant_files
           (id, assistant_id, openai_file, filename, bytes)
         VALUES (?, ?, ?, ?, ?)`,
        [uuid(), id, uploadResult.id, file.originalname, file.size]
      );

      results.push({ fileId: uploadResult.id, filename: file.originalname });
    } catch (err) {
      console.error(err);
      results.push({ filename: file.originalname, error: err.message });
    }
  }

  res.json({ success: true, results });
});

/* -------- GET /assistants/:id/files ---------------------- */
router.get('/:id/files', async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;

  /* owner check */
  const [[assistant]] = await db.execute(
    'SELECT id, openai_id, tool_config FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!assistant) return res.status(404).json({ error: 'No existe' });

  /* Si guardas en BD: */
  const [rows] = await db.execute(
    'SELECT openai_file AS fileId, filename, bytes, created_at FROM assistant_files WHERE assistant_id=?',
    [id]
  );
  return res.json(rows);

  /* Si NO guardas en BD:
  const storeId = await getOrCreateVectorStore(assistant);
  const listing = await openai.beta.vectorStores.files.list(storeId);
  res.json(listing.data);
  */
});

/* -------- DELETE /assistants/:id/files/:fileId ----------- */
router.delete('/:id/files/:fileId', async (req, res) => {
  const { id, fileId } = req.params;
  const { clientId } = req.auth;

  const [[assistant]] = await db.execute(
    'SELECT id, openai_id, tool_config FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!assistant) return res.status(404).json({ error: 'Asistente no encontrado' });

  const storeId = await getOrCreateVectorStore(assistant);

  try {
    /* A. Quita del vector store (OpenAI) */
    await openai.beta.vectorStores.files.del(storeId, fileId);

    /* B. Elimina metadatos locales */
    await db.execute('DELETE FROM assistant_files WHERE assistant_id=? AND openai_file=?', [id, fileId]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router; 