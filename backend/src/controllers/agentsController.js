const db = require('../config/database');


const getAllAgents = async (req, res) => {
  try {
    const { role, id } = req.user;

    console.log('[GET ALL AGENTS] User info:', {
      role,
      id,
      fullUser: req.user
    });

    let query = `
      SELECT 
        a.*,
        c.name as client_name,
        c.company_name,
        c.email as client_email
      FROM agents a
      LEFT JOIN clients c ON a.client_id = c.id
      WHERE a.is_active = 1
    `;

    let queryParams = [];

  
    if (role === 'client') {
      
      query += ` AND a.client_id = ? `;
      queryParams = [id];
    }

    query += ` ORDER BY a.created_at DESC`;

    console.log('[GET ALL AGENTS] Query:', query);
    console.log('[GET ALL AGENTS] Params:', queryParams);

    const [agents] = queryParams.length > 0 
      ? await db.query(query, queryParams)
      : await db.query(query);

    console.log('[GET ALL AGENTS] Found agents:', agents.length);


    const parsedAgents = agents.map(agent => ({
      ...agent,
      is_active: agent.is_active === 1 || agent.is_active === true,
      configuration: typeof agent.configuration === 'string' 
        ? JSON.parse(agent.configuration) 
        : agent.configuration,
      metadata: typeof agent.metadata === 'string' 
        ? JSON.parse(agent.metadata) 
        : agent.metadata
    }));

    console.log(`[GET ALL AGENTS] Returning ${parsedAgents.length} agents for role: ${role}`);

    res.status(200).json(parsedAgents);

  } catch (error) {
    console.error('[GET ALL AGENTS] Error:', error);
    res.status(500).json({ 
      message: 'Error fetching agents',
      error: error.message 
    });
  }
};

const getAgentById = async (req, res) => {
  try {
    const { id } = req.params;
    const { role, clientId } = req.user;

    let query = `
      SELECT 
        a.*,
        c.name as client_name,
        c.company_name,
        c.email as client_email
      FROM agents a
      LEFT JOIN clients c ON a.client_id = c.id
      WHERE a.id = ? AND a.is_active = TRUE
    `;


    if (role === 'client') {
      query += ` AND a.client_id = ?`;
    }

    const [agents] = role === 'client'
      ? await db.query(query, [id, clientId])
      : await db.query(query, [id]);

    if (agents.length === 0) {
      return res.status(404).json({ message: 'Agent not found' });
    }

    const agent = agents[0];

    agent.configuration = typeof agent.configuration === 'string' 
      ? JSON.parse(agent.configuration) 
      : agent.configuration;
    agent.metadata = typeof agent.metadata === 'string' 
      ? JSON.parse(agent.metadata) 
      : agent.metadata;

    res.status(200).json(agent);

  } catch (error) {
    console.error('Error fetching agent:', error);
    res.status(500).json({ 
      message: 'Error fetching agent',
      error: error.message 
    });
  }
};

const createAgent = async (req, res) => {
  try {
    const { role, clientId } = req.user;
    const { name, client_id, description, agent_type, configuration, status } = req.body;

    if (!name || !client_id || !description || !agent_type) {
      return res.status(400).json({ 
        message: 'Missing required fields: name, client_id, description, agent_type' 
      });
    }

    const targetClientId = role === 'client' ? clientId : client_id;

    const validTypes = ['support', 'sales', 'general'];
    if (!validTypes.includes(agent_type)) {
      return res.status(400).json({ 
        message: 'Invalid agent_type. Must be: support, sales, or general' 
      });
    }

    const query = `
      INSERT INTO agents (
        client_id, 
        name, 
        description, 
        agent_type, 
        status, 
        configuration,
        metadata,
        is_active,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, NOW())
    `;

    const configJson = configuration ? JSON.stringify(configuration) : '{}';
    const metadataJson = JSON.stringify({ total_conversations: 0 });
    const agentStatus = status || 'active';

    const [result] = await db.query(query, [
      targetClientId,
      name,
      description,
      agent_type,
      agentStatus,
      configJson,
      metadataJson
    ]);

    res.status(201).json({ 
      message: 'Agent created successfully',
      id: result.insertId 
    });

  } catch (error) {
    console.error('Error creating agent:', error);
    res.status(500).json({ 
      message: 'Error creating agent',
      error: error.message 
    });
  }
};

const updateAgent = async (req, res) => {
  try {
    const { id } = req.params;
    const { role, clientId } = req.user;
    const { name, description, agent_type, configuration, status } = req.body;

    let checkQuery = `SELECT * FROM agents WHERE id = ? AND is_active = TRUE`;
    if (role === 'client') {
      checkQuery += ` AND client_id = ?`;
    }

    const [agents] = role === 'client'
      ? await db.query(checkQuery, [id, clientId])
      : await db.query(checkQuery, [id]);

    if (agents.length === 0) {
      return res.status(404).json({ message: 'Agent not found or access denied' });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (agent_type !== undefined) {
      const validTypes = ['support', 'sales', 'general'];
      if (!validTypes.includes(agent_type)) {
        return res.status(400).json({ 
          message: 'Invalid agent_type. Must be: support, sales, or general' 
        });
      }
      updates.push('agent_type = ?');
      values.push(agent_type);
    }
    if (configuration !== undefined) {
      updates.push('configuration = ?');
      values.push(JSON.stringify(configuration));
    }
    if (status !== undefined) {
      
      const validStatuses = ['active', 'inactive'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ 
          message: 'Invalid status. Must be: active or inactive' 
        });
      }
      updates.push('status = ?');
      values.push(status);
    }

    updates.push('updated_at = NOW()');

    if (updates.length === 1) { 
      return res.status(400).json({ message: 'No fields to update' });
    }

    const query = `UPDATE agents SET ${updates.join(', ')} WHERE id = ?`;
    values.push(id);

    await db.query(query, values);

    console.log(`[UPDATE] Agent ${id} updated successfully. Status: ${status}`);

    res.status(200).json({ message: 'Agent updated successfully' });

  } catch (error) {
    console.error('Error updating agent:', error);
    res.status(500).json({ 
      message: 'Error updating agent',
      error: error.message 
    });
  }
};

