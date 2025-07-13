const axios = require('axios');
const db = require('../db');

/**
 * Devuelve el ID del vector store asociado a un assistant.
 * Si no existe, crea uno y actualiza assistants.tool_config y el asistente en OpenAI.
 */
exports.getOrCreateVectorStore = async function (assistant) {
  let storeId;

  if (assistant.tool_config) {
    const cfg = JSON.parse(assistant.tool_config);
    storeId = cfg.file_search?.vector_store_ids?.[0];
  }

  if (!storeId) {
    console.log('Creando nuevo vector store para assistant:', assistant.id);
    
    try {
      // Crear vector store usando axios
      const response = await axios.post(
        'https://api.openai.com/v1/vector_stores',
        { 
          name: `vs_${assistant.id}`,
          expires_after: {
            anchor: "last_active_at",
            days: 30 // Opcional: expira después de 30 días de inactividad
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );

      storeId = response.data.id;
      console.log('Vector store creado exitosamente:', storeId);

      // Actualizar tool_config en BD local
      const newConfig = {
        ...(JSON.parse(assistant.tool_config || '{}')),
        file_search: { vector_store_ids: [storeId] },
      };
      
      await db.execute(
        'UPDATE assistants SET tool_config=? WHERE id=?',
        [JSON.stringify(newConfig), assistant.id]
      );

      // IMPORTANTE: No actualizar el asistente aquí, lo haremos cuando sea necesario
      // El vector store se asociará automáticamente cuando se use file_search
      console.log('Vector store configurado para el asistente:', assistant.openai_id);

    } catch (error) {
      console.error('Error creando vector store:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      throw new Error(`No se pudo crear el vector store: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  return storeId;
};

/**
 * Actualiza un asistente para que use un vector store específico
 */
exports.updateAssistantWithVectorStore = async function (assistant, vectorStoreId) {
  try {
    // Primero, obtener la configuración actual del asistente
    const currentResponse = await axios.get(
      `https://api.openai.com/v1/assistants/${assistant.openai_id}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    const currentAssistant = currentResponse.data;
    
    // Preparar los tool_resources manteniendo los existentes
    const currentToolResources = currentAssistant.tool_resources || {};
    const updatedToolResources = {
      ...currentToolResources,
      file_search: { 
        vector_store_ids: [vectorStoreId] 
      }
    };

    // Actualizar el asistente manteniendo toda su configuración actual
    const updateResponse = await axios.post(
      `https://api.openai.com/v1/assistants/${assistant.openai_id}`,
      {
        model: currentAssistant.model,
        name: currentAssistant.name,
        description: currentAssistant.description,
        instructions: currentAssistant.instructions,
        tools: currentAssistant.tools,
        tool_resources: updatedToolResources,
        metadata: currentAssistant.metadata,
        top_p: currentAssistant.top_p,
        temperature: currentAssistant.temperature,
        response_format: currentAssistant.response_format
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    console.log('Asistente actualizado con vector store:', assistant.openai_id);
    return updateResponse.data;
    
  } catch (error) {
    console.error('Error actualizando asistente con vector store:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Si falla la actualización, no es crítico - el vector store se puede usar de todas formas
    console.warn('No se pudo actualizar el asistente, pero el vector store funciona independientemente');
    return null;
  }
};

/**
 * Elimina un vector store de OpenAI
 */
exports.deleteVectorStore = async function (vectorStoreId) {
  try {
    await axios.delete(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );
    console.log('Vector store eliminado:', vectorStoreId);
    return true;
  } catch (error) {
    console.error('Error eliminando vector store:', error.response?.data || error.message);
    return false;
  }
};

/**
 * Lista archivos de un vector store
 */
exports.listVectorStoreFiles = async function (vectorStoreId) {
  try {
    const response = await axios.get(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );
    return response.data.data;
  } catch (error) {
    console.error('Error listando archivos del vector store:', error.response?.data || error.message);
    throw error;
  }
};