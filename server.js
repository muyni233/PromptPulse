import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { dbService } from './database.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Load Port from config.json if available, fallback to environment or default 3000
let PORT = process.env.PORT || 3000;
try {
  const configPath = join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configContent);
    if (config.port !== undefined && !isNaN(Number(config.port))) {
      PORT = Number(config.port);
    }
  }
} catch (err) {
  console.warn(`[Server] Warning: Failed to load config.json (using fallback port ${PORT}):`, err.message);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

// Helper: Extract system prompt
function extractSystemPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  const systemMsg = messages.find(m => m.role === 'system');
  return systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content)) : '';
}

// Helper: Extract last user prompt
function extractUserPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  const userMsgs = messages.filter(m => m.role === 'user');
  if (userMsgs.length === 0) return '';
  const lastMsg = userMsgs[userMsgs.length - 1];
  return typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
}

// Helper: Estimate tokens (approx 3.8 characters per token on average for Chinese/English/Code mixed)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}

// Helper: Mask API Key for security when sending to frontend
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// Helper: Extract generated response text from Gemini standard response JSON
function extractGeminiResponseText(resJson) {
  if (!resJson || !Array.isArray(resJson.candidates)) return '';
  const candidate = resJson.candidates[0];
  if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) return '';
  return candidate.content.parts.map(p => p.text).join('');
}

// Helper: Extract text content from a streaming Gemini chunk (JSON array element or single object)
function parseGeminiStreamChunk(chunkText) {
  let clean = chunkText.trim();
  // Strip array prefixes/suffixes that Google SDKs might append
  if (clean.startsWith('[')) clean = clean.slice(1).trim();
  if (clean.endsWith(']')) clean = clean.slice(0, -1).trim();
  if (clean.startsWith(',')) clean = clean.slice(1).trim();
  if (!clean) return '';
  
  try {
    const parsed = JSON.parse(clean);
    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text;
  } catch (e) {
    // Regex fallback if JSON chunk is partial or poorly formatted
    const match = clean.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch (err) {}
    }
  }
  return '';
}

// Authorization middleware for Dashboard visual control panel
function authorizeDashboard(req, res, next) {
  const dbPassword = dbService.getSetting('dashboard_password');
  if (!dbPassword || dbPassword.trim() === '') {
    return next(); // Security disabled
  }

  const clientKey = req.headers['x-dashboard-password'] || req.headers['x-collector-key']; // support fallback
  if (clientKey === dbPassword) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid Dashboard Password' });
}