/// Delete agent (HARD DELETE - permanently removes from database)
const deleteAgent = async (req, res) => {
  try {
    const { id } = req.params;
    const { role, clientId } = req.user;

    console.log(`[DELETE] Attempting to delete agent ID: ${id}`);

    // Check if agent exists and user has permission
    let checkQuery = `SELECT * FROM agents WHERE id = ?`;
    const checkParams = [id];
    
    if (role === 'client') {
      checkQuery += ` AND client_id = ?`;
      checkParams.push(clientId);
    }

    const [agents] = await db.query(checkQuery, checkParams);

    if (agents.length === 0) {
      console.log(`[DELETE] Agent not found: ${id}`);
      return res.status(404).json({ message: 'Agent not found or access denied' });
    }

    const agent = agents[0];
    console.log(`[DELETE] Found agent:`, {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      is_active: agent.is_active
    });

    const isActive = agent.status === 'active' && (agent.is_active === 1 || agent.is_active === true);
    
    if (isActive) {
      console.log(`[DELETE] Cannot delete active agent: ${id}`);
      return res.status(400).json({ 
        message: 'Cannot delete active agent. Please deactivate it first by changing status to inactive.' 
      });
    }

    
    
    await db.query(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_id = ?)`, [id]);
    await db.query(`DELETE FROM conversations WHERE agent_id = ?`, [id]);
    
    const deleteQuery = `DELETE FROM agents WHERE id = ?`;
    const [result] = await db.query(deleteQuery, [id]);

    console.log(`[DELETE] Delete result:`, {
      affectedRows: result.affectedRows
    });

    if (result.affectedRows === 0) {
      console.log(`[DELETE] No rows affected for agent: ${id}`);
      return res.status(500).json({ 
        message: 'Failed to delete agent - no rows affected' 
      });
    }

    res.status(200).json({ 
      message: 'Agent permanently deleted',
      affectedRows: result.affectedRows
    });

  } catch (error) {
    console.error('[DELETE] Error deleting agent:', error);
    res.status(500).json({ 
      message: 'Error deleting agent',
      error: error.message 
    });
  }
};
const getAllClients = async (req, res) => {
  try {
    const { role, clientId } = req.user;

    if (role === 'client') {
      const [clients] = await db.query(
        `SELECT id, name, company_name, email FROM clients WHERE id = ? AND is_active = TRUE`,
        [clientId]
      );
      return res.status(200).json(clients);
    }

    const [clients] = await db.query(
      `SELECT id, name, company_name, email FROM clients WHERE is_active = TRUE ORDER BY name ASC`
    );

    res.status(200).json(clients);

  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ 
      message: 'Error fetching clients',
      error: error.message 
    });
  }
};
const toggleAgentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const { role, userId, clientId } = req.user;

    console.log(`[TOGGLE STATUS] Request:`, {
      agentId: id,
      newStatus: status,
      role,
      userId,
      clientId
    });

    if (!status || !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ 
        message: 'Invalid status. Must be "active" or "inactive"' 
      });
    }

    let checkQuery = `SELECT * FROM agents WHERE id = ? AND is_active = 1`;
    const checkParams = [id];
    
    if (role === 'client') {
      checkQuery += ` AND (client_id = ? OR client_id = ?)`;
      checkParams.push(clientId || userId, userId);
    }

    console.log('[TOGGLE STATUS] Check query:', checkQuery);
    console.log('[TOGGLE STATUS] Check params:', checkParams);

    const [agents] = await db.query(checkQuery, checkParams);

    console.log('[TOGGLE STATUS] Found agents:', agents.length);

    if (agents.length === 0) {
      return res.status(404).json({ message: 'Agent not found or access denied' });
    }

    const updateQuery = `UPDATE agents SET status = ?, updated_at = NOW() WHERE id = ?`;
    const [result] = await db.query(updateQuery, [status, id]);

    if (result.affectedRows === 0) {
      return res.status(500).json({ message: 'Failed to update agent status' });
    }

    console.log(`[TOGGLE STATUS] Success: Agent ${id} status updated to ${status}`);

    res.status(200).json({ 
      message: 'Agent status updated successfully',
      status: status
    });

  } catch (error) {
    console.error('[TOGGLE STATUS] Error:', error);
    res.status(500).json({ 
      message: 'Error updating agent status',
      error: error.message 
    });
  }
};

module.exports = {
  getAllAgents,
  getAgentById,
  createAgent,
  updateAgent,
  deleteAgent,
  getAllClients,
  toggleAgentStatus,
  
};