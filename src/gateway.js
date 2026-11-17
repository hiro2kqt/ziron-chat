/**
 * Ziron Gateway
 * Core gateway that manages conversations, history, and LLM providers
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { loadConfig, getForcedChatId } from './config/index.js';
import { toGmtString, utcTimeToLocal } from './utils/time.js';
import { PRIVATE_ROUTING, logUsage } from './providers/openrouter.js';
import { shiftUtcTime } from './scheduler/sync.js';
import { createSession, appendMessage, buildApiMessages, saveSessionImage } from './storage/history.js';
import { createClient } from './api/client.js';
import { buildSystemPrompt } from './prompts/system.js';
import { shouldExtractMemory, extractMemory } from './memory/extractor.js';
import {
  initScheduler,
  addRecurringJob,
  addOneshotJob,
  addOneshotInterval,
  disableJobsByName,
  listTodayJobs,
  listMasterJobs,
  deleteJob,
} from './scheduler/index.js';
import {
  getSchedulerTools,
  calculateTime,
  calculateTimeRange,
  calculateRecurringDays,
  calculateEndTime,
  calculateNextOccurrence,
  calculateSpecificDates
} from './tools/scheduler.js';
import { getWeatherTools } from './tools/weather.js';
import { getWeather, formatWeather } from './tools/providers/weather/index.js';
import { getEmailTools } from './tools/email.js';
import { checkNewEmails, formatEmailNotification, buildEmailKeyboard, queryEmails, formatQueryResults } from './tools/providers/email/index.js';
import { connectMongo } from './db/mongo.js';
import { startIdleWatcher } from './tools/providers/email/watcher.js';
import logger from './utils/logger.js';

/**
 * @typedef {Object} HandleMessageParams
 * @property {'telegram'|'cli'} channelType - Channel type
 * @property {string|number} channelId - Channel-specific ID (chat ID for Telegram)
 * @property {string} userMessage - User's message text (caption for photos)
 * @property {Array<{data: Buffer, mime: string}>} [images] - Attached photos
 */

/**
 * Gateway state
 */
let gatewayState = {
  initialized: false,
  config: null,
  client: null,
  provider: null, // LLM provider instance for memory extraction
  sessionMap: new Map(), // channelKey -> sessionId
  sessionMapPath: null,
  messageCounters: new Map(), // sessionId -> message count
  emailPollInterval: null, // Email polling interval ID
  sendMessageCallback: null, // Telegram sendMessage function for email notifications
};

/**
 * Resolve session map file path
 * @returns {string}
 */
function resolveSessionMapPath() {
  return join(homedir(), '.ziron', 'sessions', 'session-map.json');
}

/**
 * Ensure sessions directory exists
 */
