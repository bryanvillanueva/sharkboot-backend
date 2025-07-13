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

    // Guardar en BD local
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

// 3. PATCH /assistants/:id (editar)
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

    // Actualizar en OpenAI usando axios
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

    // Eliminar archivos asociados de la BD local
    await db.execute(
      'DELETE FROM assistant_files WHERE assistant_id=?',
      [id]
    );

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

    // Contar archivos asociados
    const [[fileCount]] = await db.execute(
      'SELECT COUNT(*) as count FROM assistant_files WHERE assistant_id=?',
      [id]
    );

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
      file_count: fileCount.count
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
    // Verificar ownership
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Obtener run
    const runResponse = await axios.get(
      `https://api.openai.com/v1/threads/runs/${runId}`,
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
          `https://api.openai.com/v1/threads/${run.thread_id}/messages?order=desc&limit=10`,
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

    res.json(response);

  } catch (error) {
    console.error('Error obteniendo estado del run:', error);
    if (error.response?.status === 404) {
      res.status(404).json({ error: 'Run no encontrado' });
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
    // Verificar ownership
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Cancelar run
    const response = await axios.post(
      `https://api.openai.com/v1/threads/runs/${runId}/cancel`,
      {},
      { headers: getOpenAIHeaders(true) }
    );
    
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
    // Verificar ownership
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
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
    // Verificar ownership
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
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
    // Verificar ownership
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Eliminar thread
    await axios.delete(
      `https://api.openai.com/v1/threads/${threadId}`,
      { headers: getOpenAIHeaders(true) }
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

module.exports = router;