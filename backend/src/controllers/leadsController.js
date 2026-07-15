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

const leadsController = {
  getLeads: async (req, res) => {
    try {
      const username = req.user.username; 
      
      
      const {
        search = '',
        sortBy = 'recent',
        channel = '',
        agent_id = '',
        lead_type = '',
        followup_filter = '',
        followup_date = '',
        last_interaction_days = '',
        lead_status = '',
        immediate = '',
        page = 1,
        limit = 50
      } = req.query;

     
      const [userRows] = await db.query(
        'SELECT id FROM users WHERE username = ? AND role = ?',
        [username, 'client']
      );

      if (userRows.length === 0) {
        return res.status(404).json({ message: 'Client not found' });
      }

     
      const [clientRows] = await db.query(
        'SELECT * FROM clients WHERE name = ?',
        [username]
      );

      if (clientRows.length === 0) {
        return res.status(404).json({ message: 'Client data not found' });
      }

      const clientId = clientRows[0].id;

     
      let whereConditions = ['c.client_id = ?'];
      let queryParams = [clientId];

      
      if (search) {
        whereConditions.push('(cu.name LIKE ? OR cu.email LIKE ? OR cu.phone LIKE ?)');
        const searchPattern = `%${search}%`;
        queryParams.push(searchPattern, searchPattern, searchPattern);
      }

      
      if (channel) {
        whereConditions.push('conv.channel = ?');
        queryParams.push(channel);
      }

      if (agent_id) {
        whereConditions.push('conv.agent_id = ?');
        queryParams.push(agent_id);
      }

      const lead_types = req.query.lead_type
        ? (Array.isArray(req.query.lead_type) ? req.query.lead_type : [req.query.lead_type])
        : [];

      if (lead_types.length > 0) {
        const hasUnknown = lead_types.includes('unknown');
        const knownTypes = lead_types.filter(t => t !== 'unknown');

        if (hasUnknown && knownTypes.length === 0) {
          whereConditions.push('NOT EXISTS (SELECT 1 FROM lead_summary ls WHERE ls.chat_user_id = cu.id AND ls.client_id = ?)');
          queryParams.push(clientId);
        } else if (!hasUnknown) {
          const placeholders = knownTypes.map(() => '?').join(',');
          whereConditions.push(`EXISTS (SELECT 1 FROM lead_summary ls WHERE ls.chat_user_id = cu.id AND ls.client_id = ? AND ls.lead_type IN (${placeholders}))`);
          queryParams.push(clientId, ...knownTypes);
        } else {
          const placeholders = knownTypes.map(() => '?').join(',');
          whereConditions.push(`(NOT EXISTS (SELECT 1 FROM lead_summary ls WHERE ls.chat_user_id = cu.id AND ls.client_id = ?) OR EXISTS (SELECT 1 FROM lead_summary ls WHERE ls.chat_user_id = cu.id AND ls.client_id = ? AND ls.lead_type IN (${placeholders})))`);
          queryParams.push(clientId, clientId, ...knownTypes);
        }
      }

      if (followup_filter) {
        const sub = 'EXISTS (SELECT 1 FROM lead_followups lf WHERE lf.chat_user_id = cu.id AND lf.client_id = ? AND lf.status = \'pending\'';
        if (followup_filter === 'today') {
          whereConditions.push(`${sub} AND DATE(lf.followup_date) = CURDATE())`);
          queryParams.push(clientId);
        } else if (followup_filter === 'tomorrow') {
          whereConditions.push(`${sub} AND DATE(lf.followup_date) = DATE_ADD(CURDATE(), INTERVAL 1 DAY))`);
          queryParams.push(clientId);
        } else if (followup_filter === 'week') {
          whereConditions.push(`${sub} AND lf.followup_date >= CURDATE() AND lf.followup_date < DATE_ADD(CURDATE(), INTERVAL 7 DAY))`);
          queryParams.push(clientId);
        } else if (followup_filter === 'custom' && followup_date) {
          whereConditions.push(`${sub} AND DATE(lf.followup_date) = ?)`);
          queryParams.push(clientId, followup_date);
        } else if (followup_filter === 'all_overdue') {
          whereConditions.push('EXISTS (SELECT 1 FROM lead_followups lf WHERE lf.chat_user_id = cu.id AND lf.client_id = ? AND lf.status != \'done\' AND DATE(lf.followup_date) <= CURDATE())');
          queryParams.push(clientId);
        }
      }

      const days = parseInt(last_interaction_days);
      if (days > 0) {
        whereConditions.push(
          `EXISTS (SELECT 1 FROM conversations c3 WHERE c3.chat_user_id = cu.id AND c3.client_id = ? AND c3.last_message_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY))`
        );
        queryParams.push(clientId);
      }

      if (lead_status) {
        whereConditions.push('EXISTS (SELECT 1 FROM lead_followups lf WHERE lf.chat_user_id = cu.id AND lf.client_id = ? AND lf.lead_status = ?)');
        queryParams.push(clientId, lead_status);
      }

      if (immediate === 'yes') {
        whereConditions.push('EXISTS (SELECT 1 FROM lead_followups lf WHERE lf.chat_user_id = cu.id AND lf.client_id = ? AND lf.immediate = \'yes\')');
        queryParams.push(clientId);
      }

      const whereClause = whereConditions.join(' AND ');

      let orderBy = 'cu.last_seen_at DESC'; // Default: most recent
      if (sortBy === 'oldest') {
        orderBy = 'cu.last_seen_at ASC';
      } else if (sortBy === 'name') {
        orderBy = 'cu.name ASC';
      }


      const offset = (page - 1) * limit;

      
      const [countResult] = await db.query(
        `SELECT COUNT(DISTINCT cu.id) as total
         FROM chat_users cu
         INNER JOIN conversations c ON cu.id = c.chat_user_id
         LEFT JOIN conversations conv ON cu.id = conv.chat_user_id
         WHERE ${whereClause}`,
        queryParams
      );

      const totalLeads = countResult[0].total;
      const totalPages = Math.ceil(totalLeads / limit);

      
      const query = `
        SELECT
          cu.id as user_id,
          cu.waid,
          cu.name as user_name,
          cu.email as user_email,
          cu.phone as user_phone,
          cu.is_active as user_active,
          cu.metadata as user_metadata,
          cu.first_seen_at,
          cu.last_seen_at,
          COUNT(DISTINCT conv.id) as total_conversations,
          SUM(CASE WHEN conv.status = 'active' THEN 1 ELSE 0 END) as active_conversations,
          MAX(conv.last_message_at) as last_conversation_at,
          COALESCE(
            (SELECT ls.lead_type FROM lead_summary ls WHERE ls.chat_user_id = cu.id AND ls.client_id = ? ORDER BY ls.created_at DESC LIMIT 1),
            'unknown'
          ) as lead_type,
          (
            SELECT m.message_text
            FROM messages m
            INNER JOIN conversations c2 ON m.conversation_id = c2.id
            WHERE c2.chat_user_id = cu.id AND c2.client_id = ? AND m.sender_type = 'user'
            ORDER BY m.created_at DESC
            LIMIT 1
          ) as last_message_text,
          (
            SELECT m.sender_type
            FROM messages m
            INNER JOIN conversations c2 ON m.conversation_id = c2.id
            WHERE c2.chat_user_id = cu.id AND c2.client_id = ?
            ORDER BY m.created_at DESC
            LIMIT 1
          ) as last_message_sender,
          (
            SELECT lf.followup_date
            FROM lead_followups lf
            WHERE lf.chat_user_id = cu.id AND lf.client_id = ?
            ORDER BY lf.followup_date ASC
            LIMIT 1
          ) as followup_date,
          (
            SELECT lf.status
            FROM lead_followups lf
            WHERE lf.chat_user_id = cu.id AND lf.client_id = ?
            ORDER BY lf.followup_date ASC
            LIMIT 1
          ) as followup_status,
          (
            SELECT lf.next_action
            FROM lead_followups lf
            WHERE lf.chat_user_id = cu.id AND lf.client_id = ?
            ORDER BY lf.followup_date ASC
            LIMIT 1
          ) as next_action,
          (
            SELECT lf.lead_status
            FROM lead_followups lf
            WHERE lf.chat_user_id = cu.id AND lf.client_id = ?
            ORDER BY lf.followup_date ASC
            LIMIT 1
          ) as lead_status,
          (
            SELECT JSON_UNQUOTE(JSON_EXTRACT(ls.lead_key_interests, '$.Budget'))
            FROM lead_summary ls
            WHERE ls.chat_user_id = cu.id AND ls.client_id = ?
            ORDER BY ls.created_at DESC LIMIT 1
          ) as budget,
          (
            SELECT JSON_OBJECT(
              'id', c2.id,
              'agent_id', c2.agent_id,
              'agent_name', a.name,
              'status', c2.status,
              'channel', c2.channel,
              'started_at', c2.started_at,
              'last_message_at', c2.last_message_at,
              'metadata', c2.metadata
            )
            FROM conversations c2
            LEFT JOIN agents a ON c2.agent_id = a.id
            WHERE c2.chat_user_id = cu.id AND c2.client_id = ?
            ORDER BY c2.last_message_at DESC
            LIMIT 1
          ) as latest_conversation
        FROM chat_users cu
        INNER JOIN conversations c ON cu.id = c.chat_user_id
        LEFT JOIN conversations conv ON cu.id = conv.chat_user_id AND conv.client_id = ?
        WHERE ${whereClause}
        GROUP BY cu.id
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `;

      queryParams.unshift(clientId, clientId, clientId, clientId, clientId, clientId, clientId, clientId, clientId, clientId);
      queryParams.push(parseInt(limit), parseInt(offset));

      const [leads] = await db.query(query, queryParams);

    
      const processedLeads = leads.map(lead => ({
        ...lead,
        user_metadata: safeJSONParse(lead.user_metadata),
        latest_conversation: safeJSONParse(lead.latest_conversation)
      }));


      const [agents] = await db.query(
        'SELECT id, name, agent_type FROM agents WHERE client_id = ? AND is_active = TRUE',
        [clientId]
      );


      const [channelStats] = await db.query(
        `SELECT channel, COUNT(*) as count
         FROM conversations
         WHERE client_id = ?
         GROUP BY channel`,
        [clientId]
      );

      res.json({
        success: true,
        data: {
          leads: processedLeads,
          pagination: {
            currentPage: parseInt(page),
            totalPages: totalPages,
            totalLeads: totalLeads,
            limit: parseInt(limit),
            hasNext: page < totalPages,
            hasPrev: page > 1
          },
          filters: {
            agents: agents,
            channels: channelStats
          }
        }
      });

    } catch (error) {
      console.error('Get leads error:', error);
      res.status(500).json({ 
        success: false,
        message: 'Error fetching leads',
        error: error.message 
      });
    }
  },
  getUserConversations: async (req, res) => {
  try {
    const username = req.user.username;
    const { userId } = req.params;
    
    const {
      sortBy = 'recent', // recent, oldest, duration, messages
      channel = '',
      agent_id = '',
      status = '',
      page = 1,
      limit = 20
    } = req.query;


    const [clientRows] = await db.query(
      'SELECT id FROM clients WHERE name = ?',
      [username]
    );

    if (clientRows.length === 0) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const clientId = clientRows[0].id;

   
    const [userRows] = await db.query(
      'SELECT * FROM chat_users WHERE id = ?',
      [userId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = userRows[0];


    let whereConditions = ['c.chat_user_id = ?', 'c.client_id = ?'];
    let queryParams = [userId, clientId];

    if (channel) {
      whereConditions.push('c.channel = ?');
      queryParams.push(channel);
    }

    if (agent_id) {
      whereConditions.push('c.agent_id = ?');
      queryParams.push(agent_id);
    }

    if (status) {
      whereConditions.push('c.status = ?');
      queryParams.push(status);
    }

    const whereClause = whereConditions.join(' AND ');

  
    let orderBy = 'c.last_message_at DESC'; // Default: most recent
    if (sortBy === 'oldest') {
      orderBy = 'c.started_at ASC';
    } else if (sortBy === 'duration') {
      orderBy = 'TIMESTAMPDIFF(MINUTE, c.started_at, c.last_message_at) DESC';
    } else if (sortBy === 'messages') {
      orderBy = 'message_count DESC';
    }

    
    const offset = (page - 1) * limit;

  
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total
       FROM conversations c
       WHERE ${whereClause}`,
      queryParams
    );

    const totalConversations = countResult[0].total;
    const totalPages = Math.ceil(totalConversations / limit);

    const query = `
      SELECT 
        c.id,
        c.agent_id,
        c.status,
        c.channel,
        c.started_at,
        c.last_message_at,
        c.metadata,
        a.name as agent_name,
        a.agent_type,
        COUNT(m.id) as message_count,
        TIMESTAMPDIFF(MINUTE, c.started_at, c.last_message_at) as duration_minutes,
        (
          SELECT m2.message_text
          FROM messages m2
          WHERE m2.conversation_id = c.id
          ORDER BY m2.created_at DESC
          LIMIT 1
        ) as last_message
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE ${whereClause}
      GROUP BY c.id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;

    queryParams.push(parseInt(limit), parseInt(offset));

    const [conversations] = await db.query(query, queryParams);

    const processedConversations = conversations.map(conv => ({
      ...conv,
      metadata: safeJSONParse(conv.metadata)
    }));

    const [agents] = await db.query(
      'SELECT id, name, agent_type FROM agents WHERE client_id = ? AND is_active = TRUE',
      [clientId]
    );

    const [channelStats] = await db.query(
      `SELECT channel, COUNT(*) as count
       FROM conversations
       WHERE chat_user_id = ? AND client_id = ?
       GROUP BY channel`,
      [userId, clientId]
    );

    const [statusStats] = await db.query(
      `SELECT status, COUNT(*) as count
       FROM conversations
       WHERE chat_user_id = ? AND client_id = ?
       GROUP BY status`,
      [userId, clientId]
    );

    res.json({
      success: true,
      data: {
        user: {
          ...user,
          metadata: safeJSONParse(user.metadata)
        },
        conversations: processedConversations,
        pagination: {
          currentPage: parseInt(page),
          totalPages: totalPages,
          totalConversations: totalConversations,
          limit: parseInt(limit),
          hasNext: page < totalPages,
          hasPrev: page > 1
        },
        filters: {
          agents: agents,
          channels: channelStats,
          statuses: statusStats
        }
      }
    });

  } catch (error) {
    console.error('Get user conversations error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error fetching conversations',
      error: error.message 
    });
  }
},

  // Get single lead details
  getLeadDetails: async (req, res) => {
    try {
      const username = req.user.username;
      const { userId } = req.params;

      const [clientRows] = await db.query(
        'SELECT id FROM clients WHERE name = ?',
        [username]
      );

      if (clientRows.length === 0) {
        return res.status(404).json({ message: 'Client not found' });
      }

      const clientId = clientRows[0].id;

      const [userRows] = await db.query(
        'SELECT * FROM chat_users WHERE id = ?',
        [userId]
      );

      if (userRows.length === 0) {
        return res.status(404).json({ message: 'User not found' });
      }

      const user = userRows[0];

      const [conversations] = await db.query(
        `SELECT 
          c.id,
          c.agent_id,
          c.status,
          c.channel,
          c.started_at,
          c.last_message_at,
          c.metadata,
          a.name as agent_name,
          a.agent_type,
          COUNT(m.id) as message_count
         FROM conversations c
         LEFT JOIN agents a ON c.agent_id = a.id
         LEFT JOIN messages m ON c.id = m.conversation_id
         WHERE c.chat_user_id = ? AND c.client_id = ?
         GROUP BY c.id
         ORDER BY c.last_message_at DESC`,
        [userId, clientId]
      );

      const [followupRows] = await db.query(
        'SELECT * FROM lead_followups WHERE chat_user_id = ? AND client_id = ? LIMIT 1',
        [userId, clientId]
      );

      res.json({
        success: true,
        data: {
          user: {
            ...user,
            metadata: safeJSONParse(user.metadata)
          },
          conversations: conversations.map(conv => ({
            ...conv,
            metadata: safeJSONParse(conv.metadata)
          })),
          followup: followupRows[0] || null,
        }
      });

    } catch (error) {
      console.error('Get lead details error:', error);
      res.status(500).json({ 
        success: false,
        message: 'Error fetching lead details',
        error: error.message 
      });
    }
  },

  bulkFollowupTemplate: async (req, res) => {
    try {
      const { templateName, tailParams, userIds } = req.body;
      // tailParams = [v2, v3, v4, v5] — v1 (name) is auto-filled per lead

      if (!templateName || !Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ success: false, message: 'templateName and userIds[] are required' });
      }
      if (!Array.isArray(tailParams)) {
        return res.status(400).json({ success: false, message: 'tailParams[] is required' });
      }

      const placeholders = userIds.map(() => '?').join(',');
      const [users] = await db.query(
        `SELECT id, name, waid, phone FROM chat_users WHERE id IN (${placeholders})`,
        userIds
      );

      const from = process.env.AZMARQ_BUSINESS_NUMBER;
      const results = [];

      for (const user of users) {
        const raw = user.waid || user.phone;
        if (!raw) {
          results.push({ userId: user.id, name: user.name, status: 'skipped', error: 'No phone number' });
          continue;
        }
        const to = raw.startsWith('+') ? raw : `+${raw}`;
        const params = [user.name || 'there', ...tailParams];

        try {
          const azRes = await fetch(`${process.env.AZMARQ_API_URL}/v1/whatsapp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': process.env.AZMARQ_API_KEY },
            body: JSON.stringify({
              from, to, type: 'template', templateName,
              components: { body: { params } },
            }),
          });

          if (!azRes.ok) {
            const errText = await azRes.text();
            results.push({ userId: user.id, name: user.name, status: 'failed', error: `HTTP ${azRes.status}: ${errText}` });
          } else {
            results.push({ userId: user.id, name: user.name, status: 'sent' });
          }
        } catch (err) {
          results.push({ userId: user.id, name: user.name, status: 'failed', error: err.message });
        }

        await new Promise(r => setTimeout(r, 150));
      }

      const sent    = results.filter(r => r.status === 'sent').length;
      const failed  = results.filter(r => r.status === 'failed').length;
      const skipped = results.filter(r => r.status === 'skipped').length;

      return res.json({ success: true, total: users.length, sent, failed, skipped, results });
    } catch (error) {
      console.error('Bulk followup error:', error);
      return res.status(500).json({ success: false, message: 'Bulk send failed', error: error.message });
    }
  },

  sendFollowupTemplate: async (req, res) => {
    try {
      const { userId } = req.params;
      const { templateName, params } = req.body;

      if (!templateName || !Array.isArray(params) || params.length === 0) {
        return res.status(400).json({ success: false, message: 'templateName and params[] are required' });
      }

      const username = req.user.username;
      const [clientRows] = await db.query('SELECT id FROM clients WHERE name = ?', [username]);
      if (clientRows.length === 0) return res.status(404).json({ success: false, message: 'Client not found' });
      const clientId = clientRows[0].id;

      const [userRows] = await db.query('SELECT * FROM chat_users WHERE id = ?', [userId]);
      if (userRows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

      const chatUser = userRows[0];
      const phone = chatUser.waid || chatUser.phone;
      if (!phone) return res.status(400).json({ success: false, message: 'Lead has no phone number' });

      const to = phone.startsWith('+') ? phone : `+${phone}`;
      const from = process.env.AZMARQ_BUSINESS_NUMBER;

      const azmarqRes = await fetch(`${process.env.AZMARQ_API_URL}/v1/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.AZMARQ_API_KEY,
        },
        body: JSON.stringify({
          from,
          to,
          type: 'template',
          templateName,
          components: {
            body: { params },
          },
        }),
      });

      if (!azmarqRes.ok) {
        const errText = await azmarqRes.text();
        return res.status(502).json({ success: false, message: `Azmarq error: ${errText}` });
      }

      // Record the follow-up as done
      await db.query(
        `UPDATE lead_followups SET last_followup = NOW(), status = 'done', updated_at = NOW()
         WHERE chat_user_id = ? AND client_id = ?`,
        [userId, clientId]
      );

      return res.json({ success: true, message: 'Template sent successfully' });
    } catch (error) {
      console.error('Send followup template error:', error);
      return res.status(500).json({ success: false, message: 'Failed to send template', error: error.message });
    }
  },

  updateLeadStatus: async (req, res) => {
    try {
      const { userId } = req.params;
      const { lead_status } = req.body;

      const VALID = ['new', 'contacted', 'call_done', 'site_visit', 'negotiation', 'booking_done', 'lost', null, ''];
      if (!VALID.includes(lead_status)) {
        return res.status(400).json({ success: false, message: 'Invalid lead_status value' });
      }

      const username = req.user.username;
      const [clientRows] = await db.query('SELECT id FROM clients WHERE name = ?', [username]);
      if (clientRows.length === 0) return res.status(404).json({ success: false, message: 'Client not found' });
      const clientId = clientRows[0].id;

      const [existing] = await db.query(
        'SELECT id FROM lead_followups WHERE chat_user_id = ? AND client_id = ?',
        [userId, clientId]
      );

      if (existing.length > 0) {
        await db.query(
          'UPDATE lead_followups SET lead_status = ?, updated_at = NOW() WHERE chat_user_id = ? AND client_id = ?',
          [lead_status || 'new', userId, clientId]
        );
      } else {
        await db.query(
          'INSERT INTO lead_followups (client_id, chat_user_id, lead_status, status) VALUES (?, ?, ?, ?)',
          [clientId, userId, lead_status || 'new', 'pending']
        );
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('Update lead_status error:', error);
      return res.status(500).json({ success: false, message: 'Failed to update lead status', error: error.message });
    }
  },

  updateNextAction: async (req, res) => {
    try {
      const { userId } = req.params;
      const { next_action } = req.body;

      const VALID = ['call', 'follow_up', 'visit', 'email', 'whatsapp', 'meeting', 'site_visit', 'other', null, ''];
      if (!VALID.includes(next_action)) {
        return res.status(400).json({ success: false, message: 'Invalid next_action value' });
      }

      const username = req.user.username;
      const [clientRows] = await db.query('SELECT id FROM clients WHERE name = ?', [username]);
      if (clientRows.length === 0) return res.status(404).json({ success: false, message: 'Client not found' });
      const clientId = clientRows[0].id;

      const [existing] = await db.query(
        'SELECT id FROM lead_followups WHERE chat_user_id = ? AND client_id = ?',
        [userId, clientId]
      );

      if (existing.length > 0) {
        await db.query(
          'UPDATE lead_followups SET next_action = ?, updated_at = NOW() WHERE chat_user_id = ? AND client_id = ?',
          [next_action || null, userId, clientId]
        );
      } else {
        await db.query(
          'INSERT INTO lead_followups (client_id, chat_user_id, next_action, status) VALUES (?, ?, ?, ?)',
          [clientId, userId, next_action || null, 'pending']
        );
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('Update next_action error:', error);
      return res.status(500).json({ success: false, message: 'Failed to update next action', error: error.message });
    }
  },

  deleteLead: async (req, res) => {
    try {
      const { userId } = req.params;
      const username = req.user.username;
      const [clientRows] = await db.query('SELECT id FROM clients WHERE name = ?', [username]);
      if (clientRows.length === 0) return res.status(404).json({ success: false, message: 'Client not found' });
      const clientId = clientRows[0].id;

      await db.query('DELETE FROM lead_followups WHERE chat_user_id = ?', [userId]);
      await db.query('DELETE FROM lead_summary   WHERE chat_user_id = ?', [userId]);
      await db.query('DELETE FROM messages       WHERE conversation_id IN (SELECT id FROM conversations WHERE chat_user_id = ?)', [userId]);
      await db.query('DELETE FROM conversations  WHERE chat_user_id = ?', [userId]);
      await db.query('DELETE FROM chat_users     WHERE id = ?', [userId]);

      return res.json({ success: true });
    } catch (error) {
      console.error('Delete lead error:', error);
      return res.status(500).json({ success: false, message: 'Failed to delete lead', error: error.message });
    }
  },

  scheduleVisit: async (req, res) => {
    try {
      const { userId } = req.params;
      const { visit_date, visit_time } = req.body;

      if (!visit_date) return res.status(400).json({ success: false, message: 'visit_date is required' });

      const username = req.user.username;
      const [clientRows] = await db.query('SELECT id FROM clients WHERE name = ?', [username]);
      if (clientRows.length === 0) return res.status(404).json({ success: false, message: 'Client not found' });
      const clientId = clientRows[0].id;

      const [existing] = await db.query(
        'SELECT id FROM lead_followups WHERE chat_user_id = ? AND client_id = ?',
        [userId, clientId]
      );

      if (existing.length > 0) {
        await db.query(
          `UPDATE lead_followups
           SET visit_date = ?, visit_time = ?, lead_status = 'site_visit', updated_at = NOW()
           WHERE chat_user_id = ? AND client_id = ?`,
          [visit_date, visit_time || null, userId, clientId]
        );
      } else {
        await db.query(
          `INSERT INTO lead_followups (client_id, chat_user_id, visit_date, visit_time, lead_status, status)
           VALUES (?, ?, ?, ?, 'site_visit', 'pending')`,
          [clientId, userId, visit_date, visit_time || null]
        );
      }

      // Auto-send site visit confirmation WhatsApp message
      try {
        const [userRows] = await db.query('SELECT name, waid FROM chat_users WHERE id = ?', [userId]);
        const chatUser = userRows[0];

        if (chatUser?.waid && chatUser.waid.length <= 15 && chatUser.name !== 'Web User') {
          // Get project name from lead_key_interests
          const [summaryRows] = await db.query(
            `SELECT JSON_UNQUOTE(JSON_EXTRACT(lead_key_interests, '$.Project')) as project
             FROM lead_summary WHERE chat_user_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 1`,
            [userId, clientId]
          );
          const project = summaryRows[0]?.project || username;

          const formattedDate = new Date(visit_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
          const formattedTime = visit_time ? visit_time.slice(0, 5) : 'TBD';

          const to   = `+${chatUser.waid}`;
          const from = process.env.AZMARQ_BUSINESS_NUMBER;

          await fetch(`${process.env.AZMARQ_API_URL}/v1/whatsapp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': process.env.AZMARQ_API_KEY },
            body: JSON.stringify({
              from, to,
              type: 'template',
              templateName: 'dreamex_site_visit',
              components: {
                body: { params: [chatUser.name || 'there', project, formattedDate, formattedTime] },
              },
            }),
          });
        }
      } catch (waErr) {
        console.error('Site visit WhatsApp send failed (non-fatal):', waErr.message);
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('Schedule visit error:', error);
      return res.status(500).json({ success: false, message: 'Failed to schedule visit', error: error.message });
    }
  },

  sendAdminAlert: async (req, res) => {
    try {
      const [countResult] = await db.query(
        `SELECT COUNT(DISTINCT chat_user_id) AS count
         FROM lead_summary
         WHERE lead_type IN ('high_intent', 'hot')`
      );
      const count = countResult[0].count ?? 0;

      const to   = '+919922115786';
      const from = process.env.AZMARQ_BUSINESS_NUMBER;

      const azRes = await fetch(`${process.env.AZMARQ_API_URL}/v1/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': process.env.AZMARQ_API_KEY },
        body: JSON.stringify({
          from, to,
          type: 'template',
          templateName: 'dreamex_reminder_first',
          components: { body: { params: [count.toString()] } },
        }),
      });

      if (!azRes.ok) {
        const errText = await azRes.text();
        return res.status(502).json({ success: false, message: `Azmarq error: ${errText}` });
      }

      return res.json({ success: true, message: `Alert sent — ${count} high intent/hot leads`, count });
    } catch (error) {
      console.error('Admin alert error:', error);
      return res.status(500).json({ success: false, message: 'Failed to send alert', error: error.message });
    }
  },

  getTemplates: async (req, res) => {
    try {
      const [rows] = await db.query('SELECT id, name, template, variables FROM whatsapp_templates ORDER BY id ASC');
      const templates = rows.map(r => ({
        ...r,
        variables: typeof r.variables === 'string' ? JSON.parse(r.variables) : r.variables,
      }));
      return res.json({ success: true, data: templates });
    } catch (error) {
      console.error('Get templates error:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch templates', error: error.message });
    }
  },

  updateFollowup: async (req, res) => {
    try {
      const { userId } = req.params;
      const { followup_date, status, note } = req.body;

      const username = req.user.username;
      const [clientRows] = await db.query('SELECT id FROM clients WHERE name = ?', [username]);
      if (clientRows.length === 0) return res.status(404).json({ success: false, message: 'Client not found' });
      const clientId = clientRows[0].id;

      const VALID_STATUS = ['pending', 'done', 'cancelled'];
      if (status && !VALID_STATUS.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
      }

      const [existing] = await db.query(
        'SELECT id FROM lead_followups WHERE chat_user_id = ? AND client_id = ?',
        [userId, clientId]
      );

      if (existing.length > 0) {
        await db.query(
          `UPDATE lead_followups
           SET followup_date = ?, status = ?, note = ?, last_followup = NOW(), updated_at = NOW()
           WHERE chat_user_id = ? AND client_id = ?`,
          [followup_date, status || 'pending', note || null, userId, clientId]
        );
      } else {
        await db.query(
          `INSERT INTO lead_followups (client_id, chat_user_id, followup_date, last_followup, status, note)
           VALUES (?, ?, ?, NOW(), ?, ?)`,
          [clientId, userId, followup_date, status || 'pending', note || null]
        );
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('Update followup error:', error);
      return res.status(500).json({ success: false, message: 'Failed to update follow-up', error: error.message });
    }
  }

};

module.exports = leadsController;