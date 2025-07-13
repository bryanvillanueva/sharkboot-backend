const express  = require('express');
const multer   = require('multer');
const { v4: uuid } = require('uuid');
const axios    = require('axios');
const FormData = require('form-data');
const db       = require('../db');
const authGuard = require('../middlewares/authGuard');
const { getOrCreateVectorStore, listVectorStoreFiles } = require('../helpers/vectorStore');

const router = express.Router();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

router.use(authGuard);

/* -------- POST /assistants/:id/files  (multipart) -------- */
router.post('/:id/files', upload.array('files'), async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;

  try {
    /* 1. Comprueba ownership */
    const [[assistant]] = await db.execute(
      'SELECT id, openai_id, tool_config FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    /* 2. Crea (o recupera) vector-store */
    const storeId = await getOrCreateVectorStore(assistant);
    console.log('Usando vector store:', storeId);

    const results = [];

    for (const file of req.files) {
      try {
        console.log(`Procesando archivo: ${file.originalname} (${file.size} bytes)`);
        
        /* A. Sube archivo a OpenAI Files usando axios */
        const form = new FormData();
        form.append('file', file.buffer, {
          filename: file.originalname,
          contentType: file.mimetype,
        });
        form.append('purpose', 'assistants');

        const fileResponse = await axios.post(
          'https://api.openai.com/v1/files',
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            timeout: 60000 // 60 segundos timeout
          }
        );

        const fileId = fileResponse.data.id;
        console.log(`Archivo subido a OpenAI Files: ${fileId}`);

        /* B. Asocia archivo al vector store */
        try {
          const vsResponse = await axios.post(
            `https://api.openai.com/v1/vector_stores/${storeId}/files`,
            { 
              file_id: fileId
            },
            {
              headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v2'
              },
              timeout: 30000 // 30 segundos timeout
            }
          );

          console.log(`Archivo asociado al vector store. Status: ${vsResponse.data.status}`);

        } catch (vsError) {
          console.error('Error asociando archivo al vector store:', {
            status: vsError.response?.status,
            data: vsError.response?.data,
            message: vsError.message
          });

          // Si falla la asociación, eliminar el archivo de OpenAI Files
          try {
            await axios.delete(
              `https://api.openai.com/v1/files/${fileId}`,
              {
                headers: {
                  'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                }
              }
            );
            console.log('Archivo eliminado de OpenAI Files tras fallo en vector store');
          } catch (deleteError) {
            console.error('Error eliminando archivo fallido:', deleteError.message);
          }
          
          throw new Error(`Error asociando al vector store: ${vsError.response?.data?.error?.message || vsError.message}`);
        }

        /* C. Guarda metadatos en BD local */
        await db.execute(
          `INSERT INTO assistant_files
             (id, assistant_id, openai_file, filename, bytes)
           VALUES (?, ?, ?, ?, ?)`,
          [uuid(), id, fileId, file.originalname, file.size]
        );

        results.push({ 
          fileId, 
          filename: file.originalname,
          size: file.size,
          status: 'success'
        });
        
      } catch (err) {
        console.error(`Error procesando archivo ${file.originalname}:`, err.message);
        results.push({ 
          filename: file.originalname, 
          status: 'error',
          error: err.message
        });
      }
    }

    // Verificar si al menos un archivo se procesó exitosamente
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    res.json({ 
      success: successCount > 0, 
      results,
      summary: {
        total: req.files.length,
        success: successCount,
        errors: errorCount
      }
    });
    
  } catch (error) {
    console.error('Error general en subida de archivos:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});

/* -------- GET /assistants/:id/files ---------------------- */
router.get('/:id/files', async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;

  try {
    /* 1. Verifica ownership */
    const [[assistant]] = await db.execute(
      'SELECT id, openai_id, tool_config FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    /* 2. Obtiene archivos de la BD local */
    const [localFiles] = await db.execute(
      'SELECT openai_file AS fileId, filename, bytes, created_at FROM assistant_files WHERE assistant_id=? ORDER BY created_at DESC',
      [id]
    );

    /* 3. Opcionalmente, enriquece con información de OpenAI */
    try {
      // Obtener información actualizada de todos los archivos
      const allFilesResponse = await axios.get(
        'https://api.openai.com/v1/files',
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          }
        }
      );

      const openaiFiles = allFilesResponse.data.data;
      const fileMap = Object.fromEntries(openaiFiles.map(f => [f.id, f]));

      // Enriquecer archivos locales con información de OpenAI
      const enrichedFiles = localFiles.map(file => ({
        ...file,
        openai_status: fileMap[file.fileId]?.status || 'unknown',
        openai_created_at: fileMap[file.fileId]?.created_at,
        exists_in_openai: !!fileMap[file.fileId]
      }));

      res.json(enrichedFiles);

    } catch (enrichError) {
      console.error('Error enriqueciendo archivos con info de OpenAI:', enrichError.message);
      // Si falla la consulta a OpenAI, devolver solo la info local
      res.json(localFiles);
    }
    
  } catch (error) {
    console.error('Error listando archivos:', error);
    res.status(500).json({ error: 'Error listando archivos' });
  }
});

/* -------- DELETE /assistants/:id/files/:fileId ----------- */
router.delete('/:id/files/:fileId', async (req, res) => {
  const { id, fileId } = req.params;
  const { clientId } = req.auth;

  try {
    /* 1. Verifica ownership */
    const [[assistant]] = await db.execute(
      'SELECT id, openai_id, tool_config FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    /* 2. Verifica que el archivo pertenezca al asistente */
    const [[fileRecord]] = await db.execute(
      'SELECT filename FROM assistant_files WHERE assistant_id=? AND openai_file=?',
      [id, fileId]
    );
    if (!fileRecord) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    /* 3. Obtiene o crea vector store */
    const storeId = await getOrCreateVectorStore(assistant);

    let vectorStoreRemoved = false;
    let fileDeleted = false;

    /* 4. Remueve del vector store */
    try {
      await axios.delete(
        `https://api.openai.com/v1/vector_stores/${storeId}/files/${fileId}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );
      vectorStoreRemoved = true;
      console.log('Archivo removido del vector store:', fileId);
    } catch (vsError) {
      console.error('Error removiendo archivo del vector store:', {
        status: vsError.response?.status,
        data: vsError.response?.data
      });
      // Continuar con la eliminación aunque falle la remoción del vector store
    }

    /* 5. Elimina el archivo de OpenAI Files */
    try {
      await axios.delete(
        `https://api.openai.com/v1/files/${fileId}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          }
        }
      );
      fileDeleted = true;
      console.log('Archivo eliminado de OpenAI Files:', fileId);
    } catch (fileError) {
      console.error('Error eliminando archivo de OpenAI Files:', {
        status: fileError.response?.status,
        data: fileError.response?.data
      });
      // Continuar con la eliminación local aunque falle en OpenAI
    }

    /* 6. Elimina metadatos de la BD local (siempre) */
    await db.execute(
      'DELETE FROM assistant_files WHERE assistant_id=? AND openai_file=?', 
      [id, fileId]
    );
    console.log('Archivo eliminado de BD local:', fileId);

    res.json({ 
      success: true,
      fileId,
      filename: fileRecord.filename,
      operations: {
        vector_store_removed: vectorStoreRemoved,
        file_deleted: fileDeleted,
        local_record_deleted: true
      }
    });
    
  } catch (err) {
    console.error('Error eliminando archivo:', err);
    res.status(500).json({ 
      error: 'Error eliminando archivo',
      details: err.message 
    });
  }
});

/* -------- GET /assistants/:id/files/vector-store --------- */
// Endpoint adicional para ver archivos directamente del vector store
router.get('/:id/files/vector-store', async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.auth;

  try {
    const [[assistant]] = await db.execute(
      'SELECT id, openai_id, tool_config FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Obtener vector store ID
    let storeId;
    if (assistant.tool_config) {
      const cfg = JSON.parse(assistant.tool_config);
      storeId = cfg.file_search?.vector_store_ids?.[0];
    }

    if (!storeId) {
      return res.json({ files: [], vector_store_id: null });
    }

    // Listar archivos del vector store
    const files = await listVectorStoreFiles(storeId);
    
    res.json({ 
      files, 
      vector_store_id: storeId,
      count: files.length 
    });

  } catch (error) {
    console.error('Error obteniendo archivos del vector store:', error);
    res.status(500).json({ error: 'Error obteniendo archivos del vector store' });
  }
});

// ----------- CODE INTERPRETER: SUBIR ARCHIVOS DE ENTRADA PARA UN RUN -----------
router.post('/:id/runs/:runId/files', upload.array('files'), async (req, res) => {
  const { id, runId } = req.params;
  const { clientId } = req.auth;

  try {
    // Verifica ownership
    const [[assistant]] = await db.execute(
      'SELECT id, openai_id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Sube cada archivo a OpenAI Files
    const fileIds = [];
    const results = [];

    for (const file of req.files) {
      try {
        const form = new FormData();
        form.append('file', file.buffer, {
          filename: file.originalname,
          contentType: file.mimetype,
        });
        form.append('purpose', 'assistants');

        const uploadResult = await axios.post(
          'https://api.openai.com/v1/files',
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            },
          }
        );

        fileIds.push(uploadResult.data.id);
        results.push({
          fileId: uploadResult.data.id,
          filename: file.originalname,
          status: 'success'
        });

      } catch (error) {
        console.error(`Error subiendo archivo ${file.originalname}:`, error.message);
        results.push({
          filename: file.originalname,
          status: 'error',
          error: error.message
        });
      }
    }

    res.json({ 
      fileIds: fileIds.filter(Boolean), // Solo IDs exitosos
      results,
      success: fileIds.length > 0
    });
    
  } catch (error) {
    console.error('Error subiendo archivos para run:', error);
    res.status(500).json({ error: 'Error subiendo archivos' });
  }
});

