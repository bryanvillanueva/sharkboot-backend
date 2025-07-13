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

      // Actualizar el asistente en OpenAI para que use el vector store
      await axios.patch(
        `https://api.openai.com/v1/assistants/${assistant.openai_id}`,
        {
          tool_resources: { 
            file_search: { 
              vector_store_ids: [storeId] 
            } 
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

      console.log('Asistente actualizado con vector store:', assistant.openai_id);

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