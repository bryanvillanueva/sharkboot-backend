const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const db = require('../db');
const authGuard = require('../middlewares/authGuard');
const { openai } = require('../helpers/openai'); // Mantenemos para threads/runs

const router = express.Router();

// Headers para las peticiones a OpenAI
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

// 1. POST /assistants (creación)
router.post('/', authGuard, async (req, res) => {
  const { clientId } = req.auth;
  const { name, instructions, model, tool_config } = req.body;

  try {
    // Prepara tool_resources asegurando code_interpreter.file_ids: []
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
    console.error('Error creando asistente:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
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
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!row) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Prepara tool_resources
    let tool_resources = {};
    
    if (tool_config?.code_interpreter) {
      tool_resources.code_interpreter = { file_ids: [] };
    }
    
    if (tool_config?.file_search) {
      // Mantener vector stores existentes si los hay
      const [existingConfig] = await db.execute(
        'SELECT tool_config FROM assistants WHERE id=?',
        [id]
      );
      
      const existing = existingConfig[0]?.tool_config ? 
        JSON.parse(existingConfig[0].tool_config) : {};
        
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

    // Agregar herramientas según configuración
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
    await axios.patch(
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
    console.error('Error actualizando asistente:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
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

// 5. Crear un run (y thread si no existe)
router.post('/:id/runs', authGuard, async (req, res) => {
  const { id } = req.params; // id local
  const { clientId } = req.auth;
  const { thread_id, message, file_ids } = req.body;

  try {
    // Buscar openai_id
    const [[assistant]] = await db.execute(
      'SELECT openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Si no hay thread, créalo usando SDK (más estable para threads)
    let threadId = thread_id;
    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
    }

    // Crear el mensaje en el thread usando SDK
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message,
      file_ids: file_ids || []
    });

    // Crear el run usando SDK
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistant.openai_id
    });

    res.json({ 
      runId: run.id, 
      threadId,
      status: run.status
    });
    
  } catch (error) {
    console.error('Error creando run:', error);
    res.status(500).json({ 
      error: 'Error creando run',
      details: error.message
    });
  }
});

// 6. Obtener el estado y resultado de un run
router.get('/:id/runs/:runId', authGuard, async (req, res) => {
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

    // Obtener run usando SDK (más estable)
    const run = await openai.beta.threads.runs.retrieve(runId);
    
    res.json({
      id: run.id,
      status: run.status,
      created_at: run.created_at,
      completed_at: run.completed_at,
      failed_at: run.failed_at,
      last_error: run.last_error,
      thread_id: run.thread_id
    });
    
  } catch (error) {
    console.error('Error obteniendo run:', error);
    if (error.status === 404) {
      res.status(404).json({ error: 'Run no encontrado' });
    } else {
      res.status(500).json({ 
        error: 'Error obteniendo run',
        details: error.message
      });
    }
  }
});

// 7. Obtener los mensajes del thread asociados al run
router.get('/:id/runs/:runId/messages', authGuard, async (req, res) => {
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

    // Buscar el run para obtener el threadId usando SDK
    const run = await openai.beta.threads.runs.retrieve(runId);
    const threadId = run.thread_id;

    // Listar los mensajes del thread usando SDK
    const messages = await openai.beta.threads.messages.list(threadId, {
      order: 'desc',
      limit: 100
    });

    res.json({
      messages: messages.data,
      thread_id: threadId,
      run_id: runId,
      count: messages.data.length
    });
    
  } catch (error) {
    console.error('Error obteniendo mensajes:', error);
    if (error.status === 404) {
      res.status(404).json({ error: 'Run o thread no encontrado' });
    } else {
      res.status(500).json({ 
        error: 'Error obteniendo mensajes',
        details: error.message
      });
    }
  }
});

// 8. Cancelar un run
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

    // Cancelar run usando SDK
    const run = await openai.beta.threads.runs.cancel(runId);
    
    res.json({
      id: run.id,
      status: run.status,
      cancelled_at: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error cancelando run:', error);
    res.status(500).json({ 
      error: 'Error cancelando run',
      details: error.message
    });
  }
});

// 9. Obtener información detallada de un asistente
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