function ensureSessionsDir() {
  const dir = join(homedir(), '.ziron', 'sessions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load session map from disk
 * @returns {Map<string, string>}
 */
function loadSessionMap() {
  const sessionMapPath = resolveSessionMapPath();

  if (!existsSync(sessionMapPath)) {
    return new Map();
  }

  try {
    const content = readFileSync(sessionMapPath, 'utf8');
    const data = JSON.parse(content);
    return new Map(Object.entries(data));
  } catch (err) {
    logger.warn('Failed to load session map, starting fresh:', err.message);
    return new Map();
  }
}

/**
 * Save session map to disk
 * @param {Map<string, string>} sessionMap
 */
function saveSessionMap(sessionMap) {
  ensureSessionsDir();

  const sessionMapPath = resolveSessionMapPath();
  const data = Object.fromEntries(sessionMap);
  const json = JSON.stringify(data, null, 2);

  try {
    writeFileSync(sessionMapPath, json, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logger.error('Failed to save session map:', err.message);
  }
}

/**
 * Create channel key for session mapping
 * @param {'telegram'|'cli'} channelType
 * @param {string|number} channelId
 * @returns {string}
 */
function createChannelKey(channelType, channelId) {
  return `${channelType}:${channelId}`;
}

/**
 * Get or create session for a channel
 * @param {'telegram'|'cli'} channelType
 * @param {string|number} channelId
 * @returns {string} Session ID
 */
function getOrCreateSession(channelType, channelId) {
  const channelKey = createChannelKey(channelType, channelId);

  // Check if session already exists
  if (gatewayState.sessionMap.has(channelKey)) {
    return gatewayState.sessionMap.get(channelKey);
  }

  // Create new session
  const sessionId = createSession();
  gatewayState.sessionMap.set(channelKey, sessionId);

  // Persist to disk immediately
  saveSessionMap(gatewayState.sessionMap);

  logger.debug(`Created new session: ${channelKey} -> ${sessionId}`);

  return sessionId;
}

/**
 * Increment message counter for a session
 * Used to track when to trigger memory extraction
 * @param {string} sessionId - Session ID
 * @returns {number} New message count
 */
function incrementSessionMessageCount(sessionId) {
  const current = gatewayState.messageCounters.get(sessionId) || 0;
  const newCount = current + 1;
  gatewayState.messageCounters.set(sessionId, newCount);
  return newCount;
}

/** JSON for logs/dumps with image data URLs shortened (they are megabytes of base64) */
function redactImages(value) {
  return JSON.stringify(value, (k, v) =>
    (k === 'url' && typeof v === 'string' && v.startsWith('data:'))
      ? `${v.slice(0, v.indexOf(',') + 1)}…(${v.length} chars)`
      : v, 2);
}

/**
 * OpenRouter provider adapter for ZironClient
 * Adapts existing OpenRouter API to LLMProvider interface
 */
export class OpenRouterProviderAdapter {
  constructor(apiKey, model, maxTokens) {
    this.apiKey = apiKey;
    this.model = model || 'anthropic/claude-3.5-sonnet';
    this.maxTokens = maxTokens || 4096;
  }

  /**
   * Convert Anthropic tool format to OpenAI format
   * @param {Array} anthropicTools - Tools in Anthropic format
   * @returns {Array} Tools in OpenAI format
   */
  convertToolsToOpenAI(anthropicTools) {
    return anthropicTools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  /**
   * Convert Anthropic-style messages to OpenAI format
   * @param {Array} anthropicMessages - Messages in Anthropic format
   * @returns {Array} Messages in OpenAI format
   */
  convertMessagesToOpenAI(anthropicMessages) {
    const result = [];

    for (const msg of anthropicMessages) {
      if (msg.role === 'system') {
        // System message: pass through
        result.push(msg);
      } else if (msg.role === 'user') {
        // User message: check for tool_result blocks
        if (Array.isArray(msg.content)) {
          const textBlocks = msg.content.filter(b => b.type === 'text');
          const imageBlocks = msg.content.filter(b => b.type === 'image');
          const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');

          // Add tool results as tool messages FIRST
          for (const toolResult of toolResultBlocks) {
            result.push({
              role: 'tool',
              tool_call_id: toolResult.tool_use_id,
              content: typeof toolResult.content === 'string'
                ? toolResult.content
                : JSON.stringify(toolResult.content),
            });
          }

          // Add text content as user message AFTER tool results
          if (imageBlocks.length > 0) {
            // Multimodal: OpenAI content parts with data URLs
            result.push({
              role: 'user',
              content: [
                ...textBlocks.map(b => ({ type: 'text', text: b.text })),
                ...imageBlocks.map(b => ({
                  type: 'image_url',
                  image_url: { url: `data:${b.mediaType};base64,${b.data}` },
                })),
              ],
            });
          } else if (textBlocks.length > 0) {
            result.push({
              role: 'user',
              content: textBlocks.map(b => b.text).join('\n'),
            });
          }
        } else {
          // String content
          result.push(msg);
        }
      } else if (msg.role === 'assistant') {
        // Assistant message: extract tool_use blocks
        if (Array.isArray(msg.content)) {
          const textBlocks = msg.content.filter(b => b.type === 'text');
          const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');

          if (toolUseBlocks.length > 0) {
            // Has tool calls
            const textContent = textBlocks.map(b => b.text).join('\n') || null;
            const tool_calls = toolUseBlocks.map(b => ({
              id: b.id,
              type: 'function',
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input),
              },
            }));

            result.push({
              role: 'assistant',
              content: textContent,
              tool_calls,
            });
          } else {
            // No tool calls, just text
            result.push({
              role: 'assistant',
              content: textBlocks.map(b => b.text).join('\n'),
            });
          }
        } else {
          // String content
          result.push(msg);
        }
      }
    }

    return result;
  }

  /**
   * Chat method required by LLMProvider interface
   * @param {Object} params
   * @param {string} params.system - System prompt
   * @param {Array} params.messages - API messages (Anthropic format)
   * @param {Array} [params.tools] - Tool definitions (Anthropic format)
   * @param {number} [params.max_tokens] - Max tokens override
   * @returns {Promise<Object>} LLMResponse
   */
  async chat(params) {
    const { system, messages, tools, max_tokens, reasoning } = params;

    // Convert Anthropic-style messages to OpenAI format
    const convertedMessages = this.convertMessagesToOpenAI(messages);

    // Combine system + messages
    const openrouterMessages = [
      { role: 'system', content: system },
      ...convertedMessages,
    ];

    const payload = {
      model: this.model,
      messages: openrouterMessages,
      max_tokens: max_tokens || this.maxTokens,
      temperature: 1.0,
    };
    if (reasoning) payload.reasoning = reasoning;
    // Same private routing as providers/openrouter.js (no data retention/training)
    payload.provider = PRIVATE_ROUTING;

    // Convert and add tools if provided (OpenRouter uses OpenAI format)
    if (tools && tools.length > 0) {
      payload.tools = this.convertToolsToOpenAI(tools);
    }

    // Log LLM interaction deeply if asked
    logger.info(`[LLM OUT] Gửi yêu cầu lên OpenRouter (${this.model})...`);
    logger.info(`[LLM OUT] System Prompt dài ${system.length} kí tự.`);
    // Full message dump only in debug: it is the whole history every call
    logger.debug(`[LLM OUT] Tin nhắn gửi lên:`, redactImages(convertedMessages));

    // Dump full payload to ~/.ziron/prompts only when settings.logLevel = "debug"
    if (logger.isDebug()) try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `prompt_${timestamp}.json`;
      const debugPath = join(homedir(), '.ziron', 'prompts');
      
      // Ensure directory exists
      if (!existsSync(debugPath)) {
        mkdirSync(debugPath, { recursive: true });
      }
      
      writeFileSync(join(debugPath, filename), redactImages(payload));
      logger.info(`[Gateway] Đã lưu full payload vào file: ${join(debugPath, filename)}`);
    } catch (e) {
      // Ignore
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/yourusername/ziron',
        'X-Title': 'Ziron',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    logUsage('chat', data);

    if (!data.choices || !data.choices[0]) {
      throw new Error('Invalid API response: no choices');
    }

    const message = data.choices[0].message;
    const finishReason = data.choices[0].finish_reason;

    // Check if tool calls are present
    if (message.tool_calls && message.tool_calls.length > 0) {
      logger.info(`[LLM IN] OpenRouter phản hồi có gọi Tool(s)!`);
      // Convert OpenAI tool_calls format to Anthropic tool_use format
      const content = [];

      // Add text content if present
      if (message.content) {
        logger.info(`[LLM IN] Kèm text: ${message.content}`);
        content.push({ type: 'text', text: message.content });
      }

      // Add tool_use blocks
      for (const toolCall of message.tool_calls) {
        logger.info(`[LLM IN] Tool gọi: ${toolCall.function.name}`);
        logger.info(`[LLM IN] Data truyền vào:`, toolCall.function.arguments);
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments),
        });
      }

      return {
        content,
        stop_reason: 'tool_use',
      };
    }

    // No tool calls, return text content.
    // Some reasoning models (e.g. qwen3.5) leak chain-of-thought inline in `content`
    // as <think>...</think>, sometimes missing the opening tag — strip both cases.
    const messageContent = (message.content || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^[\s\S]*?<\/think>/i, '')
      .trim();
    logger.info(`[LLM IN] OpenRouter trả lời: ${messageContent.substring(0, 100)}...`);

    return {
      content: [{ type: 'text', text: messageContent }],
      stop_reason: finishReason === 'stop' ? 'end_turn' : finishReason,
    };
  }
}

