const db = require('../config/database');

const CHANNEL_COLORS = {
  whatsapp: '#25D366',
  web:      'oklch(0.58 0.22 295)',
  mobile:   'oklch(0.62 0.22 0)',
  email:    'oklch(0.65 0.17 70)',
  api:      'oklch(0.62 0.14 235)',
};

const LEAD_TYPE_ORDER = ['high_intent', 'hot', 'warm', 'cold', 'dead'];
const LEAD_TYPE_LABELS = {
  high_intent: 'High Intent',
  hot:         'Hot',
  warm:        'Warm',
  cold:        'Cold',
  dead:        'Dead',
};

const dashboardController = {
  getDashboardMetrics: async (req, res) => {
    try {
      const username = req.user.username;

      const [userRows] = await db.query(
        'SELECT id FROM users WHERE username = ? AND role = ?',
        [username, 'client']
      );
      if (userRows.length === 0) {
        return res.status(404).json({ success: false, message: 'Client not found' });
      }

      const [clientRows] = await db.query(
        'SELECT * FROM clients WHERE name = ?',
        [username]
      );
      if (clientRows.length === 0) {
        return res.status(404).json({ success: false, message: 'Client data not found' });
      }

      const clientId = clientRows[0].id;
      const clientData = clientRows[0];

      // ── Core counts ──────────────────────────────────────────────────────
      const [[{ count: totalConversations }]] = await db.query(
        'SELECT COUNT(*) as count FROM conversations WHERE client_id = ?',
        [clientId]
      );

      const [[{ count: totalMessages }]] = await db.query(
        `SELECT COUNT(*) as count
         FROM messages m
         INNER JOIN conversations c ON m.conversation_id = c.id
         WHERE c.client_id = ?`,
        [clientId]
      );

      const [[{ count: totalAgents }]] = await db.query(
        'SELECT COUNT(*) as count FROM agents WHERE client_id = ?',
        [clientId]
      );

      const [[{ avg_messages }]] = await db.query(
        `SELECT AVG(message_count) as avg_messages
         FROM (
           SELECT c.id, COUNT(m.id) as message_count
           FROM conversations c
           LEFT JOIN messages m ON c.id = m.conversation_id
           WHERE c.client_id = ?
           GROUP BY c.id
         ) as sub`,
        [clientId]
      );

      // ── Total chat users (total unique leads) ────────────────────────────
      const [[{ totalChatUsers }]] = await db.query(
        `SELECT COUNT(DISTINCT cu.id) as totalChatUsers
         FROM chat_users cu
         INNER JOIN conversations c ON cu.id = c.chat_user_id
         WHERE c.client_id = ?`,
        [clientId]
      );

      // ── Fresh leads today (new chat_users first seen today) ──────────────
      const [[{ freshLeadsToday }]] = await db.query(
        `SELECT COUNT(DISTINCT cu.id) as freshLeadsToday
         FROM chat_users cu
         INNER JOIN conversations c ON cu.id = c.chat_user_id
         WHERE c.client_id = ?
           AND DATE(cu.created_at) = CURDATE()`,
        [clientId]
      );

      // ── Follow-ups due today ─────────────────────────────────────────────
      const [[{ followupsToday }]] = await db.query(
        `SELECT COUNT(*) as followupsToday
         FROM lead_followups
         WHERE client_id = ?
           AND status = 'pending'
           AND DATE(followup_date) = CURDATE()`,
        [clientId]
      );

      // ── All pending/overdue follow-ups (up to today, status not done) ────
      const [[{ totalPendingFollowups }]] = await db.query(
        `SELECT COUNT(*) as totalPendingFollowups
         FROM lead_followups
         WHERE client_id = ?
           AND status != 'done'
           AND DATE(followup_date) <= CURDATE()`,
        [clientId]
      );

      // ── Immediate leads (needs response now) ────────────────────────────
      const [[{ immediateCount }]] = await db.query(
        `SELECT COUNT(DISTINCT lf.chat_user_id) as immediateCount
         FROM lead_followups lf
         INNER JOIN conversations c ON lf.chat_user_id = c.chat_user_id AND c.client_id = ?
         WHERE lf.client_id = ? AND lf.immediate = 'yes'`,
        [clientId, clientId]
      );

      // ── Funnel: Call Done ────────────────────────────────────────────────
      const [[{ callDoneCount }]] = await db.query(
        `SELECT COUNT(DISTINCT cu.id) as callDoneCount
         FROM chat_users cu
         INNER JOIN conversations c ON cu.id = c.chat_user_id AND c.client_id = ?
         WHERE (
           SELECT lf.lead_status FROM lead_followups lf
           WHERE lf.chat_user_id = cu.id AND lf.client_id = ?
           ORDER BY lf.created_at DESC LIMIT 1
         ) = 'call_done'`,
        [clientId, clientId]
      );

      // ── Funnel: Site Visit ───────────────────────────────────────────────
      const [[{ siteVisitCount }]] = await db.query(
        `SELECT COUNT(DISTINCT cu.id) as siteVisitCount
         FROM chat_users cu
         INNER JOIN conversations c ON cu.id = c.chat_user_id AND c.client_id = ?
         WHERE (
           SELECT lf.lead_status FROM lead_followups lf
           WHERE lf.chat_user_id = cu.id AND lf.client_id = ?
           ORDER BY lf.created_at DESC LIMIT 1
         ) = 'site_visit'`,
        [clientId, clientId]
      );

      // ── Funnel: On Closure (booking_done + negotiation) ──────────────────
      const [[{ onClosureCount }]] = await db.query(
        `SELECT COUNT(DISTINCT cu.id) as onClosureCount
         FROM chat_users cu
         INNER JOIN conversations c ON cu.id = c.chat_user_id AND c.client_id = ?
         WHERE (
           SELECT lf.lead_status FROM lead_followups lf
           WHERE lf.chat_user_id = cu.id AND lf.client_id = ?
           ORDER BY lf.created_at DESC LIMIT 1
         ) IN ('negotiation')`,
        [clientId, clientId]
      );

      // ── High intent leads with status 'new' (not yet contacted) ─────────
      const [[{ highIntentNewCount }]] = await db.query(
        `SELECT COUNT(DISTINCT ls.chat_user_id) as highIntentNewCount
         FROM lead_summary ls
         INNER JOIN conversations c ON ls.chat_user_id = c.chat_user_id AND c.client_id = ?
         WHERE ls.lead_type = 'high_intent'
           AND COALESCE(
             (SELECT lf.lead_status FROM lead_followups lf
              WHERE lf.chat_user_id = ls.chat_user_id AND lf.client_id = ?
              ORDER BY lf.created_at DESC LIMIT 1),
             'new'
           ) = 'new'`,
        [clientId, clientId]
      );

      // ── Lead funnel by lead_type ─────────────────────────────────────────
      const [leadTypesRaw] = await db.query(
        `SELECT ls.lead_type, COUNT(DISTINCT ls.chat_user_id) as count
         FROM lead_summary ls
         INNER JOIN conversations c ON ls.chat_user_id = c.chat_user_id
         WHERE c.client_id = ?
         GROUP BY ls.lead_type`,
        [clientId]
      );

      const leadTypeMap = {};
      leadTypesRaw.forEach(r => { leadTypeMap[r.lead_type] = Number(r.count); });
      const leadFunnel = LEAD_TYPE_ORDER
        .filter(t => leadTypeMap[t] !== undefined)
        .map(t => ({ stage: LEAD_TYPE_LABELS[t], count: leadTypeMap[t] }));

      // ── Leads captured per day (last 30 days) ────────────────────────────
      const [leadsPerDayRaw] = await db.query(
        `SELECT DATE(cu.created_at) as date, COUNT(DISTINCT cu.id) as count
         FROM chat_users cu
         INNER JOIN conversations c ON cu.id = c.chat_user_id
         WHERE c.client_id = ?
           AND cu.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         GROUP BY DATE(cu.created_at)
         ORDER BY date ASC`,
        [clientId]
      );

      // Fill missing days with 0
      const leadsPerDay = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const found = leadsPerDayRaw.find(r => r.date.toISOString
          ? r.date.toISOString().slice(0, 10) === key
          : String(r.date).slice(0, 10) === key
        );
        leadsPerDay.push({ date: key, count: found ? Number(found.count) : 0 });
      }

      // ── Conversations by channel ─────────────────────────────────────────
      const [channelRaw] = await db.query(
        `SELECT channel, COUNT(*) as count
         FROM conversations
         WHERE client_id = ?
         GROUP BY channel
         ORDER BY count DESC`,
        [clientId]
      );

      const conversationsByChannel = channelRaw.map(r => ({
        channel:  r.channel,
        value:    Number(r.count),
        color:    CHANNEL_COLORS[r.channel] || '#8a94a6',
      }));

      // ── Key interests aggregation ─────────────────────────────────────────
      const [interestRows] = await db.query(
        `SELECT lead_key_interests
         FROM lead_summary
         WHERE client_id = ?
           AND lead_key_interests IS NOT NULL
           AND JSON_TYPE(lead_key_interests) = 'OBJECT'`,
        [clientId]
      );

      const keyCounts = {};
      for (const row of interestRows) {
        let interests = row.lead_key_interests;
        if (typeof interests === 'string') {
          try { interests = JSON.parse(interests); } catch { continue; }
        }
        if (interests && typeof interests === 'object' && !Array.isArray(interests)) {
          for (const key of Object.keys(interests)) {
            keyCounts[key] = (keyCounts[key] || 0) + 1;
          }
        }
      }

      const TOP_N = 7;
      const sorted = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
      const top    = sorted.slice(0, TOP_N);
      const rest   = sorted.slice(TOP_N);
      const otherTotal = rest.reduce((s, [, c]) => s + c, 0);

      const keyInterestStats = top.map(([key, count]) => ({ key, count }));
      if (otherTotal > 0) {
        const existingOther = keyInterestStats.find(s => s.key === 'Other');
        if (existingOther) existingOther.count += otherTotal;
        else keyInterestStats.push({ key: 'Other', count: otherTotal });
      }

      // ── Live conversations (updated in last 2 hours) ──────────────────────
      const [liveConversations] = await db.query(
        `SELECT c.id, cu.name as user_name, cu.phone, c.channel,
                c.updated_at, c.status, a.name as agent_name
         FROM conversations c
         LEFT JOIN chat_users cu ON c.chat_user_id = cu.id
         LEFT JOIN agents a ON c.agent_id = a.id
         WHERE c.client_id = ?
           AND c.updated_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR)
         ORDER BY c.updated_at DESC
         LIMIT 10`,
        [clientId]
      );

      // ── Agents list ──────────────────────────────────────────────────────
      const [agents] = await db.query(
        `SELECT id, name, agent_type, status, is_active, created_at
         FROM agents
         WHERE client_id = ?
         ORDER BY is_active DESC, name ASC`,
        [clientId]
      );

      // ── Growth vs previous month ─────────────────────────────────────────
      const [[{ count: prevConvs }]] = await db.query(
        `SELECT COUNT(*) as count
         FROM conversations
         WHERE client_id = ?
           AND created_at >= DATE_SUB(DATE_SUB(NOW(), INTERVAL 1 MONTH), INTERVAL 1 MONTH)
           AND created_at <  DATE_SUB(NOW(), INTERVAL 1 MONTH)`,
        [clientId]
      );

      const conversationGrowth = prevConvs > 0
        ? ((totalConversations - prevConvs) / prevConvs * 100).toFixed(1)
        : 0;

      res.json({
        success: true,
        data: {
          client: {
            name:         clientData.name,
            company_name: clientData.company_name,
            email:        clientData.email,
            status:       clientData.status,
          },
          metrics: {
            totalConversations:        Number(totalConversations),
            totalMessages:             Number(totalMessages),
            totalAgents:               Number(totalAgents),
            totalChatUsers:            Number(totalChatUsers),
            avgMessagesPerConversation: avg_messages
              ? parseFloat(avg_messages).toFixed(1)
              : '0',
            freshLeadsToday:           Number(freshLeadsToday),
            followupsToday:            Number(followupsToday),
            totalPendingFollowups:     Number(totalPendingFollowups),
            highIntentNewCount:        Number(highIntentNewCount),
            immediateCount:            Number(immediateCount),
            callDoneCount:             Number(callDoneCount),
            siteVisitCount:            Number(siteVisitCount),
            onClosureCount:            Number(onClosureCount),
          },
          growth: {
            conversations: conversationGrowth,
          },
          leadFunnel,
          leadsPerDay,
          conversationsByChannel,
          keyInterestStats,
          liveConversations,
          agents,
        },
      });
    } catch (error) {
      console.error('Dashboard metrics error:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching dashboard metrics',
        error: error.message,
      });
    }
  },
};

module.exports = dashboardController;
