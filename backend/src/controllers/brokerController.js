const db = require('../config/database');
const xlsx = require('xlsx');
const fs = require('fs');
const { uploadToS3, deleteFromS3, brokerKey } = require('../utils/s3Upload');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

const WA_TEMPLATE = encodeURIComponent(
  'Hi! I came across your profile and wanted to connect regarding an exciting real estate opportunity. Would love to share more details with you!'
);

const parseFile = (filePath, mimetype) => {
  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  return rows;
};

const normalizePhone = (raw) => {
  if (!raw) return null;
  let phone = String(raw).replace(/[\s\-().+]/g, '');
  // strip leading zeros
  if (phone.startsWith('00')) phone = phone.slice(2);
  if (phone.startsWith('0'))  phone = '91' + phone.slice(1);
  // already has country code 91
  if (phone.startsWith('91') && phone.length === 12) return phone;
  // bare 10-digit Indian mobile (starts with 6-9)
  if (phone.length === 10 && /^[6-9]/.test(phone)) return '91' + phone;
  // anything else: prepend 91 as default
  if (phone.length < 10 || phone.length > 15) return null;
  return phone.length === 10 ? '91' + phone : phone;
};

const brokerController = {

  getDashboard: async (req, res) => {
    try {
      const userId = req.user.id;

      // ── Broker info ──────────────────────────────────────────────────────
      const [brokerRows] = await db.query(
        `SELECT b.id, b.broker_name, b.property_name, b.property_city
         FROM brokers b WHERE b.user_id = ? LIMIT 1`,
        [userId]
      );
      if (!brokerRows.length) {
        return res.status(404).json({ success: false, message: 'Broker profile not found' });
      }
      const broker = brokerRows[0];
      // NOTE: broker_leads.broker_id stores req.user.id (users.id), NOT brokers.id
      // All broker_leads queries must use userId, not broker.id
      const leadsOwnerId = userId;

      // ── Core lead counts ─────────────────────────────────────────────────
      const [[coreCounts]] = await db.query(
        `SELECT
           COUNT(*)                                                               AS totalLeads,
           SUM(status = 'verified')                                               AS verifiedLeads,
           SUM(status = 'pending')                                                AS pendingLeads,
           SUM(status = 'invalid')                                                AS invalidLeads,
           SUM(DATE(uploaded_at) = CURDATE())                                     AS freshLeadsToday,
           SUM(follow_up_date IS NOT NULL
               AND DATE(follow_up_date) = CURDATE())                              AS followupsToday,
           SUM(follow_up_date IS NOT NULL
               AND DATE(follow_up_date) <= CURDATE())                             AS totalPendingFollowups,
           SUM(lead_status IN ('hot', 'high_intent'))                             AS qualifiedLeads,
           SUM(lead_status = 'hot')                                               AS hotLeadsStatus,
           SUM(lead_status = 'warm')                                              AS warmLeadsStatus,
           SUM(lead_status = 'cold')                                              AS coldLeadsStatus
         FROM broker_leads WHERE broker_id = ?`,
        [leadsOwnerId]
      );

      // ── Chat (message) counts ────────────────────────────────────────────
      const [[chatCounts]] = await db.query(
        `SELECT
           COUNT(DISTINCT bl.id)                                AS chattedLeads,
           COUNT(*)                                             AS totalMessages
         FROM broker_leads bl
         INNER JOIN broker_lead_messages blm ON blm.broker_lead_id = bl.id
         WHERE bl.broker_id = ?`,
        [leadsOwnerId]
      );

      // ── Lead funnel from AI analysis (mirrors client's lead_summary) ─────
      const LEAD_TYPE_ORDER  = ['high_intent', 'hot', 'warm', 'cold', 'dead'];
      const LEAD_TYPE_LABELS = { high_intent: 'High Intent', hot: 'Hot', warm: 'Warm', cold: 'Cold', dead: 'Dead' };

      const [leadTypesRaw] = await db.query(
        `SELECT bla.lead_type, COUNT(DISTINCT bla.broker_lead_id) AS count
         FROM broker_lead_analysis bla
         INNER JOIN broker_leads bl ON bl.id = bla.broker_lead_id
         WHERE bl.broker_id = ?
         GROUP BY bla.lead_type`,
        [leadsOwnerId]
      );
      const leadTypeMap = {};
      leadTypesRaw.forEach(r => { leadTypeMap[r.lead_type] = Number(r.count); });
      const leadFunnel = LEAD_TYPE_ORDER
        .filter(t => leadTypeMap[t] !== undefined)
        .map(t => ({ stage: LEAD_TYPE_LABELS[t], count: leadTypeMap[t] }));

      // High intent leads not yet followed up (mirrors client's highIntentNewCount)
      const highIntentNotFollowedUp = leadTypeMap['high_intent']
        ? await db.query(
            `SELECT COUNT(DISTINCT bla.broker_lead_id) AS cnt
             FROM broker_lead_analysis bla
             INNER JOIN broker_leads bl ON bl.id = bla.broker_lead_id
             WHERE bl.broker_id = ?
               AND bla.lead_type = 'high_intent'
               AND (bl.follow_up_date IS NULL OR bl.follow_up_date > NOW())`,
            [leadsOwnerId]
          ).then(([r]) => Number(r[0].cnt))
        : 0;

      // Leads with messages today (mirrors client's immediateCount)
      const [[{ activeToday }]] = await db.query(
        `SELECT COUNT(DISTINCT bl.id) AS activeToday
         FROM broker_leads bl
         INNER JOIN broker_lead_messages blm ON blm.broker_lead_id = bl.id
         WHERE bl.broker_id = ? AND DATE(blm.sent_at) = CURDATE()`,
        [leadsOwnerId]
      );

      // ── Funnel stages (mirrors client: Leads→Verified→Chatted→Qualified→Hot) ──
      const funnelStages = [
        { stage: 'Leads',       count: Number(coreCounts.totalLeads    || 0) },
        { stage: 'Verified',    count: Number(coreCounts.verifiedLeads || 0) },
        { stage: 'Chatted',     count: Number(chatCounts.chattedLeads  || 0) },
        { stage: 'High Intent', count: leadTypeMap['high_intent'] || 0 },
        { stage: 'Hot',         count: leadTypeMap['hot'] || 0 },
      ];

      // ── Leads per day — last 30 days, zero-filled (same as client) ───────
      const [leadsPerDayRaw] = await db.query(
        `SELECT DATE(uploaded_at) AS date, COUNT(*) AS count
         FROM broker_leads
         WHERE broker_id = ? AND uploaded_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         GROUP BY DATE(uploaded_at)
         ORDER BY date ASC`,
        [leadsOwnerId]
      );
      const leadsPerDay = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const found = leadsPerDayRaw.find(r =>
          (r.date?.toISOString ? r.date.toISOString() : String(r.date)).slice(0, 10) === key
        );
        leadsPerDay.push({ date: key, count: found ? Number(found.count) : 0 });
      }

      // ── Key interests (same aggregation logic as client) ─────────────────
      const [interestRows] = await db.query(
        `SELECT bla.key_interests
         FROM broker_lead_analysis bla
         INNER JOIN broker_leads bl ON bl.id = bla.broker_lead_id
         WHERE bl.broker_id = ? AND bla.key_interests IS NOT NULL`,
        [leadsOwnerId]
      );
      const keyCounts = {};
      for (const row of interestRows) {
        let interests = row.key_interests;
        if (typeof interests === 'string') {
          try { interests = JSON.parse(interests); } catch { continue; }
        }
        if (interests && typeof interests === 'object' && !Array.isArray(interests)) {
          for (const key of Object.keys(interests)) {
            if (interests[key]) keyCounts[key] = (keyCounts[key] || 0) + 1;
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

      // ── Response (mirrors client shape) ──────────────────────────────────
      res.json({
        success: true,
        data: {
          broker: {
            name:          broker.broker_name,
            property_name: broker.property_name,
            property_city: broker.property_city,
          },
          metrics: {
            totalLeads:           Number(coreCounts.totalLeads          || 0),
            verifiedLeads:        Number(coreCounts.verifiedLeads       || 0),
            pendingLeads:         Number(coreCounts.pendingLeads        || 0),
            invalidLeads:         Number(coreCounts.invalidLeads        || 0),
            freshLeadsToday:      Number(coreCounts.freshLeadsToday     || 0),
            followupsToday:       Number(coreCounts.followupsToday      || 0),
            totalPendingFollowups:Number(coreCounts.totalPendingFollowups|| 0),
            chattedLeads:         Number(chatCounts.chattedLeads        || 0),
            totalMessages:        Number(chatCounts.totalMessages       || 0),
            qualifiedLeads:           Number(coreCounts.qualifiedLeads  || 0),
            highIntentLeads:          leadTypeMap['high_intent']        || 0,
            hotLeads:                 Number(coreCounts.hotLeadsStatus  || 0),
            warmLeads:                Number(coreCounts.warmLeadsStatus || 0),
            coldLeads:                Number(coreCounts.coldLeadsStatus || 0),
            deadLeads:                leadTypeMap['dead']               || 0,
            highIntentNotFollowedUp,
            activeToday:              Number(activeToday || 0),
          },
          leadFunnel,
          funnelStages,
          leadsPerDay,
          keyInterestStats,
        },
      });
    } catch (error) {
      console.error('[broker/dashboard] error:', error);
      res.status(500).json({ success: false, message: 'Error fetching broker dashboard metrics', error: error.message });
    }
  },

  uploadLeads: async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const brokerId = req.user.id;
    let rows;

    try {
      rows = parseFile(req.file.path, req.file.mimetype);
    } catch (err) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Could not parse file. Use CSV or Excel.' });
    }

    fs.unlinkSync(req.file.path);

    if (!rows.length) return res.status(400).json({ success: false, message: 'File is empty' });

    const leads = [];
    for (const row of rows) {
      const phoneRaw = row.phone || row.Phone || row.PHONE || row.mobile || row.Mobile || row.number || row.Number || Object.values(row)[1];
      const nameRaw  = row.name  || row.Name  || row.NAME  || Object.values(row)[0] || '';
      const phone = normalizePhone(phoneRaw);
      if (!phone) continue;
      leads.push([brokerId, phone, String(nameRaw).trim() || null, 'pending']);
    }

    if (!leads.length) return res.status(400).json({ success: false, message: 'No valid phone numbers found in file' });

    await db.query(
      'INSERT INTO broker_leads (broker_id, phone, name, status) VALUES ?',
      [leads]
    );

    res.json({ success: true, message: `${leads.length} leads uploaded`, count: leads.length });
  },

  getLeads: async (req, res) => {
    const brokerId = req.user.id;

    const [brokerRows] = await db.query(
      'SELECT web_slug FROM brokers WHERE user_id = ? LIMIT 1',
      [brokerId]
    );
    const webSlug = brokerRows[0]?.web_slug || '';

    const [leads] = await db.query(
      `SELECT bl.*,
         (SELECT COUNT(*) FROM broker_lead_messages WHERE broker_lead_id = bl.id) AS message_count
       FROM broker_leads bl
       WHERE bl.broker_id = ?
       ORDER BY bl.last_message_at DESC, bl.uploaded_at DESC`,
      [brokerId]
    );

    const enriched = leads.map(l => ({
      ...l,
      wa_link: l.status === 'verified'
        ? `https://wa.me/${l.phone}?text=${WA_TEMPLATE}`
        : null,
      chat_link: l.status === 'verified' && webSlug
        ? `${req.propertySiteUrl}/property/${webSlug}/${l.phone.startsWith('91') ? l.phone.slice(2) : l.phone}`
        : null,
    }));

    res.json({ success: true, leads: enriched });
  },

  getBrokerLead: async (req, res) => {
    const brokerId = req.user.id;
    const { leadId } = req.params;

    const [rows] = await db.query(
      `SELECT bl.*, b.web_slug
       FROM broker_leads bl
       LEFT JOIN brokers b ON b.user_id = bl.broker_id
       WHERE bl.id = ? AND bl.broker_id = ? LIMIT 1`,
      [leadId, brokerId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Lead not found' });

    const lead = rows[0];

    const [msgs] = await db.query(
      'SELECT sender, message, sent_at FROM broker_lead_messages WHERE broker_lead_id = ? ORDER BY sent_at ASC',
      [leadId]
    );

    const userMessages = msgs.filter(m => m.sender === 'user').length;
    const aiMessages   = msgs.filter(m => m.sender === 'ai').length;
    const chat_link    = lead.status === 'verified' && lead.web_slug
      ? `${req.propertySiteUrl}/property/${lead.web_slug}/${lead.phone.startsWith('91') ? lead.phone.slice(2) : lead.phone}`
      : null;

    const [analysisRows] = await db.query(
      'SELECT * FROM broker_lead_analysis WHERE broker_lead_id = ? LIMIT 1',
      [leadId]
    );
    const analysis = analysisRows[0] || null;
    if (analysis && typeof analysis.key_interests === 'string') {
      analysis.key_interests = JSON.parse(analysis.key_interests);
    }

    res.json({
      success: true,
      lead: { ...lead, chat_link, message_count: msgs.length, user_messages: userMessages, ai_messages: aiMessages },
      messages: msgs,
      analysis,
    });
  },

  analyzeLead: async (req, res) => {
    const brokerId = req.user.id;
    const { leadId } = req.params;

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, message: 'GEMINI_API_KEY not configured' });
    }

    const [leads] = await db.query(
      'SELECT bl.id, bl.name FROM broker_leads bl WHERE bl.id = ? AND bl.broker_id = ? LIMIT 1',
      [leadId, brokerId]
    );
    if (!leads.length) return res.status(404).json({ success: false, message: 'Lead not found' });

    const [msgs] = await db.query(
      'SELECT sender, message, sent_at FROM broker_lead_messages WHERE broker_lead_id = ? ORDER BY sent_at ASC',
      [leadId]
    );
    if (!msgs.length) {
      return res.status(400).json({ success: false, message: 'No messages to analyze yet.' });
    }

    const transcript = msgs.map(m => `${m.sender === 'user' ? 'Lead' : 'Agent'}: ${m.message}`).join('\n');
    const leadName   = leads[0].name || 'Unknown';

    const prompt = `You are a CRM assistant for a real estate company. Analyze the following chatbot conversation with a property lead named "${leadName}".

CONVERSATION:
${transcript}

Classify and summarize this lead. Return a JSON object with exactly these keys:

1. "leadType": Classify using EXACTLY one of: "high_intent", "hot", "warm", "cold", "dead"
   - "high_intent": Asked for a call/site visit OR showed urgency (needs response within 24 hrs)
   - "hot": Answered most qualifying questions (budget, location, BHK, timeline) but no urgent ask
   - "warm": Gave partial responses, showed moderate interest, asked some questions
   - "cold": Very short replies, minimal engagement, or no meaningful information shared
   - "dead": No response after first message or completely disengaged

2. "leadProfile": 2-3 sentences describing who this lead is and what they want.

3. "keyInterests": Extract every specific detail the lead mentioned. Use ONLY these keys (omit if not mentioned):
   - "Property"  → e.g. "2BHK", "3BHK Flat", "Villa", "Plot"
   - "Location"  → area/city preference
   - "Budget"    → stated budget range
   - "Timeline"  → urgency or possession requirement
   - "Purpose"   → e.g. "Investment", "Self use", "Rental income"
   - "Floor"     → floor or facing preference
   - "Amenities" → specific amenities asked about
   - "Other"     → any other specific requirement
   Return as a JSON object. Include ONLY what was actually mentioned.

4. "conversationSummary": 3-4 sentences covering what happened and key touchpoints.

5. "followUp": Specific next action the broker should take for this lead.

Respond ONLY in valid JSON with exactly these keys: leadType, leadProfile, keyInterests, conversationSummary, followUp`;

    try {
      const geminiRes = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 1200 },
        }),
      });

      if (!geminiRes.ok) {
        const err = await geminiRes.text();
        throw new Error(`Gemini error: ${err}`);
      }

      const data   = await geminiRes.json();
      const raw    = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error('Gemini returned empty response');

      const result = JSON.parse(raw);
      const keyInterests = JSON.stringify(result.keyInterests || {});

      const [existing] = await db.query(
        'SELECT id FROM broker_lead_analysis WHERE broker_lead_id = ?',
        [leadId]
      );

      if (existing.length) {
        await db.query(
          `UPDATE broker_lead_analysis
           SET lead_type = ?, lead_profile = ?, key_interests = ?, conversation_summary = ?, follow_up_action = ?, updated_at = NOW()
           WHERE broker_lead_id = ?`,
          [result.leadType, result.leadProfile, keyInterests, result.conversationSummary, result.followUp, leadId]
        );
      } else {
        await db.query(
          `INSERT INTO broker_lead_analysis (broker_lead_id, lead_type, lead_profile, key_interests, conversation_summary, follow_up_action)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [leadId, result.leadType, result.leadProfile, keyInterests, result.conversationSummary, result.followUp]
        );
      }

      // Also update lead_status to match Gemini's classification
      await db.query(
        'UPDATE broker_leads SET lead_status = ? WHERE id = ?',
        [result.leadType, leadId]
      );

      res.json({
        success: true,
        analysis: {
          lead_type:            result.leadType,
          lead_profile:         result.leadProfile,
          key_interests:        result.keyInterests || {},
          conversation_summary: result.conversationSummary,
          follow_up_action:     result.followUp,
        },
        updated_lead_status: result.leadType,
      });

    } catch (err) {
      console.error('[analyzeLead]', err.message);
      res.status(500).json({ success: false, message: 'Analysis failed: ' + err.message });
    }
  },

  getLeadConversation: async (req, res) => {
    const brokerId = req.user.id;
    const { leadId } = req.params;

    const [leads] = await db.query(
      'SELECT id FROM broker_leads WHERE id = ? AND broker_id = ? LIMIT 1',
      [leadId, brokerId]
    );
    if (!leads.length) return res.status(404).json({ success: false, messages: [] });

    const [msgs] = await db.query(
      'SELECT sender, message, sent_at FROM broker_lead_messages WHERE broker_lead_id = ? ORDER BY sent_at ASC',
      [leads[0].id]
    );
    res.json({ success: true, messages: msgs });
  },

  updateLeadStatus: async (req, res) => {
    const brokerId = req.user.id;
    const { leadId } = req.params;
    const { lead_status } = req.body;

    if (!['cold', 'warm', 'hot', 'high_intent', 'dead'].includes(lead_status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    await db.query(
      'UPDATE broker_leads SET lead_status = ? WHERE id = ? AND broker_id = ?',
      [lead_status, leadId, brokerId]
    );
    res.json({ success: true });
  },

  updateFollowup: async (req, res) => {
    const brokerId = req.user.id;
    const { leadId } = req.params;
    const { follow_up_date } = req.body;

    await db.query(
      'UPDATE broker_leads SET follow_up_date = ? WHERE id = ? AND broker_id = ?',
      [follow_up_date || null, leadId, brokerId]
    );
    res.json({ success: true });
  },

  verifyLeads: async (req, res) => {
    const brokerId = req.user.id;
    const [pending] = await db.query(
      'SELECT id, phone FROM broker_leads WHERE broker_id = ? AND status = ?',
      [brokerId, 'pending']
    );

    if (!pending.length) return res.json({ success: true, message: 'No pending leads to verify', verified: 0, invalid: 0 });

    let verified = 0;
    let invalid  = 0;

    for (const lead of pending) {
      const isOnWhatsapp = await checkWhatsapp(lead.phone);
      const status = isOnWhatsapp ? 'verified' : 'invalid';
      await db.query(
        'UPDATE broker_leads SET status = ?, verified_at = NOW() WHERE id = ?',
        [status, lead.id]
      );
      if (isOnWhatsapp) verified++; else invalid++;
    }

    res.json({ success: true, verified, invalid });
  },

  deleteLeads: async (req, res) => {
    const brokerId = req.user.id;
    await db.query('DELETE FROM broker_leads WHERE broker_id = ?', [brokerId]);
    res.json({ success: true, message: 'All leads deleted' });
  },

  // ── Property Profile ────────────────────────────────────────────────────────

  getProperty: async (req, res) => {
    const userId = req.user.id;
    const [rows] = await db.query(
      `SELECT b.*, GROUP_CONCAT(JSON_OBJECT('id', bi.id, 'image_url', bi.image_url) SEPARATOR '||') AS images_raw
       FROM brokers b
       LEFT JOIN broker_images bi ON bi.broker_id = b.id
       WHERE b.user_id = ? GROUP BY b.id LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.status(404).json({ success: false });
    const row = rows[0];
    const images = row.images_raw
      ? row.images_raw.split('||').map(s => JSON.parse(s)).filter(i => i.id)
      : [];
    res.json({ success: true, property: { ...row, images_raw: undefined, images } });
  },

  updateProperty: async (req, res) => {
    const userId = req.user.id;
    const {
      property_name, rera_id, property_location, property_city,
      property_type, property_description, broker_name, broker_phone, broker_email,
    } = req.body;
    await db.query(
      `UPDATE brokers SET
         property_name = COALESCE(?, property_name),
         rera_id = COALESCE(?, rera_id),
         property_location = COALESCE(?, property_location),
         property_city = COALESCE(?, property_city),
         property_type = COALESCE(?, property_type),
         property_description = COALESCE(?, property_description),
         broker_name = COALESCE(?, broker_name),
         broker_phone = COALESCE(?, broker_phone),
         broker_email = COALESCE(?, broker_email)
       WHERE user_id = ?`,
      [property_name, rera_id, property_location, property_city,
       property_type, property_description, broker_name, broker_phone, broker_email, userId]
    );
    res.json({ success: true });
  },

  addPropertyImages: async (req, res) => {
    const userId = req.user.id;
    const [brokers] = await db.query('SELECT id, property_name FROM brokers WHERE user_id = ? LIMIT 1', [userId]);
    if (!brokers.length) return res.status(404).json({ success: false });
    const { id: brokerId, property_name } = brokers[0];
    const urls = [];
    for (const f of req.files || []) {
      const url = await uploadToS3(f.buffer, brokerKey(property_name, brokerId, 'property', f.originalname), f.mimetype);
      const [r] = await db.query('INSERT INTO broker_images (broker_id, image_url, image_type) VALUES (?, ?, ?)', [brokerId, url, 'property']);
      urls.push({ id: r.insertId, url });
    }
    res.json({ success: true, images: urls });
  },

  deletePropertyImage: async (req, res) => {
    const userId = req.user.id;
    const { imageId } = req.params;
    const [rows] = await db.query(
      'SELECT bi.image_url FROM broker_images bi JOIN brokers b ON b.id = bi.broker_id WHERE bi.id = ? AND b.user_id = ? LIMIT 1',
      [imageId, userId]
    );
    if (!rows.length) return res.status(404).json({ success: false });
    await deleteFromS3(rows[0].image_url);
    await db.query('DELETE FROM broker_images WHERE id = ?', [imageId]);
    res.json({ success: true });
  },

  updateBrochure: async (req, res) => {
    const userId = req.user.id;
    const [brokers] = await db.query('SELECT id, property_name, brochure_url FROM brokers WHERE user_id = ? LIMIT 1', [userId]);
    if (!brokers.length || !req.file) return res.status(400).json({ success: false });
    const { id: brokerId, property_name, brochure_url: oldUrl } = brokers[0];
    if (oldUrl) await deleteFromS3(oldUrl);
    const url = await uploadToS3(req.file.buffer, brokerKey(property_name, brokerId, 'brochure', req.file.originalname), req.file.mimetype);
    await db.query('UPDATE brokers SET brochure_url = ? WHERE id = ?', [url, brokerId]);
    res.json({ success: true, brochure_url: url });
  },

  deleteBrochure: async (req, res) => {
    const userId = req.user.id;
    const [rows] = await db.query('SELECT id, brochure_url FROM brokers WHERE user_id = ? LIMIT 1', [userId]);
    if (!rows.length) return res.status(404).json({ success: false });
    if (rows[0].brochure_url) await deleteFromS3(rows[0].brochure_url);
    await db.query('UPDATE brokers SET brochure_url = NULL WHERE id = ?', [rows[0].id]);
    res.json({ success: true });
  },

};

async function checkWhatsapp(phone) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    // No credentials — fall back to format check
    return phone.length >= 10 && phone.length <= 15;
  }

  try {
    const e164 = phone.startsWith('+') ? phone : `+${phone}`;
    const url  = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`;
    const res  = await fetch(url, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      },
    });

    if (!res.ok) return false;

    const data = await res.json();
    const type = data?.line_type_intelligence?.type;
    // mobile and voip numbers can be on WhatsApp; landline/fixed usually can't
    return ['mobile', 'voip', 'personal'].includes(type);
  } catch {
    return false;
  }
}

module.exports = brokerController;
