const logger = require('../utils/logger.js');
const _log = logger.child({ module: 'whatsappController' });
const db = require('../config/database');

const createLeadFollowup = async (clientId, chatUserId) => {
  try {
    const [existing] = await db.query(
      'SELECT id FROM lead_followups WHERE chat_user_id = ? AND client_id = ?',
      [chatUserId, clientId]
    );
    if (existing.length === 0) {
      await db.query(
        `INSERT INTO lead_followups (client_id, chat_user_id, followup_date, last_followup, status, note)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 3 DAY), NOW(), 'pending', NULL)`,
        [clientId, chatUserId]
      );
    }
  } catch (err) {
    console.error('[WA] Failed to create lead_followup:', err.message);
  }
};

const getAgentByBusinessNumber = async (businessNumber) => {
  const [agents] = await db.query(
    'SELECT * FROM agents WHERE wa_business_number = ? AND channel = ? AND is_active = 1 LIMIT 1',
    [businessNumber, 'whatsapp']
  );
  if (agents.length === 0) throw new Error(`No active WhatsApp agent found for business number: ${businessNumber}`);
  return agents[0];
};

const getOrCreateConversation = async (waId, agentId, clientId, profileName) => {
  const [existing] = await db.query(
    `SELECT c.*, cu.id as chat_user_id, cu.name as chat_user_name
     FROM conversations c
     JOIN chat_users cu ON c.chat_user_id = cu.id
     WHERE JSON_EXTRACT(c.metadata, '$.external_conversation_id') = ?
     AND c.client_id = ?
     AND c.is_active = 1
     LIMIT 1`,
    [waId, clientId]
  );

  if (existing.length > 0) {
    await db.query(
      'UPDATE conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = ?',
      [existing[0].id]
    );
    await db.query(
      'UPDATE chat_users SET last_seen_at = NOW() WHERE id = ?',
      [existing[0].chat_user_id]
    );
    _log.info(`[WA] Existing conversation ${existing[0].id} for ${waId}`);
    return { conversation: existing[0], chatUserId: existing[0].chat_user_id };
  }

  _log.info(`[WA] Creating new conversation for ${waId}`);
  const username = profileName || `WA_${waId}`;

  const [userResult] = await db.query(
    `INSERT INTO chat_users (waid, name, is_active, metadata, first_seen_at, last_seen_at)
     VALUES (?, ?, 1, ?, NOW(), NOW())`,
    [waId, username, JSON.stringify({ source: 'whatsapp', wa_id: waId })]
  );
  const chatUserId = userResult.insertId;
  _log.info(`[WA] Created chat_user: ${username} (ID: ${chatUserId})`);

  const [convResult] = await db.query(
    `INSERT INTO conversations
     (agent_id, chat_user_id, client_id, status, channel, is_active, metadata, started_at, last_message_at)
     VALUES (?, ?, ?, 'active', 'whatsapp', 1, ?, NOW(), NOW())`,
    [agentId, chatUserId, clientId, JSON.stringify({
      external_conversation_id: waId,
      source: 'whatsapp'
    })]
  );
  const [newConv] = await db.query('SELECT * FROM conversations WHERE id = ?', [convResult.insertId]);
  _log.info(`[WA] Created conversation ${convResult.insertId}`);
  await createLeadFollowup(clientId, chatUserId);
  return { conversation: newConv[0], chatUserId };
};

