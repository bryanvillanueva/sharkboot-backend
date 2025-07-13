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

      /* B. Asocia al vector store - API corregida para v5 */
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
    /* A. Quita del vector store (OpenAI) - API corregida para v5 */
    await openai.beta.vectorStores.files.del(storeId, fileId);

    /* B. Elimina metadatos locales */
    await db.execute('DELETE FROM assistant_files WHERE assistant_id=? AND openai_file=?', [id, fileId]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----------- CODE INTERPRETER: SUBIR ARCHIVOS DE ENTRADA PARA UN RUN -----------
// POST /assistants/:id/runs/:runId/files (archivos de entrada para Code Interpreter)
router.post('/:id/runs/:runId/files', upload.array('files'), async (req, res) => {
  const { id, runId } = req.params;
  const { clientId } = req.auth;

  // Verifica ownership
  const [[assistant]] = await db.execute(
    'SELECT id, openai_id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!assistant) return res.status(404).json({ error: 'Asistente no encontrado' });

  // Sube cada archivo a OpenAI y asócialo al thread/run
  const fileIds = [];
  for (const file of req.files) {
    const uploadResult = await openai.files.create({
      file: new File([file.buffer], file.originalname),
      purpose: 'assistants',
    });
    fileIds.push(uploadResult.id);
  }

  // El frontend debe usar estos fileIds para asociarlos al thread/message/run
  res.json({ fileIds });
});

// ----------- CODE INTERPRETER: LISTAR ARCHIVOS DE SALIDA DE UN RUN -----------
// GET /assistants/:id/runs/:runId/files (archivos de salida generados por Code Interpreter)
router.get('/:id/runs/:runId/files', async (req, res) => {
  const { id, runId } = req.params;
  const { clientId } = req.auth;

  // Verifica ownership
  const [[assistant]] = await db.execute(
    'SELECT id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!assistant) return res.status(404).json({ error: 'Asistente no encontrado' });

  const [rows] = await db.execute(
    'SELECT file_id, filename, bytes, created_at, thumb_url FROM assistant_run_files WHERE assistant_id=? AND run_id=?',
    [id, runId]
  );
  res.json(rows);
});

// ----------- CODE INTERPRETER: DESCARGAR ARCHIVO DE SALIDA DE UN RUN -----------
// GET /assistants/:id/runs/:runId/files/:fileId
router.get('/:id/runs/:runId/files/:fileId', async (req, res) => {
  const { id, runId, fileId } = req.params;
  const { clientId } = req.auth;

  // Verifica ownership
  const [[assistant]] = await db.execute(
    'SELECT id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!assistant) return res.status(404).json({ error: 'Asistente no encontrado' });

  // Busca metadatos
  const [[fileRow]] = await db.execute(
    'SELECT filename FROM assistant_run_files WHERE assistant_id=? AND run_id=? AND file_id=?',
    [id, runId, fileId]
  );
  if (!fileRow) return res.status(404).json({ error: 'Archivo no encontrado' });

  // Descarga el archivo desde OpenAI
  const fileStream = await openai.files.retrieveContent(fileId);
  res.setHeader('Content-Disposition', `attachment; filename="${fileRow.filename}"`);
  fileStream.pipe(res);
});

module.exports = router;