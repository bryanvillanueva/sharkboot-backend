const OpenAI = require('openai').default;

exports.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); 