// ============== RUTAS PARA TESTING DE ASISTENTES (RUNS) ==============

// 10. Crear un thread y enviar mensaje (todo en uno)
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
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      console.log('Nuevo thread creado:', threadId);
    }

    // Agregar mensaje al thread
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message,
      file_ids: file_ids
    });

    // Crear y ejecutar run
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistant.openai_id
    });

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
      details: error.message
    });
  }
});

// 11. Obtener estado detallado de un run con polling
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
    const run = await openai.beta.threads.runs.retrieve(runId);
    
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

    // Si el run está completado, obtener también los mensajes más recientes
    if (run.status === 'completed') {
      try {
        const messages = await openai.beta.threads.messages.list(run.thread_id, {
          order: 'desc',
          limit: 10
        });
        
        // Filtrar solo los mensajes del asistente más recientes
        const assistantMessages = messages.data.filter(msg => 
          msg.role === 'assistant' && 
          msg.created_at >= run.created_at
        );

        response.latest_messages = assistantMessages.map(msg => ({
          id: msg.id,
          content: msg.content,
          created_at: msg.created_at,
          file_ids: msg.file_ids
        }));

      } catch (msgError) {
        console.error('Error obteniendo mensajes:', msgError);
        response.latest_messages = [];
      }
    }

    // Si el run requiere acción, incluir detalles
    if (run.status === 'requires_action') {
      response.required_action = run.required_action;
    }

    res.json(response);

  } catch (error) {
    console.error('Error obteniendo estado del run:', error);
    if (error.status === 404) {
      res.status(404).json({ error: 'Run no encontrado' });
    } else {
      res.status(500).json({
        error: 'Error obteniendo estado del run',
        details: error.message
      });
    }
  }
});

// 12. Obtener conversación completa de un thread
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
    const messages = await openai.beta.threads.messages.list(threadId, {
      order: 'asc', // Orden cronológico
      limit: parseInt(limit)
    });

    // Formatear mensajes para el frontend
    const conversation = messages.data.map(msg => ({
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
      file_ids: msg.file_ids || []
    }));

    res.json({
      thread_id: threadId,
      messages: conversation,
      count: conversation.length,
      has_more: messages.has_more
    });

  } catch (error) {
    console.error('Error obteniendo conversación:', error);
    res.status(500).json({
      error: 'Error obteniendo conversación',
      details: error.message
    });
  }
});

// 13. Enviar mensaje adicional a un thread existente
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

    // Agregar mensaje al thread
    const threadMessage = await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message,
      file_ids: file_ids
    });

    // Crear nuevo run
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistant.openai_id
    });

    res.json({
      message_id: threadMessage.id,
      run_id: run.id,
      thread_id: threadId,
      status: run.status,
      created_at: run.created_at
    });

  } catch (error) {
    console.error('Error enviando mensaje:', error);
    res.status(500).json({
      error: 'Error enviando mensaje',
      details: error.message
    });
  }
});

// 14. Eliminar un thread completo
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
    await openai.beta.threads.del(threadId);

    res.json({
      success: true,
      thread_id: threadId,
      deleted_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error eliminando thread:', error);
    res.status(500).json({
      error: 'Error eliminando thread',
      details: error.message
    });
  }
});

// 15. Obtener información de un thread
router.get('/:id/threads/:threadId', authGuard, async (req, res) => {
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

    // Obtener thread
    const thread = await openai.beta.threads.retrieve(threadId);

    // Obtener conteo de mensajes
    const messages = await openai.beta.threads.messages.list(threadId, { limit: 1 });
    
    res.json({
      id: thread.id,
      created_at: thread.created_at,
      metadata: thread.metadata,
      message_count: messages.data.length,
      last_message_at: messages.data[0]?.created_at
    });

  } catch (error) {
    console.error('Error obteniendo thread:', error);
    if (error.status === 404) {
      res.status(404).json({ error: 'Thread no encontrado' });
    } else {
      res.status(500).json({
        error: 'Error obteniendo thread',
        details: error.message
      });
    }
  }
});

// ============== FIN DE RUTAS PARA TESTING ==============

module.exports = router;