// ----------- CODE INTERPRETER: LISTAR ARCHIVOS DE SALIDA DE UN RUN -----------
router.get('/:id/runs/:runId/files', async (req, res) => {
  const { id, runId } = req.params;
  const { clientId } = req.auth;

  try {
    // Verifica ownership
    const [[assistant]] = await db.execute(
      'SELECT id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    const [rows] = await db.execute(
      'SELECT file_id, filename, bytes, created_at, thumb_url FROM assistant_run_files WHERE assistant_id=? AND run_id=? ORDER BY created_at DESC',
      [id, runId]
    );
    
    res.json(rows);
    
  } catch (error) {
    console.error('Error listando archivos de run:', error);
    res.status(500).json({ error: 'Error listando archivos' });
  }
});

// ----------- CODE INTERPRETER: DESCARGAR ARCHIVO DE SALIDA DE UN RUN -----------
router.get('/:id/runs/:runId/files/:fileId', async (req, res) => {
  const { id, runId, fileId } = req.params;
  const { clientId } = req.auth;

  try {
    // Verifica ownership
    const [[assistant]] = await db.execute(
      'SELECT id FROM assistants WHERE id=? AND client_id=?',
      [id, clientId]
    );
    if (!assistant) {
      return res.status(404).json({ error: 'Asistente no encontrado' });
    }

    // Busca metadatos locales
    const [[fileRow]] = await db.execute(
      'SELECT filename FROM assistant_run_files WHERE assistant_id=? AND run_id=? AND file_id=?',
      [id, runId, fileId]
    );
    if (!fileRow) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    // Descarga el archivo desde OpenAI usando axios
    const response = await axios.get(
      `https://api.openai.com/v1/files/${fileId}/content`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        responseType: 'stream'
      }
    );

    res.setHeader('Content-Disposition', `attachment; filename="${fileRow.filename}"`);
    response.data.pipe(res);
    
  } catch (error) {
    console.error('Error descargando archivo:', error);
    if (error.response?.status === 404) {
      res.status(404).json({ error: 'Archivo no encontrado en OpenAI' });
    } else {
      res.status(500).json({ error: 'Error descargando archivo' });
    }
  }
});

module.exports = router;