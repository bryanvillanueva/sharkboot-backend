const { openai } = require('./openai');   // cliente OpenAI v5
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
    const vs = await openai.beta.vectorStores.create({ name: `vs_${assistant.id}` });
    storeId = vs.id;

    // Actualiza tool_config en BD
    const newConfig = {
      ...(JSON.parse(assistant.tool_config || '{}')),
      file_search: { vector_store_ids: [storeId] },
    };
    await db.execute('UPDATE assistants SET tool_config=? WHERE id=?',
      [JSON.stringify(newConfig), assistant.id]);
    
    // Actualiza en OpenAI usando openai_id
    await openai.beta.assistants.update(assistant.openai_id, {
      tool_resources: { file_search: { vector_store_ids: [storeId] } }
    });
  }

  return storeId;
}; 