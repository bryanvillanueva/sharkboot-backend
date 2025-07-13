const axios = require('axios');
const db = require('../db');

/**
 * Devuelve el ID del vector store asociado a un assistant.
 * Si no existe, crea uno y actualiza assistants.tool_config y el asistente en OpenAI.
 */
exports.getOrCreateVectorStore = async function (assistant) {
  let storeId;

  console.log('🔍 Verificando vector store para asistente:', assistant.id);
  
  // Primero, verificar en la BD local si ya tenemos un vector store asignado
  if (assistant.tool_config) {
    try {
      const cfg = JSON.parse(assistant.tool_config);
      storeId = cfg.file_search?.vector_store_ids?.[0];
      
      if (storeId) {
        console.log('📁 Vector store encontrado en BD local:', storeId);
        
        // Verificar que el vector store realmente existe en OpenAI
        try {
          const response = await axios.get(
            `https://api.openai.com/v1/vector_stores/${storeId}`,
            {
              headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'OpenAI-Beta': 'assistants=v2'
              }
            }
          );
          
          console.log('✅ Vector store confirmado en OpenAI:', {
            id: response.data.id,
            name: response.data.name,
            file_counts: response.data.file_counts
          });
          
          return storeId;
          
        } catch (verifyError) {
          console.warn('⚠️ Vector store no existe en OpenAI, creando uno nuevo:', verifyError.response?.status);
          storeId = null; // Forzar creación de uno nuevo
        }
      }
    } catch (parseError) {
      console.error('Error parseando tool_config:', parseError);
    }
  }

  // Si no hay vector store o no existe en OpenAI, crear uno nuevo
  if (!storeId) {
    console.log('🆕 Creando nuevo vector store para assistant:', assistant.id);
    
    try {
      // Crear vector store usando axios
      const response = await axios.post(
        'https://api.openai.com/v1/vector_stores',
        { 
          name: `Assistant_${assistant.id}_VectorStore`,
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
      console.log('✅ Vector store creado exitosamente:', {
        id: storeId,
        name: response.data.name
      });

      // Actualizar tool_config en BD local inmediatamente
      const newConfig = {
        ...(JSON.parse(assistant.tool_config || '{}')),
        file_search: { vector_store_ids: [storeId] },
      };
      
      await db.execute(
        'UPDATE assistants SET tool_config=? WHERE id=?',
        [JSON.stringify(newConfig), assistant.id]
      );

      console.log('💾 Configuración guardada en BD local');

    } catch (error) {
      console.error('❌ Error creando vector store:', {
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
    console.log('Actualizando asistente para usar vector store:', { assistantId: assistant.openai_id, vectorStoreId });
    
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
    console.log('Configuración actual del asistente:', {
      tools: currentAssistant.tools,
      current_tool_resources: currentAssistant.tool_resources
    });
    
    // Preparar las herramientas asegurando que file_search esté incluida
    let tools = currentAssistant.tools || [];
    const hasFileSearch = tools.some(tool => tool.type === 'file_search');
    
    if (!hasFileSearch) {
      tools.push({ type: 'file_search' });
      console.log('Agregando herramienta file_search al asistente');
    }
    
    // Preparar los tool_resources manteniendo los existentes
    const currentToolResources = currentAssistant.tool_resources || {};
    const updatedToolResources = {
      ...currentToolResources,
      file_search: { 
        vector_store_ids: [vectorStoreId] 
      }
    };

    // Preparar datos mínimos necesarios para la actualización
    const updateData = {
      name: currentAssistant.name,
      instructions: currentAssistant.instructions,
      model: currentAssistant.model,
      tools: tools,
      tool_resources: updatedToolResources
    };

    // Solo incluir campos que no sean null/undefined
    if (currentAssistant.description) updateData.description = currentAssistant.description;
    if (currentAssistant.metadata) updateData.metadata = currentAssistant.metadata;
    if (currentAssistant.top_p !== null && currentAssistant.top_p !== undefined) updateData.top_p = currentAssistant.top_p;
    if (currentAssistant.temperature !== null && currentAssistant.temperature !== undefined) updateData.temperature = currentAssistant.temperature;
    if (currentAssistant.response_format) updateData.response_format = currentAssistant.response_format;

    console.log('Datos de actualización:', JSON.stringify(updateData, null, 2));

    // Actualizar el asistente
    const updateResponse = await axios.post(
      `https://api.openai.com/v1/assistants/${assistant.openai_id}`,
      updateData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    console.log('✅ Asistente actualizado exitosamente con vector store:', {
      assistantId: assistant.openai_id,
      vectorStoreId: vectorStoreId,
      tools: updateResponse.data.tools,
      tool_resources: updateResponse.data.tool_resources
    });

    // Actualizar la BD local también
    const newConfig = {
      ...(JSON.parse(assistant.tool_config || '{}')),
      file_search: { vector_store_ids: [vectorStoreId] },
    };
    
    await db.execute(
      'UPDATE assistants SET tool_config=? WHERE id=?',
      [JSON.stringify(newConfig), assistant.id]
    );

    return updateResponse.data;
    
  } catch (error) {
    console.error('❌ Error actualizando asistente con vector store:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      assistantId: assistant.openai_id,
      vectorStoreId: vectorStoreId
    });
    
    // En este caso, SI es crítico porque necesitamos que el asistente use el vector
    throw new Error(`No se pudo asignar el vector store al asistente: ${error.response?.data?.error?.message || error.message}`);
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