/**
 * Get active chat IDs from session map
 * @returns {Array<string>} Array of chat IDs
 */
export function getActiveChatIds() {
  const chatIds = [];

  for (const [channelKey, sessionId] of gatewayState.sessionMap.entries()) {
    // channelKey format: "telegram:123456789"
    const match = channelKey.match(/^telegram:(.+)$/);
    if (match) {
      chatIds.push(match[1]);
    }
  }

  return chatIds;
}

/**
 * Start email polling if enabled
 * @param {Function} sendMessage - Telegram sendMessage function
 * @returns {void}
 */
function startEmailPolling(sendMessage) {
  const emailConfig = gatewayState.config?.tools?.email;

  if (!emailConfig?.enabled) {
    logger.debug('[Email Monitor] Email monitoring disabled in config');
    return;
  }

  if (!emailConfig.imap?.host || !emailConfig.imap?.user || !emailConfig.imap?.pass) {
    logger.warn('[Email Monitor] IMAP configuration incomplete, skipping email polling');
    return;
  }

  // IDLE push is the primary trigger; the interval poll is only a safety net.
  const intervalMinutes = emailConfig.pollIntervalMinutes
    || (emailConfig.pollIntervalHours ? emailConfig.pollIntervalHours * 60 : 15);
  const intervalMs = intervalMinutes * 60 * 1000;

  logger.info(`[Email Monitor] Starting email monitor (IDLE push + poll every ${intervalMinutes} min)`);

  // Serialize checks: IDLE events and the interval may fire together, and two
  // concurrent checks could both see a UID as new and notify twice.
  let checkRunning = false;
  let checkPending = false;
  const pollEmails = async () => {
    if (checkRunning) {
      checkPending = true;
      return;
    }
    checkRunning = true;
    try {
      do {
        checkPending = false;
        await pollEmailsOnce();
      } while (checkPending);
    } finally {
      checkRunning = false;
    }
  };

  const pollEmailsOnce = async () => {
    try {
      logger.info('[Email Monitor] Checking for new emails...');

      const importantEmails = await checkNewEmails(
        emailConfig.imap,
        'INBOX',
        emailConfig.startDate || null
      );

      if (importantEmails.length > 0) {
        const notification = formatEmailNotification(importantEmails);

        // Send to forced destination or all active chats.
        // When forced, send exactly once — the loop would otherwise send N
        // identical copies to the same destination.
        const forced = getForcedChatId(gatewayState.config);
        if (forced) {
          try {
            await sendMessage(forced, notification, { parse_mode: 'Markdown', reply_markup: buildEmailKeyboard(importantEmails) });
            logger.success(`[Email Monitor] Sent notification to forced chat ${forced}`);
          } catch (sendErr) {
            logger.error(`[Email Monitor] Failed to send to forced chat ${forced}:`, sendErr.message);
          }
        } else {
          const chatIds = getActiveChatIds();
          if (chatIds.length === 0) {
            logger.warn('[Email Monitor] No active chats to send notification to');
            return;
          }
          for (const chatId of chatIds) {
            try {
              await sendMessage(chatId, notification, { parse_mode: 'Markdown', reply_markup: buildEmailKeyboard(importantEmails) });
              logger.success(`[Email Monitor] Sent notification to chat ${chatId}`);
            } catch (sendErr) {
              logger.error(`[Email Monitor] Failed to send to chat ${chatId}:`, sendErr.message);
            }
          }
        }

        logger.success(`[Email Monitor] Notifications sent for ${importantEmails.length} email(s)`);
      } else {
        logger.debug('[Email Monitor] No important emails found');
      }

    } catch (err) {
      logger.error('[Email Monitor] Polling error:', err.message);
    }
  };

  // Run immediately on startup
  pollEmails().catch(err => {
    logger.error('[Email Monitor] Initial poll failed:', err.message);
  });

  // Schedule recurring polls (fallback) + push watcher
  gatewayState.emailPollInterval = setInterval(pollEmails, intervalMs);
  gatewayState.emailIdleStop = startIdleWatcher(emailConfig.imap, () => {
    pollEmails().catch(err => logger.error('[Email Monitor] IDLE-triggered poll failed:', err.message));
  });

  logger.success(`[Email Monitor] Email polling started`);
}

