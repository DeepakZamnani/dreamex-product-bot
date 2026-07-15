const logger = require('../utils/logger.js');
const _log = logger.child({module: 'chatController'});
const { randomUUID } = require('crypto');
const db = require('../config/database');


const safeJSONParse = (data) => {
  if (!data) return null;
  if (typeof data === 'object') return data;
  try {
    return JSON.parse(data);
  } catch (e) {
    console.error('JSON parse error:', e);
    return null;
  }
};

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
    _log.error('Failed to create lead_followup:', err.message);
  }
};

const getAgentBySlug = async (slug) => {
  const [clients] = await db.query(
    'SELECT id FROM clients WHERE web_slug = ? AND is_active = 1 LIMIT 1',
    [slug]
  );
  if (clients.length === 0) throw new Error(`No active client found for slug: "${slug}"`);
  const clientId = clients[0].id;

  const [agents] = await db.query(
    'SELECT * FROM agents WHERE client_id = ? AND channel = ? AND is_active = 1 LIMIT 1',
    [clientId, 'web']
  );
  if (agents.length === 0) throw new Error(`No active web agent found for client slug: "${slug}"`);
  return agents[0];
};

const getOrCreateConversation = async (externalConversationId, agentId, clientId, channel, profileName) => {
  try {
    const [existingConversations] = await db.query(
      `SELECT c.*, cu.id as chat_user_id, cu.name as chat_user_name
       FROM conversations c
       JOIN chat_users cu ON c.chat_user_id = cu.id
       WHERE JSON_EXTRACT(c.metadata, '$.external_conversation_id') = ?
       AND c.client_id = ?
       AND c.is_active = 1
       LIMIT 1`,
      [externalConversationId, clientId]
    );

    if (existingConversations.length > 0) {
    
      await db.query(
        'UPDATE conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = ?',
        [existingConversations[0].id]
      );
      
      await db.query(
        'UPDATE chat_users SET last_seen_at = NOW() WHERE id = ?',
        [existingConversations[0].chat_user_id]
      );
      
      _log.info(`Using existing conversation: ${existingConversations[0].id} with user: ${existingConversations[0].chat_user_id}`);
      
      return {
        conversation: existingConversations[0],
        chatUserId: existingConversations[0].chat_user_id
      };
    }

    _log.info(`Creating new conversation for external ID: ${externalConversationId}`);
    
    const waid = `web_conv_${externalConversationId}`;
    const [userCount] = await db.query('SELECT COUNT(*) as count FROM chat_users');
    const userNumber = userCount[0].count + 1;
    const username = profileName || `WebUser_${userNumber}`;

    const [userResult] = await db.query(
      `INSERT INTO chat_users (waid, name, is_active, metadata, first_seen_at, last_seen_at)
       VALUES (?, ?, 1, ?, NOW(), NOW())`,
      [
        waid,
        username,
        JSON.stringify({ 
          source: 'web', 
          conversation_id: externalConversationId,
          user_number: userNumber
        })
      ]
    );

    const chatUserId = userResult.insertId;
    _log.info(`Created new chat user: ${username} (ID: ${chatUserId})`);

    const [convResult] = await db.query(
      `INSERT INTO conversations 
       (agent_id, chat_user_id, client_id, status, channel, is_active, metadata, started_at, last_message_at)
       VALUES (?, ?, ?, 'active', ?, 1, ?, NOW(), NOW())`,
      [
        agentId,
        chatUserId,
        clientId,
        channel || 'api',
        JSON.stringify({ 
          external_conversation_id: externalConversationId,
          source: 'web_chat'
        })
      ]
    );

    const [newConversation] = await db.query(
      'SELECT * FROM conversations WHERE id = ?',
      [convResult.insertId]
    );

    _log.info(`Created new conversation: ${convResult.insertId}`);
    await createLeadFollowup(clientId, chatUserId);

    return {
      conversation: newConversation[0],
      chatUserId: chatUserId
    };
    
  } catch (error) {
    _log.error('Error in getOrCreateConversation:', error);
    throw error;
  }
};

const saveMessage = async (conversationId, senderType, senderId, messageText, messageType = 'text', metadata = {}) => {
  try {
    const [result] = await db.query(
      `INSERT INTO messages 
       (conversation_id, sender_type, sender_id, message_text, message_type, is_read, is_active, metadata, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
      [
        conversationId,
        senderType,
        senderId,
        messageText,
        messageType,
        senderType === 'agent' ? 1 : 0, 
        JSON.stringify(metadata)
      ]
    );

    _log.info(`Saved ${senderType} message: ${result.insertId}`);
    return result.insertId;
  } catch (error) {
    _log.error('Error saving message:', error);
    throw error;
  }
};

const chatController = {
  
  webhook: async (req, res) => {
    const messageId = req.body.messageId || 'unknown';
    const slug = req.params.slug;
    _log.info(`[chat] ${slug} — message received`);

    try {
      const {
        conversationId,
        channel,
        contacts,
        messages,
      } = req.body;

      if (!conversationId) throw new Error('conversationId is required');
      if (!slug) throw new Error('Client slug is required in URL');

      const profileName = contacts?.profileName || 'Web User';
      const userMessage = messages?.text?.body || '';
      const messageType = messages?.type || 'text';

      const agent = await getAgentBySlug(slug);

      const { conversation, chatUserId } = await getOrCreateConversation(
        conversationId,
        agent.id,
        agent.client_id,
        channel || 'api',
        profileName
      );

      await saveMessage(conversation.id, 'user', chatUserId, userMessage, messageType, {
        messageId,
        timestamp: messages?.timestamp,
        channel: channel || 'api'
      });
      await db.query('UPDATE chat_users SET is_summarized = 0 WHERE id = ?', [chatUserId]);

      const n8nPayload = {
        ...req.body,
        channel: 'api',
        event: 'message_received',
        from: req.body.from || conversationId,
        contacts: {
          ...req.body.contacts,
          recipient: req.body.contacts?.recipient || conversationId,
        },
        messages: {
          ...req.body.messages,
          timestamp: req.body.messages?.timestamp || Date.now(),
        },
      };

      const response_n8n = await fetch(agent.n8n_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-n8n-flow-webhook-auth': '0SCxpZqX6R7e'
        },
        body: JSON.stringify(n8nPayload)
      });

      if (!response_n8n.ok) throw new Error(`n8n responded with status: ${response_n8n.status}`);

      const response_n8n_text = await response_n8n.text();
      const response_n8n_json = response_n8n_text ? JSON.parse(response_n8n_text) : {};

      const aiResponse = response_n8n_json.output || 'Sorry, I could not process your request.';
      await saveMessage(conversation.id, 'agent', agent.id, aiResponse, 'text', {
        n8n_response_time: new Date().toISOString(),
        processed: true
      });

      res.json({ output: aiResponse });

    } catch (error) {
      _log.error(`[chat] ${slug} — ${error.message}`);
      res.status(200).json({
        output: "Something went wrong. Please try again later."
      });
    }
  },

  getNewConversationId: async (req, res) => {
    try {
      const newConversationId = randomUUID();
      _log.info('Generated conversation ID:', newConversationId);
      
      res.json({
        success: true,
        data: {
          conversationId: newConversationId
        }
      });
    } catch (error) {
      _log.error('Conversation ID generation failed:', error);
      res.status(500).json({ 
        success: false,
        message: 'Error generating conversation ID',
        error: error.message 
      });
    }
  },
};

module.exports = chatController;