const saveMessage = async (conversationId, senderType, senderId, messageText, messageType = 'text', metadata = {}) => {
  const [result] = await db.query(
    `INSERT INTO messages
     (conversation_id, sender_type, sender_id, message_text, message_type, is_read, is_active, metadata, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
    [
      conversationId, senderType, senderId, messageText, messageType,
      senderType === 'agent' ? 1 : 0,
      JSON.stringify(metadata)
    ]
  );
  _log.info(`[WA] Saved ${senderType} message: ${result.insertId}`);
  return result.insertId;
};


// Azmarq flat format (confirmed from real webhook):
// {
//   from: "<business number>",        ← your Azmarq WhatsApp number
//   contacts: {
//     profileName: "<customer name>",
//     recipient: "<customer number>"  ← who sent the message
//   },
//   messages: { type, text: { body }, timestamp }
// }

const normalizeAzmarqPayload = (body) => {
  // waId — try nested contacts.recipient first, then flat waid/to fields
  const waId = body?.contacts?.recipient || body?.waid || body?.to;

  const businessNumber = body?.from;
  const msgId          = body?.messageId || `wa_${Date.now()}`;
  const msgType        = body?.messages?.type || body?.type || 'text';

  // Support all Azmarq payload formats for interactive replies
  const msgBody =
    body?.messages?.text?.body                                  ||  // plain text
    body?.text?.body                                            ||  // flat plain text
    body?.messages?.interactive?.text?.button_reply?.title      ||  // actual Azmarq button click format
    body?.messages?.interactive?.text?.list_reply?.title        ||  // actual Azmarq list selection format
    body?.messages?.interactive?.button_reply?.title            ||  // fallback button click
    body?.messages?.interactive?.list_reply?.title              ||  // fallback list selection
    body?.interactive?.button_reply?.title                      ||  // flat button click
    body?.interactive?.list_reply?.title                        ||  // flat list selection
    body?.messages?.button?.text                                ||  // quick reply
    body?.button?.text                                          ||  // flat quick reply
    '';

  // Normalize to allowed DB enum values
  const ALLOWED_TYPES = ['text', 'image', 'file', 'audio', 'video'];
  const safeType = ALLOWED_TYPES.includes(msgType) ? msgType : 'text';

  const name = body?.contacts?.profileName || body?.profileName || `WA_${waId}`;
  const ts   = body?.messages?.timestamp || body?.timestamp || Date.now();

  return { waId, businessNumber, msgId, msgType: safeType, msgBody, name, ts };
};


const buildN8nPayload = ({ waId, msgId, msgType, msgBody, name, ts }) => ({
  channel: 'api',
  conversationId: waId,           // phone number acts as conversation ID
  messageId: msgId,
  from: waId,
  event: 'message_received',
  contacts: {
    profileName: name,
    recipient: waId,
  },
  messages: {
    type: msgType,
    text: { body: msgBody },
    timestamp: ts,
  },
});

// Send image message with optional caption
const sendImageReply = async (from, to, imageUrl, caption, azmarqApiKey) => {
  const url = `${process.env.AZMARQ_API_URL}/v1/whatsapp`;
  _log.info(`[WA] Sending image reply — from: ${from}, to: ${to}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': azmarqApiKey },
    body: JSON.stringify({
      recipient_type: 'individual',
      from, to,
      type: 'image',
      image: {
        link: imageUrl,
        ...(caption ? { caption } : {}),
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Azmarq image send failed (${response.status}): ${errText}`);
  }

  _log.info(`[WA] Image delivered to ${to}`);
  return response.json();
};

// Send interactive message — buttons (≤3) or list (4–10)
const sendInteractiveReply = async (from, to, body, buttons, azmarqApiKey) => {
  const url = `${process.env.AZMARQ_API_URL}/v1/whatsapp`;
  _log.info(`[WA] Sending interactive reply — from: ${from}, to: ${to}, buttons: ${buttons.length}`);

  let interactive;

  // Use list when >3 buttons OR any title exceeds 20 chars (button limit)
  const useList = buttons.length > 3 || buttons.some(b => b.title.length > 20);

  if (!useList) {
    // Button message — max 3 buttons, titles ≤20 chars
    interactive = {
      type: 'button',
      body: { text: body },
      action: {
        buttons: buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    };
  } else {
    // List message — up to 10 options, titles ≤24 chars
    interactive = {
      type: 'list',
      body: { text: body },
      action: {
        button: 'Select',
        sections: [{
          title: 'Options',
          rows: buttons.map(b => ({
            id: b.id,
            title: b.title,
          })),
        }],
      },
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': azmarqApiKey },
    body: JSON.stringify({ recipient_type: 'individual', from, to, type: 'interactive', interactive }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Azmarq interactive send failed (${response.status}): ${errText}`);
  }

  _log.info(`[WA] Interactive reply delivered to ${to}`);
  return response.json();
};

// Endpoint confirmed: POST https://api.azmarq.com/v1/whatsapp
const sendWhatsappReply = async (from, to, text, azmarqApiKey) => {
  const url = `${process.env.AZMARQ_API_URL}/v1/whatsapp`;
  _log.info(`[WA] Sending reply — from: ${from}, to: ${to}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': azmarqApiKey,
    },
    body: JSON.stringify({
      recipient_type: 'individual',
      from,
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Azmarq send failed (${response.status}): ${errText}`);
  }

  _log.info(`[WA] Reply delivered to ${to}`);
  _log.info(`[WA] Azmarq response status: ${response.status}`);
  return response.json();
};


const whatsappController = {

  webhook: async (req, res) => {
    // Verify request is from Azmarq using the secret header
    const secret = req.headers['x-azmarq-secret'];
    if (process.env.AZMARQ_WEBHOOK_SECRET && secret !== process.env.AZMARQ_WEBHOOK_SECRET) {
      _log.warn(`[WA] Unauthorized webhook attempt — invalid secret: "${secret}"`);
      return res.status(401).json({ status: 'unauthorized' });
    }

    // Respond 200 immediately — Azmarq will retry if it doesn't get a fast response
    res.status(200).json({ status: 'ok' });

    // Write raw payload to DB for debugging (can query without server access)
    try { await db.query('INSERT INTO webhook_debug_log (raw_payload) VALUES (?)', [JSON.stringify(req.body)]); } catch {}
    _log.info(`[WA] Raw payload: ${JSON.stringify(req.body)}`);

    const { waId, businessNumber, msgId, msgType, msgBody, name, ts } = normalizeAzmarqPayload(req.body);

    const event = req.body?.event;
    // Allow message_received AND interactive/button events — skip only status events
    const SKIP_EVENTS = ['message_delivered', 'message_read', 'message_failed', 'message_sent'];
    if (event && SKIP_EVENTS.includes(event)) return;

    if (!waId || waId === 'unknown') {
      _log.warn('[WA] Could not extract waId — skipping');
      return;
    }
    if (!msgBody) {
      _log.warn(`[WA] Empty msgBody for event="${event}" type="${req.body?.messages?.type || req.body?.type}" — skipping`);
      return;
    }

    try {
      if (!businessNumber) throw new Error('businessNumber missing from Azmarq payload');

      const agent = await getAgentByBusinessNumber(businessNumber);
      _log.info(`[WA] ${businessNumber} — message from ${waId}`);

      const { conversation, chatUserId } = await getOrCreateConversation(
        waId, agent.id, agent.client_id, name
      );

      await saveMessage(conversation.id, 'user', chatUserId, msgBody, msgType, {
        messageId: msgId, timestamp: ts, channel: 'whatsapp'
      });
      await db.query('UPDATE chat_users SET is_summarized = 0 WHERE id = ?', [chatUserId]);

      const n8nPayload = buildN8nPayload({ waId, msgId, msgType, msgBody, name, ts });

      const n8nAbort = new AbortController();
      const n8nTimeout = setTimeout(() => n8nAbort.abort(), 20000);
      const n8nRes = await fetch(agent.n8n_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-n8n-flow-webhook-auth': '0SCxpZqX6R7e' },
        body: JSON.stringify(n8nPayload),
        signal: n8nAbort.signal,
      }).finally(() => clearTimeout(n8nTimeout));

      if (!n8nRes.ok) {
        const errBody = await n8nRes.text();
        throw new Error(`n8n failed (${n8nRes.status}): ${errBody}`);
      }

      const n8nText = await n8nRes.text();
      const n8nJson = n8nText ? JSON.parse(n8nText) : {};
      const aiReply      = n8nJson.output      || 'Sorry, I could not process your request.';
      const messageType  = n8nJson.messageType || 'text';
      const buttonBody   = n8nJson.body        || aiReply;
      const buttons      = n8nJson.buttons      || [];

      await saveMessage(conversation.id, 'agent', agent.id, aiReply, 'text', {
        n8n_response_time: new Date().toISOString(), processed: true
      });

      const formattedTo = waId.startsWith('+') ? waId : `+${waId}`;

      if (messageType === 'image' && n8nJson.imageUrl) {
        // Send image first, then buttons if present
        await sendImageReply(businessNumber, formattedTo, n8nJson.imageUrl, buttonBody || '', agent.azmarq_api_key);
        if (buttons.length >= 2) {
          await new Promise(r => setTimeout(r, 800));
          await sendInteractiveReply(businessNumber, formattedTo, '👇 Choose one:', buttons, agent.azmarq_api_key);
        }
      } else if (messageType === 'buttons' && buttons.length >= 2) {
        await sendInteractiveReply(businessNumber, formattedTo, buttonBody, buttons, agent.azmarq_api_key);
      } else {
        await sendWhatsappReply(businessNumber, formattedTo, aiReply, agent.azmarq_api_key);
      }

    } catch (error) {
      const reason = error.name === 'AbortError' ? 'n8n timed out (20s)' : error.message;
      _log.error(`[WA] ${waId} — ${reason}`);
    }
  },

};

module.exports = whatsappController;
