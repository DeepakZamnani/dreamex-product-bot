const { randomUUID } = require('crypto');
const db = require('../config/database');

// ─── GET /api/property/:slug ──────────────────────────────────────────────────
// Public — returns broker + property data for the www.dreamexprop.com page
exports.getProperty = async (req, res) => {
  try {
    const { slug } = req.params;

    // Raise GROUP_CONCAT limit — default 1024 bytes truncates long image lists
    await db.query('SET SESSION group_concat_max_len = 1000000');

    const [rows] = await db.query(
      `SELECT
         b.id            AS broker_id,
         b.property_name,
         b.rera_id,
         b.property_location,
         b.property_city,
         b.property_type,
         b.property_description,
         b.broker_name,
         b.broker_phone,
         b.broker_email,
         b.brochure_url,
         b.web_slug,
         u.username      AS broker_username,
         GROUP_CONCAT(JSON_OBJECT('id', bi.id, 'image_url', bi.image_url) SEPARATOR '||') AS images_raw
       FROM brokers b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN broker_images bi ON bi.broker_id = b.id
       WHERE b.web_slug = ?
       GROUP BY b.id
       LIMIT 1`,
      [slug]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Property not found' });
    }

    const row = rows[0];
    const images = row.images_raw
      ? row.images_raw.split('||').map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(i => i?.id)
      : [];

    res.json({ success: true, property: { ...row, images_raw: undefined, images } });
  } catch (err) {
    console.error('[property] getProperty error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── POST /api/property/:slug/chat ────────────────────────────────────────────
// Public — receives a chat message, routes to the broker's n8n agent,
// and upserts a lead record in broker_leads for tracking
exports.propertyChat = async (req, res) => {
  const { slug } = req.params;

  try {
    const { conversationId, contacts, messages, channel } = req.body;

    if (!conversationId) return res.status(400).json({ output: 'conversationId is required' });

    // Fetch broker row (needs n8n_url)
    const [rows] = await db.query(
      `SELECT b.id AS broker_id, b.n8n_url
       FROM brokers b
       JOIN users u ON u.id = b.user_id
       WHERE b.web_slug = ?
       LIMIT 1`,
      [slug]
    );

    if (!rows.length) return res.status(404).json({ output: 'Property not found' });

    const { broker_id, n8n_url } = rows[0];

    if (!n8n_url) return res.status(400).json({ output: 'This property has no AI agent configured yet.' });

    const profileName = contacts?.profileName || null;
    const phone       = contacts?.phone       || null;
    const userMessage = messages?.text?.body  || '';

    // Upsert broker lead for this session
    const [existing] = await db.query(
      'SELECT id FROM broker_leads WHERE broker_id = ? AND phone = ?',
      [broker_id, conversationId]   // use conversationId as the "phone" key for web sessions
    );

    if (!existing.length) {
      await db.query(
        `INSERT INTO broker_leads (broker_id, phone, name, status)
         VALUES (?, ?, ?, 'verified')`,
        [broker_id, conversationId, profileName || `WebLead_${conversationId.slice(0, 6)}`]
      );
    } else if (profileName) {
      await db.query(
        'UPDATE broker_leads SET name = ? WHERE broker_id = ? AND phone = ?',
        [profileName, broker_id, conversationId]
      );
    }

    // Forward to broker's n8n agent (same payload format as existing chat webhook)
    const n8nPayload = {
      ...req.body,
      channel: 'api',
      event: 'message_received',
      from: conversationId,
      contacts: {
        ...contacts,
        recipient: conversationId,
      },
      messages: {
        ...messages,
        timestamp: messages?.timestamp || Date.now(),
      },
    };

    const n8nRes = await fetch(n8n_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-n8n-flow-webhook-auth': '0SCxpZqX6R7e',
      },
      body: JSON.stringify(n8nPayload),
    });

    if (!n8nRes.ok) throw new Error(`n8n responded with status: ${n8nRes.status}`);

    const text = await n8nRes.text();
    const raw  = text ? JSON.parse(text) : {};
    const json = Array.isArray(raw) ? (raw[0] || {}) : raw;

    res.json({
      output:      json.output      || json.body || 'Sorry, I could not process your request.',
      messageType: json.messageType || 'text',
      body:        json.body        || json.output || '',
      buttons:     json.buttons     || [],
      imageUrl:    json.imageUrl    || null,
    });

  } catch (err) {
    console.error(`[property-chat] ${slug} —`, err.message);
    res.status(200).json({ output: 'Something went wrong. Please try again later.', messageType: 'text' });
  }
};

// ─── GET /api/property/:slug/conversation ─────────────────────────────────────
exports.newConversationId = async (req, res) => {
  res.json({ success: true, conversationId: randomUUID() });
};

// ─── POST /api/property/:slug/:leadPhone/chat ─────────────────────────────────
// Identified lead chat — phone from URL maps to a real broker_lead row
exports.leadChat = async (req, res) => {
  const { slug, leadPhone } = req.params;

  try {
    const { contacts, messages } = req.body;

    const [brokers] = await db.query(
      `SELECT b.user_id AS broker_id, b.n8n_url, b.property_name, b.web_slug
       FROM brokers b JOIN users u ON u.id = b.user_id
       WHERE b.web_slug = ? LIMIT 1`,
      [slug]
    );
    if (!brokers.length) return res.status(404).json({ output: 'Property not found' });

    const { broker_id, n8n_url } = brokers[0];
    if (!n8n_url) return res.status(400).json({ output: 'No AI agent configured.' });

    // Accept both bare (9271234111) and country-prefixed (919271234111) formats
    const [leads] = await db.query(
      'SELECT id, name FROM broker_leads WHERE broker_id = ? AND (phone = ? OR phone = ?) LIMIT 1',
      [broker_id, leadPhone, `91${leadPhone}`]
    );

    let lead;
    if (leads.length) {
      lead = leads[0];
    } else {
      // Visitor arrived via the personalized link but isn't in the leads list yet — auto-register
      const phone = leadPhone.length === 10 ? `91${leadPhone}` : leadPhone;
      const [ins] = await db.query(
        `INSERT INTO broker_leads (broker_id, phone, name, status) VALUES (?, ?, ?, 'verified')`,
        [broker_id, phone, `Lead_${leadPhone.slice(-4)}`]
      );
      lead = { id: ins.insertId, name: `Lead_${leadPhone.slice(-4)}` };
    }
    const userMessage = messages?.text?.body || '';

    await db.query(
      'INSERT INTO broker_lead_messages (broker_lead_id, sender, message) VALUES (?, "user", ?)',
      [lead.id, userMessage]
    );
    await db.query('UPDATE broker_leads SET last_message_at = NOW() WHERE id = ?', [lead.id]);

    const n8nPayload = {
      ...req.body,
      channel: 'api',
      event: 'message_received',
      from: leadPhone,
      contacts: {
        ...contacts,
        profileName: lead.name || contacts?.profileName || 'Lead',
        recipient: leadPhone,
      },
      messages: {
        ...messages,
        timestamp: messages?.timestamp || Date.now(),
      },
    };

    const n8nRes = await fetch(n8n_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-n8n-flow-webhook-auth': '0SCxpZqX6R7e',
      },
      body: JSON.stringify(n8nPayload),
    });

    if (!n8nRes.ok) throw new Error(`n8n error: ${n8nRes.status}`);

    const text = await n8nRes.text();
    const raw  = text ? JSON.parse(text) : {};
    const json = Array.isArray(raw) ? (raw[0] || {}) : raw;
    const cleanBody = json.body || json.output || 'Sorry, I could not process your request.';

    // Store raw output so the frontend can reconstruct images/buttons from history
    const storedMsg = json.output || cleanBody;
    await db.query(
      'INSERT INTO broker_lead_messages (broker_lead_id, sender, message) VALUES (?, "ai", ?)',
      [lead.id, storedMsg]
    );

    res.json({
      output:      json.output      || cleanBody,
      messageType: json.messageType || 'text',
      body:        cleanBody,
      buttons:     json.buttons     || [],
      imageUrl:    json.imageUrl    || null,
    });

  } catch (err) {
    console.error(`[lead-chat] ${slug}/${leadPhone} —`, err.message);
    res.status(200).json({ output: 'Something went wrong. Please try again later.', messageType: 'text' });
  }
};

// ─── GET /api/property/:slug/:leadPhone/messages ──────────────────────────────
// Returns full conversation history for a lead (used by broker dashboard)
exports.getLeadMessages = async (req, res) => {
  const { slug, leadPhone } = req.params;
  try {
    const [brokers] = await db.query(
      'SELECT b.user_id AS broker_id FROM brokers b JOIN users u ON u.id = b.user_id WHERE b.web_slug = ? LIMIT 1',
      [slug]
    );
    if (!brokers.length) return res.status(404).json({ success: false });

    const [leads] = await db.query(
      'SELECT id FROM broker_leads WHERE broker_id = ? AND (phone = ? OR phone = ?) LIMIT 1',
      [brokers[0].broker_id, leadPhone, `91${leadPhone}`]
    );
    if (!leads.length) return res.status(404).json({ success: false, messages: [] });

    const [msgs] = await db.query(
      'SELECT sender, message, sent_at FROM broker_lead_messages WHERE broker_lead_id = ? ORDER BY sent_at ASC',
      [leads[0].id]
    );

    res.json({ success: true, messages: msgs });
  } catch (err) {
    console.error('[lead-messages]', err.message);
    res.status(500).json({ success: false, messages: [] });
  }
};