/**
 * Stop email polling
 * @returns {void}
 */
export function stopEmailPolling() {
  if (gatewayState.emailPollInterval) {
    clearInterval(gatewayState.emailPollInterval);
    gatewayState.emailPollInterval = null;
    logger.info('[Email Monitor] Email polling stopped');
  }
  if (gatewayState.emailIdleStop) {
    gatewayState.emailIdleStop();
    gatewayState.emailIdleStop = null;
  }
}

/**
 * Initialize the gateway
 * Must be called once on startup before handling any messages
 * @returns {Promise<void>}
 */
export async function initializeGateway() {
  if (gatewayState.initialized) {
    logger.warn('Gateway already initialized');
    return;
  }

  logger.info('🚀 Initializing gateway...');

  // Load config
  const config = loadConfig();
  gatewayState.config = config;

  // Load session map from disk
  gatewayState.sessionMap = loadSessionMap();
  gatewayState.sessionMapPath = resolveSessionMapPath();

  const sessionCount = gatewayState.sessionMap.size;
  if (sessionCount > 0) {
    logger.info(`Loaded ${sessionCount} existing sessions`);
  }

  // Check which provider is configured
  const hasOpenRouter = config.providers.openrouter.apiKey;
  const hasOpenAIKey = config.providers.openai.apiKey;
  const hasOpenAIOAuth = config.providers.openai.oauth.accessToken;

  if (!hasOpenRouter && !hasOpenAIKey && !hasOpenAIOAuth) {
    logger.warn('No AI provider configured - messages will fail');
    logger.info('Configure a provider:');
    logger.info('  - OpenRouter: Add OPENROUTER_API_KEY to .env');
    logger.info('  - OpenAI: Add OPENAI_API_KEY to .env or run: ziron auth openai-oauth');
    return;
  }

  // For now, only support OpenRouter
  // TODO: Add OpenAI provider adapters
  if (!hasOpenRouter) {
    logger.warn('Only OpenRouter provider is currently supported by gateway');
    logger.info('Please configure OpenRouter: OPENROUTER_API_KEY=your_key');
    return;
  }

  // Create provider instance
  const provider = new OpenRouterProviderAdapter(
    config.providers.openrouter.apiKey,
    config.providers.openrouter.model,
    config.providers.openrouter.maxTokens
  );

  // Store provider for memory extraction
  gatewayState.provider = provider;

  // Create ZironClient
  gatewayState.client = createClient(provider);

  // Initialize MongoDB if email is enabled
  if (config.tools?.email?.enabled) {
    const mongoUri = config.database?.mongoUri;
    if (mongoUri) {
      try {
        await connectMongo(mongoUri);
        logger.success('[Email Monitor] MongoDB connected for email state tracking');
      } catch (err) {
        logger.error('[Email Monitor] MongoDB connection failed:', err.message);
        logger.warn('[Email Monitor] Email monitoring will be disabled');
        config.tools.email.enabled = false;
      }
    } else {
      logger.warn('[Email Monitor] No MongoDB URI configured, email monitoring disabled');
      config.tools.email.enabled = false;
    }
  }

  gatewayState.initialized = true;
  logger.success('Gateway initialized with OpenRouter provider');
}