// Helper: Internal mock LLM engine executor (Bypasses network sockets to prevent event deadlocks)
function handleMockCompletions(req, res, messages, model, stream, startTime, requestId, upstreamUrl) {
  const userPrompt = extractUserPrompt(messages) || 'hi';
  
  const chunks = [
    `I am PromptPulse's internal mock engine! 🚀\\n\\nYour proxy, database, and logs collector are working 100% perfectly. \\n\\nHere is your prompt details:\\n`,
    `- **Model Used**: \`${model || 'gpt-4o-mini'}\`\\n`,
    `- **User Message**: "${userPrompt}"\\n\\n`,
    `You can now configure your real upstream provider (like OpenAI, DeepSeek, or Anthropic) in the **Settings** tab. Happy developing!`
  ];

  if (stream) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    let responseText = '';
    const responseJsonChunks = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const text = chunks[chunkIdx];
      responseText += text;
      const payload = {
        id: 'chatcmpl-mock-' + crypto.randomUUID().slice(0, 8),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'mock-gpt-model',
        choices: [
          {
            index: 0,
            delta: { content: text },
            finish_reason: null
          }
        ]
      };
      responseJsonChunks.push(payload);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    const finalPayload = {
      id: 'chatcmpl-mock-done',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: model || 'mock-gpt-model',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: estimateTokens(JSON.stringify(messages)),
        completion_tokens: estimateTokens(responseText),
        total_tokens: estimateTokens(JSON.stringify(messages)) + estimateTokens(responseText)
      }
    };
    res.write(`data: ${JSON.stringify(finalPayload)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

    const duration = Date.now() - startTime;
    // Save to Database
    dbService.saveLog({
      id: requestId,
      timestamp: startTime,
      model: model || 'unknown',
      system_prompt: extractSystemPrompt(messages),
      user_prompt: userPrompt,
      messages: messages,
      response_text: responseText,
      response_json: finalPayload,
      duration: duration,
      status: 200,
      tokens_prompt: estimateTokens(JSON.stringify(messages)),
      tokens_completion: estimateTokens(responseText),
      upstream_url: upstreamUrl,
      is_stream: true
    });

  } else {
    // Non-streaming response
    const mockReply = `Hello! I am PromptPulse's internal offline mock engine. Your proxy collector is working flawlessly! You queried model: "${model || 'gpt-4o-mini'}" with prompt: "${userPrompt}". Configure real providers in Settings!`;
    const duration = Date.now() - startTime;
    const tokensPrompt = estimateTokens(JSON.stringify(messages));
    const tokensCompletion = estimateTokens(mockReply);

    const payload = {
      id: 'chatcmpl-mock-' + crypto.randomUUID().slice(0, 8),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'mock-gpt-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: mockReply
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: tokensPrompt,
        completion_tokens: tokensCompletion,
        total_tokens: tokensPrompt + tokensCompletion
      }
    };

    dbService.saveLog({
      id: requestId,
      timestamp: startTime,
      model: model || 'unknown',
      system_prompt: extractSystemPrompt(messages),
      user_prompt: userPrompt,
      messages: messages,
      response_text: mockReply,
      response_json: payload,
      duration: duration,
      status: 200,
      tokens_prompt: tokensPrompt,
      tokens_completion: tokensCompletion,
      upstream_url: upstreamUrl,
      is_stream: false
    });

    res.json(payload);
  }
}

// Helper: Internal mock Gemini LLM engine executor
function handleGeminiMockCompletions(req, res, messages, model, isStream, startTime, requestId, upstreamUrl) {
  const userPrompt = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || 'hi';
  
  const chunks = [
    `你好！我是 PromptPulse 的本地 Gemini 离线 Mock 引擎。`,
    `你的 Gemini 代理与日志收集器运行完美！🚀\n\n`,
    `你请求的模型是: \`${model || 'gemini-2.5-flash'}\`\n`,
    `- **你的提示词**: "${userPrompt}"\n\n`,
    `请在全局配置中设定真实的 Google AI Studio 接口地址与 API 密钥以使用真实模型服务。`
  ];

  const fullReplyText = chunks.join('');

  if (isStream) {
    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    res.write('[\n');

    let responseText = '';
    const responseJsonChunks = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const text = chunks[chunkIdx];
      responseText += text;
      const payload = {
        candidates: [
          {
            content: {
              parts: [{ text: text }],
              role: 'model'
            },
            index: 0
          }
        ]
      };
      responseJsonChunks.push(payload);
      res.write((chunkIdx > 0 ? ',\n' : '') + JSON.stringify(payload) + '\n');
    }

    const finalPayload = {
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: estimateTokens(JSON.stringify(messages)),
        candidatesTokenCount: estimateTokens(responseText),
        totalTokenCount: estimateTokens(JSON.stringify(messages)) + estimateTokens(responseText)
      }
    };
    res.write(',\n' + JSON.stringify(finalPayload) + '\n]\n');
    res.end();

    const duration = Date.now() - startTime;
    // Save to Database
    dbService.saveLog({
      id: requestId,
      timestamp: startTime,
      model: model || 'unknown',
      system_prompt: extractSystemPrompt(messages),
      user_prompt: userPrompt,
      messages: messages,
      response_text: responseText,
      response_json: { note: 'Gemini mock stream completed', chunks_count: chunks.length },
      duration: duration,
      status: 200,
      tokens_prompt: estimateTokens(JSON.stringify(messages)),
      tokens_completion: estimateTokens(responseText),
      upstream_url: upstreamUrl,
      is_stream: true
    });

  } else {
    // Non-streaming response
    const mockReply = `你好！我是 PromptPulse 的本地 Gemini 离线 Mock 引擎。你的 Gemini 代理与日志收集器运行完美！\n\n你请求的模型是: \`${model || 'gemini-2.5-flash'}\`，提示词为: "${userPrompt}"。请在全局配置中设定真实的 Google AI Studio 接口地址与 API 密钥。`;
    const duration = Date.now() - startTime;
    const tokensPrompt = estimateTokens(JSON.stringify(messages));
    const tokensCompletion = estimateTokens(mockReply);

    const payload = {
      candidates: [
        {
          content: {
            parts: [{ text: mockReply }],
            role: 'model'
          },
          finishReason: 'STOP',
          index: 0
        }
      ],
      usageMetadata: {
        promptTokenCount: tokensPrompt,
        candidatesTokenCount: tokensCompletion,
        totalTokenCount: tokensPrompt + tokensCompletion
      }
    };

    dbService.saveLog({
      id: requestId,
      timestamp: startTime,
      model: model || 'unknown',
      system_prompt: extractSystemPrompt(messages),
      user_prompt: userPrompt,
      messages: messages,
      response_text: mockReply,
      response_json: payload,
      duration: duration,
      status: 200,
      tokens_prompt: tokensPrompt,
      tokens_completion: tokensCompletion,
      upstream_url: upstreamUrl,
      is_stream: false
    });

    res.json(payload);
  }
}

