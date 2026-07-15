const db = require('../config/database');

// Helper function to safely parse JSON
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

const messagesController = {
  // Get all messages for a conversation
  getConversationMessages: async (req, res) => {
    try {
      const username = req.user.username;
      const { conversationId } = req.params;

      // Get client_id
      const [clientRows] = await db.query(
        'SELECT id FROM clients WHERE name = ?',
        [username]
      );

      if (clientRows.length === 0) {
        return res.status(404).json({ message: 'Client not found' });
      }

      const clientId = clientRows[0].id;

      // Get conversation details with verification
      const [conversationRows] = await db.query(
        `SELECT 
          c.id,
          c.agent_id,
          c.chat_user_id,
          c.status,
          c.channel,
          c.started_at,
          c.last_message_at,
          c.metadata,
          a.name as agent_name,
          a.agent_type,
          cu.name as user_name,
          cu.email as user_email,
          cu.phone as user_phone,
          cu.waid
         FROM conversations c
         LEFT JOIN agents a ON c.agent_id = a.id
         LEFT JOIN chat_users cu ON c.chat_user_id = cu.id
         WHERE c.id = ? AND c.client_id = ?`,
        [conversationId, clientId]
      );

      if (conversationRows.length === 0) {
        return res.status(404).json({ message: 'Conversation not found' });
      }

      const conversation = conversationRows[0];

      // Get all messages for this conversation
      const [messages] = await db.query(
        `SELECT 
          m.id,
          m.sender_type,
          m.sender_id,
          m.message_text,
          m.message_type,
          m.media_url,
          m.is_read,
          m.sent_at,
          m.delivered_at,
          m.read_at,
          m.metadata,
          m.created_at,
          CASE 
            WHEN m.sender_type = 'user' THEN cu.name
            WHEN m.sender_type = 'agent' THEN a.name
            ELSE 'System'
          END as sender_name
         FROM messages m
         LEFT JOIN chat_users cu ON m.sender_type = 'user' AND m.sender_id = cu.id
         LEFT JOIN agents a ON m.sender_type = 'agent' AND m.sender_id = a.id
         WHERE m.conversation_id = ?
         ORDER BY m.created_at ASC`,
        [conversationId]
      );

      // Parse JSON fields
      const processedMessages = messages.map(msg => ({
        ...msg,
        metadata: safeJSONParse(msg.metadata)
      }));

      // Get message statistics
      const [statsRows] = await db.query(
        `SELECT 
          COUNT(*) as total_messages,
          SUM(CASE WHEN sender_type = 'user' THEN 1 ELSE 0 END) as user_messages,
          SUM(CASE WHEN sender_type = 'agent' THEN 1 ELSE 0 END) as agent_messages,
          SUM(CASE WHEN is_read = TRUE THEN 1 ELSE 0 END) as read_messages,
          MIN(created_at) as first_message_at,
          MAX(created_at) as last_message_at
         FROM messages
         WHERE conversation_id = ?`,
        [conversationId]
      );

      const stats = statsRows[0];

      res.json({
        success: true,
        data: {
          conversation: {
            ...conversation,
            metadata: safeJSONParse(conversation.metadata)
          },
          messages: processedMessages,
          stats: stats
        }
      });

    } catch (error) {
      console.error('Get conversation messages error:', error);
      res.status(500).json({ 
        success: false,
        message: 'Error fetching messages',
        error: error.message 
      });
    }
  },

  // Get all messages for a user across all conversations
  getUserAllMessages: async (req, res) => {
    try {
      const username = req.user.username;
      const { userId } = req.params;
      
      const {
        startDate = '',
        endDate = '',
        channel = '',
        agent_id = '',
        limit = 500
      } = req.query;

      // Get client_id
      const [clientRows] = await db.query(
        'SELECT id FROM clients WHERE name = ?',
        [username]
      );

      if (clientRows.length === 0) {
        return res.status(404).json({ message: 'Client not found' });
      }

      const clientId = clientRows[0].id;

      // Get user details
      const [userRows] = await db.query(
        'SELECT * FROM chat_users WHERE id = ?',
        [userId]
      );

      if (userRows.length === 0) {
        return res.status(404).json({ message: 'User not found' });
      }

      const user = userRows[0];

      // Build WHERE clause for filters
      let whereConditions = ['c.chat_user_id = ?', 'c.client_id = ?'];
      let queryParams = [userId, clientId];

      // Convert date to datetime format for proper filtering
      if (startDate) {
        whereConditions.push('m.created_at >= ?');
        queryParams.push(`${startDate} 00:00:00`);
      }

      if (endDate) {
        whereConditions.push('m.created_at <= ?');
        queryParams.push(`${endDate} 23:59:59`);
      }

      if (channel) {
        whereConditions.push('c.channel = ?');
        queryParams.push(channel);
      }

      if (agent_id) {
        whereConditions.push('c.agent_id = ?');
        queryParams.push(agent_id);
      }

      const whereClause = whereConditions.join(' AND ');

      // Get all messages with conversation details
      const messagesQuery = `
        SELECT 
          m.id,
          m.conversation_id,
          m.sender_type,
          m.sender_id,
          m.message_text,
          m.message_type,
          m.media_url,
          m.is_read,
          m.sent_at,
          m.delivered_at,
          m.read_at,
          m.metadata,
          m.created_at,
          c.channel,
          c.status as conversation_status,
          c.started_at as conversation_started_at,
          a.name as agent_name,
          a.agent_type,
          CASE 
            WHEN m.sender_type = 'user' THEN cu.name
            WHEN m.sender_type = 'agent' THEN a.name
            ELSE 'System'
          END as sender_name
         FROM messages m
         INNER JOIN conversations c ON m.conversation_id = c.id
         LEFT JOIN agents a ON c.agent_id = a.id
         LEFT JOIN chat_users cu ON m.sender_type = 'user' AND m.sender_id = cu.id
         WHERE ${whereClause}
         ORDER BY m.created_at DESC
         LIMIT ?
      `;

      const messagesQueryParams = [...queryParams, parseInt(limit)];
      const [messages] = await db.query(messagesQuery, messagesQueryParams);

      // Parse JSON fields
      const processedMessages = messages.map(msg => ({
        ...msg,
        metadata: safeJSONParse(msg.metadata)
      }));

      // Get overall statistics - build separate WHERE clause for stats
      let statsWhereConditions = ['c.chat_user_id = ?', 'c.client_id = ?'];
      let statsQueryParams = [userId, clientId];

      if (startDate) {
        statsWhereConditions.push('m.created_at >= ?');
        statsQueryParams.push(`${startDate} 00:00:00`);
      }

      if (endDate) {
        statsWhereConditions.push('m.created_at <= ?');
        statsQueryParams.push(`${endDate} 23:59:59`);
      }

      if (channel) {
        statsWhereConditions.push('c.channel = ?');
        statsQueryParams.push(channel);
      }

      if (agent_id) {
        statsWhereConditions.push('c.agent_id = ?');
        statsQueryParams.push(agent_id);
      }

      const statsWhereClause = statsWhereConditions.join(' AND ');

      const [statsRows] = await db.query(
        `SELECT
          COUNT(DISTINCT c.id) as total_conversations,
          COUNT(m.id) as total_messages,
          SUM(CASE WHEN m.sender_type = 'user' THEN 1 ELSE 0 END) as user_messages,
          SUM(CASE WHEN m.sender_type = 'agent' THEN 1 ELSE 0 END) as agent_messages,
          SUM(CASE WHEN m.is_read = TRUE THEN 1 ELSE 0 END) as read_messages,
          MIN(m.created_at) as first_message_at,
          MAX(m.created_at) as last_message_at,
          SUM(CASE WHEN m.sender_type = 'user' AND LOWER(m.message_text) REGEXP '(^|[[:space:]])what([[:space:]]|$)' THEN 1 ELSE 0 END) as q_what,
          SUM(CASE WHEN m.sender_type = 'user' AND LOWER(m.message_text) REGEXP '(^|[[:space:]])where([[:space:]]|$)' THEN 1 ELSE 0 END) as q_where,
          SUM(CASE WHEN m.sender_type = 'user' AND LOWER(m.message_text) REGEXP '(^|[[:space:]])when([[:space:]]|$)' THEN 1 ELSE 0 END) as q_when,
          SUM(CASE WHEN m.sender_type = 'user' AND LOWER(m.message_text) REGEXP '(^|[[:space:]])how([[:space:]]|$)' THEN 1 ELSE 0 END) as q_how,
          SUM(CASE WHEN m.sender_type = 'user' AND INSTR(m.message_text, CHAR(63)) > 0 THEN 1 ELSE 0 END) as q_mark
         FROM messages m
         INNER JOIN conversations c ON m.conversation_id = c.id
         WHERE ${statsWhereClause}`,
        statsQueryParams
      );

      const stats = statsRows[0];

      // Get available filters - only for this user's conversations
      const [agents] = await db.query(
        `SELECT DISTINCT a.id, a.name, a.agent_type
         FROM conversations c
         INNER JOIN agents a ON c.agent_id = a.id
         WHERE c.chat_user_id = ? AND c.client_id = ?`,
        [userId, clientId]
      );

      const [channels] = await db.query(
        `SELECT DISTINCT channel, COUNT(*) as count
         FROM conversations
         WHERE chat_user_id = ? AND client_id = ?
         GROUP BY channel`,
        [userId, clientId]
      );

      res.json({
        success: true,
        data: {
          user: {
            ...user,
            metadata: safeJSONParse(user.metadata)
          },
          messages: processedMessages,
          stats: stats,
          filters: {
            agents: agents,
            channels: channels
          }
        }
      });

    } catch (error) {
      console.error('Get user all messages error:', error);
      res.status(500).json({ 
        success: false,
        message: 'Error fetching user messages',
        error: error.message 
      });
    }
  }
};

module.exports = messagesController;