/**
 * Initialize email monitoring (call after scheduler is initialized)
 * @param {Function} sendMessage - Telegram sendMessage function
 * @returns {void}
 */
export function initEmailMonitoring(sendMessage) {
  if (!gatewayState.initialized) {
    throw new Error('Gateway must be initialized first');
  }

  gatewayState.sendMessageCallback = sendMessage;
  startEmailPolling(sendMessage);
}

/**
 * Handle incoming message from any channel
 * Routes message to appropriate session and returns LLM response
 *
 * @param {HandleMessageParams} params - Message parameters
 * @returns {Promise<string>} LLM response text
 *
 * @example
 * const response = await handleMessage({
 *   channelType: 'telegram',
 *   channelId: 123456789,
 *   userMessage: 'Hello!'
 * });
 */
export async function handleMessage(params) {
  if (!gatewayState.initialized) {
    throw new Error('Gateway not initialized. Call initializeGateway() first.');
  }

  if (!gatewayState.client) {
    throw new Error('No AI provider configured');
  }

  const { channelType, channelId, userMessage, images = [] } = params;

  // Get or create session for this channel
  const sessionId = getOrCreateSession(channelType, channelId);

  // Generate a refId for this conversation turn (used to group related jobs)
  const refId = randomUUID();

  // Scheduler/reminder delivery is always Telegram, regardless of which channel
  // (voice, telegram, ...) the request came in on, so this must resolve to the
  // configured owner's Telegram chat ID, not the per-channel session ID.
  // Used both as a prompt hint below and as a hard server-side override in
  // onToolCall further down — the LLM's own chatId argument is never trusted
  // for scheduler creation/listing calls.
  const forcedChatId = getForcedChatId(gatewayState.config) || channelId;

  // Current fixed offset for the configured zone, e.g. "GMT+1" (CET) / "GMT+2" (CEST)
  const userTimezone = gatewayState.config?.user?.timezone
    ? toGmtString(gatewayState.config.user.timezone)
    : '';

  // Build dynamic system prompt with context
  const systemPrompt = await buildSystemPrompt({
    context: {
      currentDate: new Date().toISOString(), // UTC time
      currentTimeUTC: new Date().toUTCString(), // Explicit UTC time string
      currentTimezoneContext: "CRITICAL TIMEZONE RULE: 1. You MUST know the user's explicit timezone offset (like UTC+7, EST, etc). 2. Look for it in the 'User's System Configured Timezone' above, OR in 'Personalization and Context' OR recent messages. 3. If you CANNOT find their explicit timezone offset, DO NOT CALL SCHEDULING TOOLS. Instead, reply: 'Vui lòng cho tôi biết múi giờ của bạn (VD: GMT+7)'. 4. Once you have the timezone offset, calculate the exact UTC time to pass to the tool. Example: User in GMT+7 asks for 14:00 -> Pass 07:00 UTC to tool.",
      location: gatewayState.config?.user?.location || '',
      // Resolve IANA zones (e.g. Europe/Berlin) to today's real offset so the
      // LLM and the GMT±N-only scheduler tools never use a stale DST offset.
      timezone: userTimezone
        ? `${userTimezone} (${gatewayState.config.user.timezone}, current offset incl. DST — this overrides any timezone/offset mentioned in memory or past messages)`
        : '',
      availableTools: ['scheduler', 'weather', 'email', 'query_emails'],
      chatId: forcedChatId,
      refId,
    },
    // includeMemory: true is default
  });

  // Get all available tools (scheduler + weather + email)
  const tools = [
    ...getSchedulerTools(),
    ...getWeatherTools(),
    ...getEmailTools(),
  ];

  // Tool call handler
  const onToolCall = async (name, input) => {
    // Server-side override, like forcedChatId: the timezone offset must come
    // from config (DST-aware), never from the LLM, which tends to copy a stale
    // offset out of memory or prompt examples (e.g. "GMT+2" in winter).
    if (name.startsWith('calculate') && userTimezone) {
      input = { ...input, timezone: userTimezone };
    }
    logger.info(`[Tool] ${name} called with:`, JSON.stringify(input));

    switch (name) {
      case 'calculateTime': {
        // Normalize "now" to "now + 0m" for compatibility
        const normalizedInput = {
          ...input,
          expression: input.expression.trim().toLowerCase() === 'now'
            ? 'now + 0m'
            : input.expression
        };
        const result = calculateTime(normalizedInput);
        return JSON.stringify(result, null, 2);
      }

      case 'calculateTimeRange': {
        const result = calculateTimeRange(input);
        return JSON.stringify(result, null, 2);
      }

      case 'calculateRecurringDays': {
        const result = calculateRecurringDays(input);
        return JSON.stringify(result, null, 2);
      }

      case 'calculateEndTime': {
        const result = calculateEndTime(input);
        return JSON.stringify(result, null, 2);
      }

      case 'calculateNextOccurrence': {
        const result = calculateNextOccurrence(input);
        return JSON.stringify(result, null, 2);
      }

      case 'calculateSpecificDates': {
        const result = calculateSpecificDates(input);
        return JSON.stringify(result, null, 2);
      }

      case 'addOneshotJob': {
        // chatId is always the configured owner's Telegram chat, never the
        // LLM-supplied argument - see forcedChatId above.
        const job = await addOneshotJob({ ...input, chatId: forcedChatId });
        return `Oneshot job created: ${job.name} at ${job.fire_at}`;
      }

      case 'addOneshotInterval': {
        const count = await addOneshotInterval({ ...input, chatId: forcedChatId });
        return `Oneshot interval created: ${count} jobs scheduled`;
      }

      case 'addRecurringJob': {
        const job = await addRecurringJob({ ...input, chatId: forcedChatId });
        return `Recurring job created: ${job.name}`;
      }

      case 'listTodayJobs': {
        // fire_at is UTC (storage); give the model the local time too so it
        // never has to convert when talking to the user
        const jobs = (await listTodayJobs(forcedChatId))
          .map(j => ({ ...j, fire_at_local: utcTimeToLocal(j.fire_at, j.date) }));
        return JSON.stringify(jobs, null, 2);
      }

      case 'disableJobsByName': {
        const count = await disableJobsByName(input.name, input.dateStr);
        return `Disabled ${count} jobs`;
      }

      case 'deleteJob': {
        // Only jobs that belong to the owner's chat can be deleted
        const owned = (await listMasterJobs(forcedChatId)).find(j => j.id === input.jobId);
        if (!owned) {
          return `No recurring job with id ${input.jobId} found. Call listMasterJobs to get the exact id.`;
        }
        const ok = await deleteJob(owned.id);
        return ok
          ? `Deleted recurring job "${owned.name}" permanently (it will not fire again).`
          : `Failed to delete job "${owned.name}".`;
      }

      case 'listMasterJobs': {
        const jobs = (await listMasterJobs(forcedChatId)).map(j => ({
          ...j,
          time_triggers: (j.time_triggers || []).map(t => ({
            ...t,
            time_local: shiftUtcTime(t.time, j.tz_offset_min ?? 120).slice(0, 5),
          })),
        }));
        return JSON.stringify(jobs, null, 2);
      }

      case 'get_weather': {
        // Get weather for a city
        const result = await getWeather(input);
        const formatted = formatWeather(result);

        // Return both formatted text and coordinates for scheduling
        return JSON.stringify({
          formatted,
          lat: result.lat,
          lon: result.lon,
          city: input.city
        }, null, 2);
      }

      case 'check_emails': {
        // Check for new important emails
        const emailConfig = gatewayState.config?.tools?.email;

        if (!emailConfig?.enabled) {
          return 'Email monitoring is not enabled in config';
        }

        if (!emailConfig.imap?.host || !emailConfig.imap?.user || !emailConfig.imap?.pass) {
          return 'Email IMAP configuration incomplete';
        }

        const importantEmails = await checkNewEmails(
          emailConfig.imap,
          'INBOX',
          emailConfig.startDate || null
        );
        const notification = formatEmailNotification(importantEmails);

        return notification || 'No new important emails';
      }

      case 'query_emails': {
        // Query stored emails from MongoDB
        const emailConfig = gatewayState.config?.tools?.email;

        if (!emailConfig?.enabled) {
          return 'Email monitoring is not enabled in config. No emails are stored.';
        }

        try {
          const emails = await queryEmails(input);
          const results = formatQueryResults(emails);

          return results;
        } catch (err) {
          logger.error('[Gateway] query_emails error:', err.message);
          return `Error querying emails: ${err.message}`;
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };

  // Use ZironClient to handle the conversation
  // Photos from the channel: stored under ~/.ziron/media/<session>/, history keeps the paths
  const storedImages = [];
  for (const img of images) {
    storedImages.push(await saveSessionImage(sessionId, img.data, img.mime));
  }

  const response = await gatewayState.client.run({
    sessionId,
    userMessage,
    systemPrompt,
    tools,
    onToolCall,
    images: storedImages,
  });

  // Memory extraction (background, non-blocking)
  const messageCount = incrementSessionMessageCount(sessionId);
  if (shouldExtractMemory(messageCount)) {
    logger.info(`[Memory] Extraction triggered for session ${sessionId.substring(0, 8)}... (message ${messageCount})`);

    // Run in background - do not await
    extractMemory(sessionId, gatewayState.provider)
      .then(() => {
        logger.success('[Memory] Extraction complete');
      })
      .catch(err => {
        logger.error('[Memory] Extraction failed:', err.message);
      });
  }

  return response;
}

/**
 * Get gateway status
 * @returns {Object} Status information
 */
export function getGatewayStatus() {
  return {
    initialized: gatewayState.initialized,
    sessionCount: gatewayState.sessionMap.size,
    hasProvider: gatewayState.client !== null,
    sessionMapPath: gatewayState.sessionMapPath,
  };
}

/**
 * Reset session for a channel (start new conversation)
 * @param {'telegram'|'cli'} channelType
 * @param {string|number} channelId
 * @returns {string} New session ID
 */
export function resetSession(channelType, channelId) {
  const channelKey = createChannelKey(channelType, channelId);

  // Get old session ID to clear counter
  const oldSessionId = gatewayState.sessionMap.get(channelKey);
  if (oldSessionId) {
    gatewayState.messageCounters.delete(oldSessionId);
  }

  // Create new session
  const sessionId = createSession();
  gatewayState.sessionMap.set(channelKey, sessionId);

  // Persist to disk
  saveSessionMap(gatewayState.sessionMap);

  logger.info(`Reset session: ${channelKey} -> ${sessionId}`);

  return sessionId;
}

/**
 * Get session ID for a channel (without creating new one)
 * @param {'telegram'|'cli'} channelType
 * @param {string|number} channelId
 * @returns {string|null} Session ID or null if not found
 */
export function getSessionId(channelType, channelId) {
  const channelKey = createChannelKey(channelType, channelId);
  return gatewayState.sessionMap.get(channelKey) || null;
}

// Re-export scheduler functions for use by Telegram handler
export {
  initScheduler,
  addRecurringJob,
  addOneshotJob,
  addOneshotInterval,
  disableJobsByName,
  listTodayJobs,
  listMasterJobs,
  deleteJob,
};

export default {
  initializeGateway,
  handleMessage,
  getGatewayStatus,
  resetSession,
  getSessionId,
  initEmailMonitoring,
  stopEmailPolling,
};