// --- Proxy Endpoint (OpenAI Chat Completions) ---
app.post('/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();
  const { model, messages, stream } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request: messages must be an array' });
  }

  // 2. Determine Upstream URL and Key
  let upstreamUrl = dbService.getSetting('default_upstream_url');
  let upstreamKey = req.headers['x-upstream-key'] || dbService.getSetting('default_upstream_key');

  // Fallback: If no explicit upstream key, and Authorization header exists, use it as upstream key
  const authHeader = req.headers['authorization'];
  if (!upstreamKey && authHeader && authHeader.startsWith('Bearer ')) {
    const bearerKey = authHeader.slice(7).trim();
    upstreamKey = bearerKey;
  }

  if (!upstreamUrl) {
    return res.status(400).json({ error: 'Upstream URL not configured' });
  }

  // Clean upstream URL (remove trailing slash)
  if (upstreamUrl.endsWith('/')) {
    upstreamUrl = upstreamUrl.slice(0, -1);
  }

  // Intercept mock upstreams to avoid network deadlocks or socket-exhaustion on localhost
  if (upstreamUrl.includes('/mock/v1') || upstreamUrl.includes('localhost:3000/mock')) {
    console.log(`[Proxy] Bypassing HTTP network call. Invoking internal local mock LLM engine directly.`);
    handleMockCompletions(req, res, messages, model, stream, startTime, requestId, upstreamUrl);
    return;
  }

  const targetEndpoint = `${upstreamUrl}/chat/completions`;
  console.log(`[Proxy] Routing request ${requestId} to upstream: ${targetEndpoint} (Model: ${model || 'default'}, Stream: ${!!stream})`);

  // Prepare upstream headers
  const upstreamHeaders = {
    'Content-Type': 'application/json',
  };

  if (upstreamKey) {
    upstreamHeaders['Authorization'] = `Bearer ${upstreamKey}`;
  }

  // Forward any extra standard headers
  const headersToForward = ['openai-organization', 'openai-project', 'anthropic-version'];
  for (const h of headersToForward) {
    if (req.headers[h]) {
      upstreamHeaders[h] = req.headers[h];
    }
  }

  try {
    const response = await fetch(targetEndpoint, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(req.body),
      signal: req.signal // Handle client disconnection
    });

    if (!response.ok) {
      // Read error payload
      const errorText = await response.text();
      let errorJson = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch (e) {}

      const duration = Date.now() - startTime;
      dbService.saveLog({
        id: requestId,
        timestamp: startTime,
        model: model || 'unknown',
        system_prompt: extractSystemPrompt(messages),
        user_prompt: extractUserPrompt(messages),
        messages: messages,
        response_text: errorText,
        response_json: errorJson,
        duration: duration,
        status: response.status,
        tokens_prompt: estimateTokens(JSON.stringify(messages)),
        tokens_completion: 0,
        error_message: errorJson?.error?.message || errorText || 'Upstream returned error status',
        upstream_url: upstreamUrl,
        is_stream: !!stream
      });

      res.status(response.status).set('Content-Type', 'application/json').send(errorText);
      return;
    }

    // 3. Handle successful response
    if (stream) {
      // Stream Response
      res.status(response.status);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let responseText = '';
      let tokensPrompt = 0;
      let tokensCompletion = 0;
      let responseJsonChunks = [];

      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Send immediately to client
          res.write(value);

          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded;

          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line.startsWith('data:')) {
              const dataStr = line.slice(5).trim();
              if (dataStr === '[DONE]') continue;
              
              try {
                const parsed = JSON.parse(dataStr);
                responseJsonChunks.push(parsed);

                const content = parsed.choices?.[0]?.delta?.content || '';
                responseText += content;

                if (parsed.usage) {
                  tokensPrompt = parsed.usage.prompt_tokens || tokensPrompt;
                  tokensCompletion = parsed.usage.completion_tokens || tokensCompletion;
                }
              } catch (e) {
                // Ignore incomplete JSON chunks
              }
            }
          }
        }
      } catch (streamError) {
        console.error(`[Proxy] Stream interrupted for request ${requestId}:`, streamError);
      } finally {
        res.end();
        const duration = Date.now() - startTime;

        // Fallback for token counts
        if (tokensPrompt === 0) {
          tokensPrompt = estimateTokens(JSON.stringify(messages));
        }
        if (tokensCompletion === 0) {
          tokensCompletion = estimateTokens(responseText);
        }

        // Save to Database
        dbService.saveLog({
          id: requestId,
          timestamp: startTime,
          model: model || 'unknown',
          system_prompt: extractSystemPrompt(messages),
          user_prompt: extractUserPrompt(messages),
          messages: messages,
          response_text: responseText,
          response_json: responseJsonChunks.slice(-1)[0] || { note: 'Stream chunk summary compiled', chunks_count: responseJsonChunks.length },
          duration: duration,
          status: 200,
          tokens_prompt: tokensPrompt,
          tokens_completion: tokensCompletion,
          upstream_url: upstreamUrl,
          is_stream: true
        });
      }
    } else {
      // Standard JSON Response
      const resBody = await response.json();
      const duration = Date.now() - startTime;

      const responseText = resBody.choices?.[0]?.message?.content || '';
      const tokensPrompt = resBody.usage?.prompt_tokens || estimateTokens(JSON.stringify(messages));
      const tokensCompletion = resBody.usage?.completion_tokens || estimateTokens(responseText);

      dbService.saveLog({
        id: requestId,
        timestamp: startTime,
        model: model || resBody.model || 'unknown',
        system_prompt: extractSystemPrompt(messages),
        user_prompt: extractUserPrompt(messages),
        messages: messages,
        response_text: responseText,
        response_json: resBody,
        duration: duration,
        status: response.status,
        tokens_prompt: tokensPrompt,
        tokens_completion: tokensCompletion,
        upstream_url: upstreamUrl,
        is_stream: false
      });

      res.status(response.status).json(resBody);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Proxy] Error forwarding request ${requestId}:`, error);

    dbService.saveLog({
      id: requestId,
      timestamp: startTime,
      model: model || 'unknown',
      system_prompt: extractSystemPrompt(messages),
      user_prompt: extractUserPrompt(messages),
      messages: messages,
      response_text: '',
      response_json: null,
      duration: duration,
      status: 500,
      tokens_prompt: estimateTokens(JSON.stringify(messages)),
      tokens_completion: 0,
      error_message: error.message || 'Internal connection error to upstream',
      upstream_url: upstreamUrl,
      is_stream: !!stream
    });

    res.status(500).json({ error: 'Internal proxy server error', details: error.message });
  }
});

// --- Mock LLM Server Route (For offline local sandbox testing) ---
app.post('/mock/v1/chat/completions', (req, res) => {
  const { messages, model, stream } = req.body;
  const userPrompt = extractUserPrompt(messages) || 'hi';
  console.log(`[Mock Upstream] Received request. Model: ${model || 'default'}, Stream: ${!!stream}, User: "${userPrompt}"`);

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send chunks with a small simulated network delay
    const chunks = [
      `I am PromptPulse's internal mock engine! 🚀\n\nYour proxy, database, and logs collector are working 100% perfectly. \n\nHere is your prompt details:\n`,
      `- **Model Used**: \`${model || 'gpt-4o-mini'}\`\n`,
      `- **User Message**: "${userPrompt}"\n\n`,
      `You can now configure your real upstream provider (like OpenAI, DeepSeek, or Anthropic) in the **Settings** tab. Happy developing!`
    ];

    let chunkIdx = 0;

    const interval = setInterval(() => {
      if (chunkIdx < chunks.length) {
        const payload = {
          id: 'chatcmpl-mock-' + crypto.randomUUID().slice(0, 8),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model || 'mock-gpt-model',
          choices: [
            {
              index: 0,
              delta: { content: chunks[chunkIdx] },
              finish_reason: null
            }
          ]
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        chunkIdx++;
      } else {
        // Send final chunk and close
        const finalPayload = {
          id: 'chatcmpl-mock-done',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model || 'mock-gpt-model',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: estimateTokens(JSON.stringify(messages)),
            completion_tokens: estimateTokens(chunks.join('')),
            total_tokens: estimateTokens(JSON.stringify(messages)) + estimateTokens(chunks.join(''))
          }
        };
        res.write(`data: ${JSON.stringify(finalPayload)}\n\n`);
        res.write('data: [DONE]\n\n');
        clearInterval(interval);
        res.end();
      }
    }, 150); // 150ms delay per chunk for premium real-time streaming effect!

    req.on('close', () => {
      clearInterval(interval);
    });

  } else {
    // Non-streaming response
    const mockReply = `Hello! I am PromptPulse's internal offline mock engine. Your proxy collector is working flawlessly! You queried model: "${model || 'gpt-4o-mini'}" with prompt: "${userPrompt}". Configure real providers in Settings!`;
    const payload = {
      id: 'chatcmpl-mock-' + crypto.randomUUID().slice(0, 8),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'mock-gpt-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: mockReply
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: estimateTokens(JSON.stringify(messages)),
        completion_tokens: estimateTokens(mockReply),
        total_tokens: estimateTokens(JSON.stringify(messages)) + estimateTokens(mockReply)
      }
    };
    res.json(payload);
  }
});

