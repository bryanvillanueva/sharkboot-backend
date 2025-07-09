const express = require('express');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai').default;
const db = require('../db');
const authGuard = require('../middlewares/authGuard');
const { openai } = require('../helpers/openai');

const router = express.Router();

// 1. POST /assistants (creación)
router.post('/', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const { name, instructions, model, tool_config } = req.body;

  try {
    // Prepara tool_resources asegurando code_interpreter.file_ids: []
    let tool_resources = tool_config || {};
    if (!tool_resources.code_interpreter) {
      tool_resources.code_interpreter = { file_ids: [] };
    } else if (!Array.isArray(tool_resources.code_interpreter.file_ids)) {
      tool_resources.code_interpreter.file_ids = [];
    }

    // A) crear en OpenAI
    const oa = await openai.beta.assistants.create({
      name,
      instructions,
      model: model || 'gpt-4.1-mini',
      tools: [
        { type: "file_search" },
        { type: "code_interpreter" }
      ],
      tool_resources,
    });

    // B) guardar en BD
    const localId = uuidv4();
    await db.execute(
      `INSERT INTO assistants
         (id, client_id, openai_id, name, instructions, tool_config)
       VALUES
         (?, ?, ?, ?, ?, ?)`,
      [localId, clientId, oa.id, name, instructions, JSON.stringify(tool_resources)]
    );

    res.status(201).json({ id: localId, openai_id: oa.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo crear el asistente' });
  }
});

// 2. GET /assistants (listado)
router.get('/', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const [rows] = await db.execute(
    'SELECT id, openai_id, name, instructions FROM assistants WHERE client_id=?',
    [clientId]
  );
  res.json(rows);
});

// 3. PATCH /assistants/:id (editar)
router.patch('/:id', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const { id } = req.params;
  const { name, instructions, tool_config } = req.body;

  // A) saca openai_id asegurando que pertenezca al cliente
  const [[row]] = await db.execute(
    'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!row) return res.status(404).json({ error: 'Asistente no encontrado' });

  // Prepara tool_resources asegurando code_interpreter.file_ids: []
  let tool_resources = tool_config || {};
  if (!tool_resources.code_interpreter) {
    tool_resources.code_interpreter = { file_ids: [] };
  } else if (!Array.isArray(tool_resources.code_interpreter.file_ids)) {
    tool_resources.code_interpreter.file_ids = [];
  }

  // B) actualizar en OpenAI
  await openai.beta.assistants.update(row.openai_id, {
    name,
    instructions,
    tool_resources
  });

  // C) actualizar metadatos locales
  await db.execute(
    'UPDATE assistants SET name=?, instructions=?, tool_config=? WHERE id=?',
    [name, instructions, JSON.stringify(tool_resources), id]
  );

  res.json({ ok: true });
});

// 4. DELETE /assistants/:id (archivar)
router.delete('/:id', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const { id } = req.params;

  // Busca openai_id
  const [[row]] = await db.execute(
    'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!row) return res.status(404).json({ error: 'No existe' });

  // Elimina en OpenAI
  try {
    await openai.beta.assistants.del(row.openai_id);
  } catch (err) {
    // Si ya no existe en OpenAI, continúa con el borrado local
    console.error('Error eliminando en OpenAI:', err.message);
  }

  // Elimina en BD
  await db.execute('DELETE FROM assistants WHERE id=?', [id]);

  res.json({ ok: true });
});

// Crear un run (y thread si no existe)
router.post('/:id/runs', authGuard, async (req, res) => {
  const { id } = req.params; // id local
  const { clientId } = req.auth;
  const { thread_id, message, file_ids } = req.body;

  // Busca openai_id
  const [[assistant]] = await db.execute(
    'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!assistant) return res.status(404).json({ error: 'Asistente no encontrado' });

  // Si no hay thread, créalo
  let threadId = thread_id;
  if (!threadId) {
    const thread = await openai.beta.threads.create();
    threadId = thread.id;
  }

  // Crea el mensaje en el thread
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: message,
    file_ids: file_ids || []
  });

  // Crea el run
  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: assistant.openai_id
  });

  res.json({ runId: run.id, threadId });
});

// Obtener el estado y resultado de un run
router.get('/:id/runs/:runId', authGuard, async (req, res) => {
  const { id, runId } = req.params;
  const { clientId } = req.auth;

  // Busca openai_id
  const [[assistant]] = await db.execute(
    'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!assistant) return res.status(404).json({ error: 'Asistente no encontrado' });

  // Busca el run
  const run = await openai.beta.threads.runs.retrieve(runId);
  res.json(run);
});

// Obtener los mensajes del thread asociados al run
router.get('/:id/runs/:runId/messages', authGuard, async (req, res) => {
  const { id, runId } = req.params;
  const { clientId } = req.auth;

  // Busca openai_id
  const [[assistant]] = await db.execute(
    'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!assistant) return res.status(404).json({ error: 'Asistente no encontrado' });

  // Busca el run para obtener el threadId
  const run = await openai.beta.threads.runs.retrieve(runId);
  const threadId = run.thread_id;

  // Lista los mensajes del thread
  const messages = await openai.beta.threads.messages.list(threadId);
  res.json(messages);
});

module.exports = router; 