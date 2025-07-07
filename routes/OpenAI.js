const express = require('express');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai').default;
const db = require('../db');
const authGuard = require('../middlewares/authGuard');

const router = express.Router();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1. POST /assistants (creación)
router.post('/', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const { name, instructions, model, tool_config } = req.body;

  try {
    // A) crear en OpenAI
    const oa = await openai.beta.assistants.create({
      model: model || 'gpt-4o-mini',
      name,
      instructions,
      tools: Object.keys(tool_config || {}).map(k => ({ type: k.replace('_','-') })),
      tool_resources: tool_config || undefined,
    });

    // B) guardar en BD
    const localId = uuidv4();
    await db.execute(
      `INSERT INTO assistants
         (id, client_id, openai_id, name, instructions, tool_config)
       VALUES
         (?, ?, ?, ?, ?, ?)`,
      [localId, clientId, oa.id, name, instructions, JSON.stringify(tool_config)]
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
  const { name, instructions } = req.body;

  // A) saca openai_id asegurando que pertenezca al cliente
  const [[row]] = await db.execute(
    'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!row) return res.status(404).json({ error: 'Asistente no encontrado' });

  // B) actualizar en OpenAI
  await openai.beta.assistants.update(row.openai_id, { name, instructions });

  // C) actualizar metadatos locales
  await db.execute(
    'UPDATE assistants SET name=?, instructions=? WHERE id=?',
    [name, instructions, id]
  );

  res.json({ ok: true });
});

// 4. DELETE /assistants/:id (archivar)
router.delete('/:id', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const { id } = req.params;

  const [[row]] = await db.execute(
    'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
    [id, clientId]
  );
  if (!row) return res.status(404).json({ error: 'No existe' });

  // Opcional: await openai.beta.assistants.del(row.openai_id);
  await db.execute('DELETE FROM assistants WHERE id=?', [id]);

  res.json({ ok: true });
});

module.exports = router; 