// --- Proxy Endpoint (Gemini API Compatibility) ---
app.post('/v1beta/models/:modelAndMethod(*)', async (req, res) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();
  
  const pathParam = req.params.modelAndMethod;
  const colonIndex = pathParam.indexOf(':');
  if (colonIndex === -1) {
    return res.status(400).json({ error: 'Invalid Gemini endpoint format. Expected model:method' });
  }
  const model = pathParam.substring(0, colonIndex);
  const method = pathParam.substring(colonIndex + 1); // 'generateContent' or 'streamGenerateContent'
  const isStream = method.startsWith('stream');


  // 2. Map Gemini body to Standard Messages format for Database storage
  const systemPrompt = req.body.systemInstruction?.parts?.map(p => p.text).join('') || '';
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  if (Array.isArray(req.body.contents)) {
    for (const item of req.body.contents) {
      const role = item.role === 'model' ? 'assistant' : (item.role || 'user');
      const text = item.parts?.map(p => p.text).join('') || '';
      messages.push({ role, content: text });
    }
  }
  const userPrompt = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

  // 3. Determine Upstream URL and Key
  let upstreamUrl = dbService.getSetting('default_gemini_url') || 'http://localhost:3000/mock/v1beta';
  let upstreamKey = req.query.key || req.headers['x-upstream-key'] || dbService.getSetting('default_gemini_key');

  if (!upstreamUrl) {
    return res.status(400).json({ error: 'Upstream URL not configured' });
  }

  // If local mock is target
  if (upstreamUrl.includes('/mock') || upstreamUrl.includes('localhost:3000/mock')) {
    handleGeminiMockCompletions(req, res, messages, model, isStream, startTime, requestId, upstreamUrl);
    return;
  }

  // Clean and normalize Gemini upstream URL to avoid double version pathing
  let cleanUpstreamUrl = upstreamUrl;
  if (cleanUpstreamUrl.endsWith('/')) {
    cleanUpstreamUrl = cleanUpstreamUrl.slice(0, -1);
  }
  if (cleanUpstreamUrl.endsWith('/models')) {
    cleanUpstreamUrl = cleanUpstreamUrl.slice(0, -7);
  }
  if (cleanUpstreamUrl.endsWith('/v1beta')) {
    cleanUpstreamUrl = cleanUpstreamUrl.slice(0, -7);
  }

  // Construct target Gemini URL
  const targetEndpoint = `${cleanUpstreamUrl}/v1beta/models/${model}:${method}?key=${upstreamKey}`;
  console.log(`[Gemini Proxy] Routing request ${requestId} to upstream: ${upstreamUrl}/v1beta/models/${model}:${method} (Stream: ${isStream})`);

  try {
    const response = await fetch(targetEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body),
      signal: req.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson = null;
      try { errorJson = JSON.parse(errorText); } catch (e) {}

      const duration = Date.now() - startTime;
      dbService.saveLog({
        id: requestId,
        timestamp: startTime,
        model: model,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        messages: messages,
        response_text: errorText,
        response_json: errorJson,
        duration: duration,
        status: response.status,
        tokens_prompt: estimateTokens(JSON.stringify(req.body)),
        tokens_completion: 0,
        error_message: errorJson?.error?.message || errorText || 'Gemini Upstream Error',
        upstream_url: upstreamUrl,
        is_stream: isStream
      });

      res.status(response.status).set('Content-Type', 'application/json').send(errorText);
      return;
    }

    if (isStream) {
      res.status(200);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let responseText = '';
      let chunksCount = 0;

      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          res.write(value);

          const decoded = decoder.decode(value, { stream: true });
          buffer += decoded;

          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) {
              const text = parseGeminiStreamChunk(line);
              if (text) {
                responseText += text;
                chunksCount++;
              }
            }
          }
        }
      } catch (streamError) {
        console.error(`[Gemini Proxy] Stream interrupted:`, streamError);
      } finally {
        res.end();
        const duration = Date.now() - startTime;
        dbService.saveLog({
          id: requestId,
          timestamp: startTime,
          model: model,
          system_prompt: systemPrompt,
          user_prompt: userPrompt,
          messages: messages,
          response_text: responseText,
          response_json: { note: 'Gemini stream chunks compiled', chunks_count: chunksCount },
          duration: duration,
          status: 200,
          tokens_prompt: estimateTokens(JSON.stringify(req.body)),
          tokens_completion: estimateTokens(responseText),
          upstream_url: upstreamUrl,
          is_stream: true
        });
      }
    } else {
      // Standard JSON
      const resBody = await response.json();
      const duration = Date.now() - startTime;
      const responseText = extractGeminiResponseText(resBody);

      const tokensPrompt = resBody.usageMetadata?.promptTokenCount || estimateTokens(JSON.stringify(req.body));
      const tokensCompletion = resBody.usageMetadata?.candidatesTokenCount || estimateTokens(responseText);

      dbService.saveLog({
        id: requestId,
        timestamp: startTime,
        model: model,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        messages: messages,
        response_text: responseText,
        response_json: resBody,
        duration: duration,
        status: 200,
        tokens_prompt: tokensPrompt,
        tokens_completion: tokensCompletion,
        upstream_url: upstreamUrl,
        is_stream: false
      });

      res.status(200).json(resBody);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Gemini Proxy] Error forwarding request ${requestId}:`, error);

    dbService.saveLog({
      id: requestId,
      timestamp: startTime,
      model: model,
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      messages: messages,
      response_text: '',
      response_json: null,
      duration: duration,
      status: 500,
      tokens_prompt: estimateTokens(JSON.stringify(req.body)),
      tokens_completion: 0,
      error_message: error.message || 'Internal connection error to upstream',
      upstream_url: upstreamUrl,
      is_stream: isStream
    });

    res.status(500).json({ error: 'Internal proxy server error', details: error.message });
  }
});

// --- Mock LLM Server Route (Gemini Compatibility) ---
app.post('/mock/v1beta/models/:modelAndMethod(*)', (req, res) => {
  const pathParam = req.params.modelAndMethod;
  const colonIndex = pathParam.indexOf(':');
  const model = colonIndex === -1 ? pathParam : pathParam.substring(0, colonIndex);
  const method = colonIndex === -1 ? 'generateContent' : pathParam.substring(colonIndex + 1);
  const isStream = method.startsWith('stream');

  const systemPrompt = req.body.systemInstruction?.parts?.map(p => p.text).join('') || '';
  const messages = [];
  if (Array.isArray(req.body.contents)) {
    for (const item of req.body.contents) {
      const role = item.role === 'model' ? 'assistant' : (item.role || 'user');
      const text = item.parts?.map(p => p.text).join('') || '';
      messages.push({ role, content: text });
    }
  }
  const userPrompt = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || 'hi';

  const mockReply = `你好！我是 PromptPulse 的本地 Gemini 离线 Mock 引擎。你的 Gemini 代理与日志收集器运行完美！\n\n你请求的模型是: \`${model}\`，提示词为: "${userPrompt}"。请在全局配置中设定真实的 Google AI Studio 接口地址与 API 密钥。`;

  if (isStream) {
    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Gemini stream returns an array-like stream
    res.write('[\n');

    const chunks = [
      `你好！我是 PromptPulse 的本地 Gemini 离线 Mock 引擎。`,
      `你的 Gemini 代理与日志收集器运行完美！🚀\n\n`,
      `你请求的模型是: \`${model}\`\n`,
      `- **你的提示词**: "${userPrompt}"\n\n`,
      `请在全局配置中设定真实的 Google AI Studio 接口地址与 API 密钥以使用真实模型服务。`
    ];

    let i = 0;
    const interval = setInterval(() => {
      if (i < chunks.length) {
        const chunkJson = {
          candidates: [
            {
              content: {
                parts: [{ text: chunks[i] }],
                role: 'model'
              },
              index: 0
            }
          ]
        };
        res.write((i > 0 ? ',\n' : '') + JSON.stringify(chunkJson) + '\n');
        i++;
      } else {
        // Send final chunk with usage
        const usageJson = {
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: estimateTokens(JSON.stringify(req.body)),
            candidatesTokenCount: estimateTokens(chunks.join('')),
            totalTokenCount: estimateTokens(JSON.stringify(req.body)) + estimateTokens(chunks.join(''))
          }
        };
        res.write(',\n' + JSON.stringify(usageJson) + '\n]\n');
        clearInterval(interval);
        res.end();
      }
    }, 150);

    req.on('close', () => clearInterval(interval));
  } else {
    // Non-streaming response
    const payload = {
      candidates: [
        {
          content: {
            parts: [{ text: mockReply }],
            role: 'model'
          },
          finishReason: 'STOP',
          index: 0
        }
      ],
      usageMetadata: {
        promptTokenCount: estimateTokens(JSON.stringify(req.body)),
        candidatesTokenCount: estimateTokens(mockReply),
        totalTokenCount: estimateTokens(JSON.stringify(req.body)) + estimateTokens(mockReply)
      }
    };
    res.json(payload);
  }
});

