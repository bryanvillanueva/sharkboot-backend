const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const db = require('../db');
const authGuard = require('../middlewares/authGuard');

const router = express.Router();

// Headers helper para OpenAI
const getOpenAIHeaders = (includeBeta = false) => {
  const headers = {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  };
  
  if (includeBeta) {
    headers['OpenAI-Beta'] = 'assistants=v2';
  }
  
  return headers;
};

// ============== GESTIÓN DE ASISTENTES ==============

// 1. POST /assistants (creación)
router.post('/', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const { name, instructions, model, tool_config } = req.body;

  try {
    // Preparar tool_resources
    let tool_resources = {};
    
    if (tool_config?.code_interpreter) {
      tool_resources.code_interpreter = { file_ids: [] };
    }
    
    if (tool_config?.file_search) {
      tool_resources.file_search = { vector_store_ids: [] };
    }

    // Crear asistente en OpenAI usando axios
    const assistantData = {
      name,
      instructions,
      model: model || 'gpt-4o-mini',
      tools: []
    };

    // Agregar herramientas según configuración
    if (tool_config?.code_interpreter) {
      assistantData.tools.push({ type: "code_interpreter" });
    }
    if (tool_config?.file_search) {
      assistantData.tools.push({ type: "file_search" });
    }

    if (Object.keys(tool_resources).length > 0) {
      assistantData.tool_resources = tool_resources;
    }

    const response = await axios.post(
      'https://api.openai.com/v1/assistants',
      assistantData,
      { headers: getOpenAIHeaders(true) }
    );

    const openaiAssistant = response.data;

    // Guardar en BD local - usando CHAR(36) para UUIDs
    const localId = uuidv4();
    await db.execute(
      `INSERT INTO assistants
         (id, client_id, openai_id, name, instructions, tool_config)
       VALUES
         (?, ?, ?, ?, ?, ?)`,
      [localId, clientId, openaiAssistant.id, name, instructions, JSON.stringify(tool_config || {})]
    );

    console.log('Asistente creado:', { localId, openaiId: openaiAssistant.id });

    res.status(201).json({ 
      id: localId, 
      openai_id: openaiAssistant.id,
      name,
      instructions
    });
    
  } catch (error) {
    console.error('Error creando asistente:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'No se pudo crear el asistente',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// 2. GET /assistants (listado)
router.get('/', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  
  try {
    const [rows] = await db.execute(
      'SELECT id, openai_id, name, instructions, tool_config, created_at FROM assistants WHERE client_id=? ORDER BY created_at DESC',
      [clientId]
    );
    
    res.json(rows);
  } catch (error) {
    console.error('Error listando asistentes:', error);
    res.status(500).json({ error: 'Error listando asistentes' });
  }
});

// 3. PATCH /assistants/:id (editar) - CORREGIDO
router.patch('/:id', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const { id } = req.params;
  const { name, instructions, tool_config } = req.body;

  try {
    // Verificar ownership
    const [[row]] = await db.execute(
      'SELECT openai_id, tool_config FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!row) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Preparar tool_resources manteniendo vector stores existentes
    let tool_resources = {};
    
    if (tool_config?.code_interpreter) {
      tool_resources.code_interpreter = { file_ids: [] };
    }
    
    if (tool_config?.file_search) {
      const existing = row.tool_config ? JSON.parse(row.tool_config) : {};
      tool_resources.file_search = { 
        vector_store_ids: existing.file_search?.vector_store_ids || [] 
      };
    }

    // Preparar datos para actualización
    const updateData = {
      name,
      instructions,
      tools: []
    };

    if (tool_config?.code_interpreter) {
      updateData.tools.push({ type: "code_interpreter" });
    }
    if (tool_config?.file_search) {
      updateData.tools.push({ type: "file_search" });
    }

    if (Object.keys(tool_resources).length > 0) {
      updateData.tool_resources = tool_resources;
    }

    // ✅ CORREGIDO: Usar POST en lugar de PATCH para modificar asistentes en OpenAI
    await axios.post(
      `https://api.openai.com/v1/assistants/${row.openai_id}`,
      updateData,
      { headers: getOpenAIHeaders(true) }
    );

    // Actualizar en BD local
    await db.execute(
      'UPDATE assistants SET name=?, instructions=?, tool_config=? WHERE id=?',
      [name, instructions, JSON.stringify(tool_config || {}), id]
    );

    console.log('Asistente actualizado:', { localId: id, openaiId: row.openai_id });

    res.json({ 
      success: true,
      id,
      openai_id: row.openai_id
    });
    
  } catch (error) {
    console.error('Error actualizando asistente:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'No se pudo actualizar el asistente',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// 4. DELETE /assistants/:id (eliminar)
router.delete('/:id', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const { id } = req.params;

  try {
    // Buscar openai_id y verificar ownership
    const [[row]] = await db.execute(
      'SELECT openai_id, tool_config FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!row) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Eliminar vector stores asociados si existen
    if (row.tool_config) {
      try {
        const config = JSON.parse(row.tool_config);
        const vectorStoreIds = config.file_search?.vector_store_ids || [];
        
        for (const storeId of vectorStoreIds) {
          try {
            await axios.delete(
              `https://api.openai.com/v1/vector_stores/${storeId}`,
              { headers: getOpenAIHeaders(true) }
            );
            console.log('Vector store eliminado:', storeId);
          } catch (vsError) {
            console.error('Error eliminando vector store:', storeId, vsError.message);
          }
        }
      } catch (parseError) {
        console.error('Error parseando tool_config:', parseError);
      }
    }

    // Eliminar runs asociados de la BD local (se eliminan automáticamente por FK CASCADE)
    await db.execute(
      'DELETE FROM assistant_runs WHERE assistant_id=?',
      [id]
    );

    // Eliminar archivos asociados de la BD local (si existe la tabla)
    try {
      await db.execute(
        'DELETE FROM assistant_files WHERE assistant_id=?',
        [id]
      );
    } catch (fileError) {
      console.log('Tabla assistant_files no existe o ya limpia');
    }

    // Eliminar asistente en OpenAI
    try {
      await axios.delete(
        `https://api.openai.com/v1/assistants/${row.openai_id}`,
        { headers: getOpenAIHeaders(true) }
      );
      console.log('Asistente eliminado de OpenAI:', row.openai_id);
    } catch (openaiError) {
      console.error('Error eliminando asistente de OpenAI:', openaiError.message);
      // Continuar con eliminación local aunque falle en OpenAI
    }

    // Eliminar de BD local
    await db.execute('DELETE FROM assistants WHERE id=?', [id]);

    console.log('Asistente eliminado completamente:', id);

    res.json({ 
      success: true,
      id,
      openai_id: row.openai_id
    });
    
  } catch (error) {
    console.error('Error eliminando asistente:', error);
    res.status(500).json({ 
      error: 'Error eliminando asistente',
      details: error.message
    });
  }
});

// 5. GET /assistants/:id (información detallada)
router.get('/:id', authGuard, async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;

  try {
    // Obtener información local
    const [[assistant]] = await db.execute(
      'SELECT id, openai_id, name, instructions, tool_config, created_at FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Contar archivos asociados (si la tabla existe)
    let fileCount = 0;
    try {
      const [[fileCountResult]] = await db.execute(
        'SELECT COUNT(*) as count FROM assistant_files WHERE assistant_id=?',
        [id]
      );
      fileCount = fileCountResult.count;
    } catch (fileError) {
      console.log('Tabla assistant_files no existe');
    }

    // Parsear tool_config
    let toolConfig = {};
    try {
      toolConfig = assistant.tool_config ? JSON.parse(assistant.tool_config) : {};
    } catch (parseError) {
      console.error('Error parseando tool_config:', parseError);
    }

    res.json({
      ...assistant,
      tool_config: toolConfig,
      file_count: fileCount
    });
    
  } catch (error) {
    console.error('Error obteniendo asistente:', error);
    res.status(500).json({ 
      error: 'Error obteniendo asistente',
      details: error.message
    });
  }
});

// ============== RUNS Y CHAT ==============

// 6. POST /assistants/:id/chat (crear thread + mensaje + run)
router.post('/:id/chat', authGuard, async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;
  const { message, thread_id, file_ids = [] } = req.body;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    let threadId = thread_id;

    // Crear thread si no existe
    if (!threadId) {
      const threadResponse = await axios.post(
        'https://api.openai.com/v1/threads',
        {},
        { headers: getOpenAIHeaders(true) }
      );
      threadId = threadResponse.data.id;
      console.log('Nuevo thread creado:', threadId);
    }

    // Preparar attachments si hay file_ids
    let attachments = [];
    if (file_ids && file_ids.length > 0) {
      attachments = file_ids.map(fileId => ({
        file_id: fileId,
        tools: [{ type: "file_search" }, { type: "code_interpreter" }]
      }));
    }

    // Preparar payload del mensaje
    const messagePayload = {
      role: "user",
      content: message
    };

    if (attachments.length > 0) {
      messagePayload.attachments = attachments;
    }

    // Crear mensaje
    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      messagePayload,
      { headers: getOpenAIHeaders(true) }
    );

    // Crear y ejecutar run
    const runResponse = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      { assistant_id: assistant.openai_id },
      { headers: getOpenAIHeaders(true) }
    );

    const run = runResponse.data;

    // ✅ GUARDAR información del run en la base de datos
    try {
      const runUuid = uuidv4(); // Generar UUID para el ID de la tabla
      await db.execute(
        'INSERT INTO assistant_runs (id, assistant_id, client_id, thread_id, run_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        [runUuid, id, clientId, threadId, run.id, run.status]
      );
      console.log('Run guardado en BD:', { 
        runTableId: runUuid,
        runId: run.id, 
        threadId,
        assistantId: id,
        clientId 
      });
    } catch (dbError) {
      console.error('Error guardando run en BD:', dbError);
      // Continuar aunque falle el guardado en BD
    }

    console.log('Run creado:', {
      runId: run.id,
      threadId: threadId,
      status: run.status
    });

    res.json({
      thread_id: threadId,
      run_id: run.id,
      status: run.status,
      created_at: run.created_at
    });

  } catch (error) {
    console.error('Error en chat:', error);
    res.status(500).json({
      error: 'Error procesando mensaje',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// 7. GET /assistants/:id/runs/:runId/status (polling de estado)
router.get('/:id/runs/:runId/status', authGuard, async (req, res) => {
  const { id, runId } = req.params;
  const { clientId } = req.auth;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // ✅ OBTENER thread_id desde la base de datos
    const [[runInfo]] = await db.execute(
      'SELECT thread_id FROM assistant_runs WHERE run_id=? AND client_id=? AND assistant_id=?',
      [runId, clientId, id]
    );
    
    if (!runInfo) {
      return res.status(404).json({ 
        error: 'Run no encontrado',
        details: 'El run no existe o no pertenece a este cliente/asistente'
      });
    }

    const threadId = runInfo.thread_id;

    // ✅ OBTENER run usando el endpoint correcto
    const runResponse = await axios.get(
      `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
      { headers: getOpenAIHeaders(true) }
    );

    const run = runResponse.data;
    
    let response = {
      id: run.id,
      status: run.status,
      created_at: run.created_at,
      started_at: run.started_at,
      completed_at: run.completed_at,
      failed_at: run.failed_at,
      cancelled_at: run.cancelled_at,
      expires_at: run.expires_at,
      thread_id: run.thread_id,
      assistant_id: run.assistant_id,
      model: run.model,
      instructions: run.instructions,
      usage: run.usage,
      last_error: run.last_error
    };

    // Si el run está completado, obtener mensajes más recientes
    if (run.status === 'completed') {
      try {
        const messagesResponse = await axios.get(
          `https://api.openai.com/v1/threads/${threadId}/messages?order=desc&limit=10`,
          { headers: getOpenAIHeaders(true) }
        );
        
        const assistantMessages = messagesResponse.data.data.filter(msg => 
          msg.role === 'assistant' && 
          msg.created_at >= run.created_at
        );

        response.latest_messages = assistantMessages.map(msg => ({
          id: msg.id,
          content: msg.content,
          created_at: msg.created_at,
          attachments: msg.attachments || []
        }));

      } catch (msgError) {
        console.error('Error obteniendo mensajes:', msgError);
        response.latest_messages = [];
      }
    }

    if (run.status === 'requires_action') {
      response.required_action = run.required_action;
    }

    // ✅ ACTUALIZAR estado en la base de datos
    try {
      await db.execute(
        'UPDATE assistant_runs SET status=?, updated_at=CURRENT_TIMESTAMP WHERE run_id=? AND client_id=?',
        [run.status, runId, clientId]
      );
    } catch (dbError) {
      console.error('Error actualizando estado del run:', dbError);
    }

    res.json(response);

  } catch (error) {
    console.error('Error obteniendo estado del run:', error);
    if (error.response?.status === 404) {
      res.status(404).json({ error: 'Run no encontrado en OpenAI' });
    } else {
      res.status(500).json({
        error: 'Error obteniendo estado del run',
        details: error.response?.data?.error?.message || error.message
      });
    }
  }
});

// 8. POST /assistants/:id/runs/:runId/cancel (cancelar run)
router.post('/:id/runs/:runId/cancel', authGuard, async (req, res) => {
  const { id, runId } = req.params;
  const { clientId } = req.auth;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // ✅ OBTENER thread_id desde la base de datos
    const [[runInfo]] = await db.execute(
      'SELECT thread_id FROM assistant_runs WHERE run_id=? AND client_id=? AND assistant_id=?',
      [runId, clientId, id]
    );
    
    if (!runInfo) {
      return res.status(404).json({ 
        error: 'Run no encontrado',
        details: 'El run no existe o no pertenece a este cliente/asistente'
      });
    }

    const threadId = runInfo.thread_id;

    // ✅ CANCELAR run usando el endpoint correcto
    const response = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs/${runId}/cancel`,
      {},
      { headers: getOpenAIHeaders(true) }
    );
    
    // ✅ ACTUALIZAR estado en la base de datos
    try {
      await db.execute(
        'UPDATE assistant_runs SET status=?, updated_at=CURRENT_TIMESTAMP WHERE run_id=? AND client_id=?',
        ['cancelled', runId, clientId]
      );
    } catch (dbError) {
      console.error('Error actualizando estado del run:', dbError);
    }
    
    res.json({
      id: response.data.id,
      status: response.data.status,
      cancelled_at: response.data.cancelled_at
    });
    
  } catch (error) {
    console.error('Error cancelando run:', error);
    res.status(500).json({ 
      error: 'Error cancelando run',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// 9. GET /assistants/:id/threads/:threadId/conversation (conversación completa)
router.get('/:id/threads/:threadId/conversation', authGuard, async (req, res) => {
  const { id, threadId } = req.params;
  const { clientId } = req.auth;
  const { limit = 50 } = req.query;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Verificar que el thread pertenece al cliente y asistente
    const [[threadCheck]] = await db.execute(
      'SELECT id FROM assistant_runs WHERE thread_id=? AND client_id=? AND assistant_id=? LIMIT 1',
      [threadId, clientId, id]
    );
    if (!threadCheck) {
      return res.status(404).json({ error: 'Thread no encontrado o sin acceso' });
    }

    // Obtener mensajes del thread
    const messagesResponse = await axios.get(
      `https://api.openai.com/v1/threads/${threadId}/messages?order=asc&limit=${limit}`,
      { headers: getOpenAIHeaders(true) }
    );

    // Formatear mensajes para el frontend
    const conversation = messagesResponse.data.data.map(msg => ({
      id: msg.id,
      role: msg.role,
      content: msg.content.map(content => {
        if (content.type === 'text') {
          return {
            type: 'text',
            text: content.text.value,
            annotations: content.text.annotations
          };
        } else if (content.type === 'image_file') {
          return {
            type: 'image',
            file_id: content.image_file.file_id
          };
        }
        return content;
      }),
      created_at: msg.created_at,
      attachments: msg.attachments || []
    }));

    res.json({
      thread_id: threadId,
      messages: conversation,
      count: conversation.length,
      has_more: messagesResponse.data.has_more
    });

  } catch (error) {
    console.error('Error obteniendo conversación:', error);
    res.status(500).json({
      error: 'Error obteniendo conversación',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// 10. POST /assistants/:id/threads/:threadId/messages (enviar mensaje adicional)
router.post('/:id/threads/:threadId/messages', authGuard, async (req, res) => {
  const { id, threadId } = req.params;
  const { clientId } = req.auth;
  const { message, file_ids = [] } = req.body;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Verificar que el thread pertenece al cliente y asistente
    const [[threadCheck]] = await db.execute(
      'SELECT id FROM assistant_runs WHERE thread_id=? AND client_id=? AND assistant_id=? LIMIT 1',
      [threadId, clientId, id]
    );
    if (!threadCheck) {
      return res.status(404).json({ error: 'Thread no encontrado o sin acceso' });
    }

    // Preparar attachments si hay file_ids
    let attachments = [];
    if (file_ids && file_ids.length > 0) {
      attachments = file_ids.map(fileId => ({
        file_id: fileId,
        tools: [{ type: "file_search" }, { type: "code_interpreter" }]
      }));
    }

    // Preparar payload del mensaje
    const messagePayload = {
      role: "user",
      content: message
    };

    if (attachments.length > 0) {
      messagePayload.attachments = attachments;
    }

    // Agregar mensaje al thread
    const messageResponse = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      messagePayload,
      { headers: getOpenAIHeaders(true) }
    );

    // Crear nuevo run
    const runResponse = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      { assistant_id: assistant.openai_id },
      { headers: getOpenAIHeaders(true) }
    );

    // ✅ GUARDAR nuevo run en la base de datos
    try {
      const runUuid = uuidv4();
      await db.execute(
        'INSERT INTO assistant_runs (id, assistant_id, client_id, thread_id, run_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        [runUuid, id, clientId, threadId, runResponse.data.id, runResponse.data.status]
      );
      console.log('Nuevo run guardado en BD:', { 
        runTableId: runUuid,
        runId: runResponse.data.id, 
        threadId 
      });
    } catch (dbError) {
      console.error('Error guardando nuevo run en BD:', dbError);
    }

    res.json({
      message_id: messageResponse.data.id,
      run_id: runResponse.data.id,
      thread_id: threadId,
      status: runResponse.data.status,
      created_at: runResponse.data.created_at
    });

  } catch (error) {
    console.error('Error enviando mensaje:', error);
    res.status(500).json({
      error: 'Error enviando mensaje',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// 11. DELETE /assistants/:id/threads/:threadId (eliminar thread completo)
router.delete('/:id/threads/:threadId', authGuard, async (req, res) => {
  const { id, threadId } = req.params;
  const { clientId } = req.auth;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Verificar que el thread pertenece al cliente y asistente
    const [[threadCheck]] = await db.execute(
      'SELECT id FROM assistant_runs WHERE thread_id=? AND client_id=? AND assistant_id=? LIMIT 1',
      [threadId, clientId, id]
    );
    if (!threadCheck) {
      return res.status(404).json({ error: 'Thread no encontrado o sin acceso' });
    }

    // Eliminar thread de OpenAI
    await axios.delete(
      `https://api.openai.com/v1/threads/${threadId}`,
      { headers: getOpenAIHeaders(true) }
    );

    // ✅ ELIMINAR runs asociados de la base de datos
    await db.execute(
      'DELETE FROM assistant_runs WHERE thread_id=? AND client_id=? AND assistant_id=?',
      [threadId, clientId, id]
    );

    res.json({
      success: true,
      thread_id: threadId,
      deleted_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error eliminando thread:', error);
    res.status(500).json({
      error: 'Error eliminando thread',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

// ============== RUTAS ADICIONALES DE UTILIDAD ==============

// 12. GET /assistants/:id/runs (listar runs de un asistente)
router.get('/:id/runs', authGuard, async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;
  const { limit = 20, status } = req.query;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Construir query con filtro opcional de status
    let query = 'SELECT * FROM assistant_runs WHERE assistant_id=? AND client_id=?';
    let params = [id, clientId];
    
    if (status) {
      query += ' AND status=?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit));

    const [runs] = await db.execute(query, params);

    res.json({
      runs,
      count: runs.length,
      assistant_id: id
    });

  } catch (error) {
    console.error('Error listando runs:', error);
    res.status(500).json({
      error: 'Error listando runs',
      details: error.message
    });
  }
});

// 13. GET /assistants/:id/threads (listar threads únicos de un asistente)
router.get('/:id/threads', authGuard, async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Obtener threads únicos con información del último run
    const [threads] = await db.execute(`
      SELECT 
        thread_id,
        COUNT(*) as run_count,
        MAX(created_at) as last_activity,
        MAX(CASE WHEN status = 'completed' THEN updated_at END) as last_completed,
        GROUP_CONCAT(DISTINCT status) as statuses
      FROM assistant_runs 
      WHERE assistant_id=? AND client_id=? 
      GROUP BY thread_id 
      ORDER BY last_activity DESC
    `, [id, clientId]);

    res.json({
      threads: threads.map(thread => ({
        thread_id: thread.thread_id,
        run_count: thread.run_count,
        last_activity: thread.last_activity,
        last_completed: thread.last_completed,
        statuses: thread.statuses ? thread.statuses.split(',') : []
      })),
      count: threads.length,
      assistant_id: id
    });

  } catch (error) {
    console.error('Error listando threads:', error);
    res.status(500).json({
      error: 'Error listando threads',
      details: error.message
    });
  }
});

// 14. DELETE /assistants/:id/runs/:runId (eliminar run específico - solo de BD local)
router.delete('/:id/runs/:runId', authGuard, async (req, res) => {
  const { id, runId } = req.params;
  const { clientId } = req.auth;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Eliminar run de la BD local (OpenAI no permite eliminar runs)
    const [result] = await db.execute(
      'DELETE FROM assistant_runs WHERE run_id=? AND client_id=? AND assistant_id=?',
      [runId, clientId, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Run no encontrado' });
    }

    res.json({
      success: true,
      run_id: runId,
      deleted_from_local_db: true,
      note: 'Run eliminado de la base de datos local. Los runs no se pueden eliminar de OpenAI.'
    });

  } catch (error) {
    console.error('Error eliminando run:', error);
    res.status(500).json({
      error: 'Error eliminando run',
      details: error.message
    });
  }
});

// 15. POST /assistants/:id/runs/:runId/cleanup (limpiar runs completados antiguos)
router.post('/:id/cleanup-runs', authGuard, async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;
  const { days_old = 7, status = 'completed' } = req.body;

  try {
    // Verificar ownership del asistente
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Eliminar runs antiguos con el status especificado
    const [result] = await db.execute(`
      DELETE FROM assistant_runs 
      WHERE assistant_id=? AND client_id=? AND status=? 
      AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [id, clientId, status, days_old]);

    res.json({
      success: true,
      deleted_runs: result.affectedRows,
      criteria: {
        assistant_id: id,
        status,
        older_than_days: days_old
      }
    });

  } catch (error) {
    console.error('Error limpiando runs:', error);
    res.status(500).json({
      error: 'Error limpiando runs',
      details: error.message
    });
  }
});

module.exports = router;