const db = require('../config/database');

const getAdminDashboard = async (req, res) => {
  try {
    
    const [overviewStats] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM clients WHERE is_active = TRUE) as totalClients,
        (SELECT COUNT(*) FROM agents WHERE is_active = TRUE) as totalAgents,
        (SELECT COUNT(*) FROM chat_users WHERE is_active = TRUE) as totalChatUsers,
        (SELECT COUNT(*) FROM conversations WHERE status = 'active') as activeConversations,
        (SELECT COUNT(*) FROM conversations) as totalConversations,
        (SELECT COUNT(*) FROM messages) as totalMessages,
        (SELECT COUNT(*) FROM chat_users WHERE DATE(created_at) = CURDATE()) as newLeadsToday,
        (SELECT ROUND(COUNT(m.id) / COUNT(DISTINCT m.conversation_id), 1) 
        FROM messages m) as avgMessagesPerConversation
    `);

    const [clientStats] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM clients WHERE status = 'active' AND is_active = TRUE) as activeClients,
        (SELECT COUNT(*) FROM clients WHERE MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())) as newThisMonth
    `);

    const [topClients] = await db.query(`
      SELECT 
        c.id,
        c.name,
        c.company_name,
        COUNT(DISTINCT conv.id) as conversations,
        COUNT(DISTINCT a.id) as agents
      FROM clients c
      LEFT JOIN agents a ON c.id = a.client_id
      LEFT JOIN conversations conv ON a.id = conv.agent_id
      WHERE c.is_active = TRUE
      GROUP BY c.id, c.name, c.company_name
      ORDER BY conversations DESC
      LIMIT 10
    `);

    const [agentStats] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM agents WHERE status = 'active' AND is_active = TRUE) as activeAgents,
        (SELECT COUNT(*) FROM agents WHERE is_active = TRUE) as totalAgents
    `);

    const [agentsByType] = await db.query(`
      SELECT 
        agent_type as type,
        COUNT(*) as count
      FROM agents
      WHERE is_active = TRUE
      GROUP BY agent_type
      ORDER BY count DESC
    `);

    const [conversationStats] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE DATE(started_at) = CURDATE()) as todayConversations,
        (SELECT COUNT(*) FROM conversations WHERE status = 'active') as activeConversations,
        (SELECT COUNT(*) FROM conversations WHERE status = 'closed') as closedConversations
        
    `);

    const avgResponseTime = "2.3s";

    const [conversationsByStatus] = await db.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM conversations
      GROUP BY status
      ORDER BY count DESC
    `);

    const [channelDistribution] = await db.query(`
      SELECT 
        channel,
        COUNT(*) as count
      FROM conversations
      GROUP BY channel
      ORDER BY count DESC
    `);

    const [brochureStats] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM brochure_generations) as totalBrochures,
        (SELECT COUNT(*) FROM brochure_generations WHERE DATE(created_at) = CURDATE()) as brochuresToday
    `);

    const [recentActivity] = await db.query(`
      (
        SELECT 
          'new_client' as type,
          CONCAT('New client registered: ', name) as description,
          created_at as timestamp
        FROM clients
        WHERE is_active = TRUE
        ORDER BY created_at DESC
        LIMIT 3
      )
      UNION ALL
      (
        SELECT 
          'new_agent' as type,
          CONCAT('New agent created: ', name) as description,
          created_at as timestamp
        FROM agents
        WHERE is_active = TRUE
        ORDER BY created_at DESC
        LIMIT 3
      )
      UNION ALL
      (
        SELECT 
          'new_conversation' as type,
          CONCAT('New conversation started on ', channel) as description,
          started_at as timestamp
        FROM conversations
        ORDER BY started_at DESC
        LIMIT 2
      )
      UNION ALL
      (
        SELECT 
          'new_lead' as type,
          CONCAT('New lead: ', name) as description,
          created_at as timestamp
        FROM chat_users
        WHERE is_active = TRUE
        ORDER BY created_at DESC
        LIMIT 2
      )
      ORDER BY timestamp DESC
      LIMIT 10
    `);

    const formattedActivity = recentActivity.map(activity => {
      const now = new Date();
      const activityDate = new Date(activity.timestamp);
      const diffMs = now - activityDate;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      let timeAgo;
      if (diffMins < 1) {
        timeAgo = 'Just now';
      } else if (diffMins < 60) {
        timeAgo = `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
      } else if (diffHours < 24) {
        timeAgo = `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      } else {
        timeAgo = `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
      }

      return {
        type: activity.type,
        description: activity.description,
        time: timeAgo,
        timestamp: activity.timestamp
      };
    });

    const dashboardData = {
      overview: {
        totalClients: overviewStats[0].totalClients,
        totalAgents: overviewStats[0].totalAgents,
        totalChatUsers: overviewStats[0].totalChatUsers,
        activeConversations: overviewStats[0].activeConversations,
        totalConversations: overviewStats[0].totalConversations,
        totalMessages: overviewStats[0].totalMessages,
        newLeadsToday: overviewStats[0].newLeadsToday,
        avgMessagesPerConversation: overviewStats[0].avgMessagesPerConversation
      },
      clientStats: {
        activeClients: clientStats[0].activeClients,
        newThisMonth: clientStats[0].newThisMonth,
        topClients: topClients
      },
      agentStats: {
        activeAgents: agentStats[0].activeAgents,
        totalAgents: agentStats[0].totalAgents,
        byType: agentsByType
      },
      conversationStats: {
        todayConversations: conversationStats[0].todayConversations,
        activeConversations: conversationStats[0].activeConversations,
        avgResponseTime: avgResponseTime,
        byStatus: conversationsByStatus
      },
      channelStats: channelDistribution,
      recentActivity: formattedActivity,
      brochureStats: {
        totalBrochures: brochureStats[0].totalBrochures,
        brochuresToday: brochureStats[0].brochuresToday
      }
    };

    res.status(200).json(dashboardData);

  } catch (error) {
    console.error('Error fetching admin dashboard:', error);
    res.status(500).json({ 
      message: 'Error fetching dashboard data',
      error: error.message 
    });
  }
};

module.exports = {
  getAdminDashboard
};