// --- Dashboard API Endpoints ---

// Get Logs
app.get('/api/logs', authorizeDashboard, (req, res) => {
  try {
    const { search, limit, offset, status, model } = req.query;
    const logs = dbService.getLogs({
      search: search || '',
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
      status: status || null,
      model: model || null
    });
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Log Detail
app.get('/api/logs/:id', authorizeDashboard, (req, res) => {
  try {
    const log = dbService.getLogById(req.params.id);
    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }
    res.json(log);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clear Logs
app.post('/api/logs/clear', authorizeDashboard, (req, res) => {
  try {
    dbService.clearLogs();
    res.json({ success: true, message: 'All logs cleared successfully' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Stats
app.get('/api/stats', authorizeDashboard, (req, res) => {
  try {
    const stats = dbService.getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Settings
app.get('/api/settings', authorizeDashboard, (req, res) => {
  try {
    const settings = dbService.getSettings();
    
    // Mask sensitive keys before returning
    res.json({
      default_upstream_url: settings.default_upstream_url || '',
      default_upstream_key_masked: maskKey(settings.default_upstream_key),
      default_gemini_url: settings.default_gemini_url || '',
      default_gemini_key_masked: maskKey(settings.default_gemini_key),
      has_dashboard_password: !!(settings.dashboard_password && settings.dashboard_password.trim() !== '')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save Settings
app.post('/api/settings', authorizeDashboard, (req, res) => {
  try {
    const newSettings = req.body;
    const currentSettings = dbService.getSettings();
    const updateObj = {};

    if (newSettings.default_upstream_url !== undefined) {
      updateObj.default_upstream_url = newSettings.default_upstream_url;
    }

    // Only update key if it has actually changed and is not the masked placeholder
    if (newSettings.default_upstream_key !== undefined) {
      const trimmedKey = newSettings.default_upstream_key.trim();
      if (trimmedKey !== '' && !trimmedKey.includes('...')) {
        updateObj.default_upstream_key = trimmedKey;
      } else if (trimmedKey === '') {
        updateObj.default_upstream_key = '';
      }
    }

    if (newSettings.default_gemini_url !== undefined) {
      updateObj.default_gemini_url = newSettings.default_gemini_url;
    }

    if (newSettings.default_gemini_key !== undefined) {
      const trimmedKey = newSettings.default_gemini_key.trim();
      if (trimmedKey !== '' && !trimmedKey.includes('...')) {
        updateObj.default_gemini_key = trimmedKey;
      } else if (trimmedKey === '') {
        updateObj.default_gemini_key = '';
      }
    }


    if (newSettings.dashboard_password !== undefined) {
      const trimmedKey = newSettings.dashboard_password.trim();
      // If client sent exact empty string, we clear security
      if (trimmedKey === '') {
        updateObj.dashboard_password = '';
      } else if (!trimmedKey.includes('...')) {
        updateObj.dashboard_password = trimmedKey;
      }
    }

    dbService.saveSettings(updateObj);
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Boot Server ---
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 PromptPulse Server is running on: http://localhost:${PORT}`);
  console.log(`📂 Dashboard UI: http://localhost:${PORT}`);
  console.log(`🔌 OpenAI API Proxy: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`======================================================\n`);
});
