const db = require('../config/database');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
const MAX_MESSAGES = 200;
const BATCH_LIMIT = 50;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* ── Resolve client_id from JWT username ── */
const getClientId = async (username) => {
  const [rows] = await db.query('SELECT id FROM clients WHERE name = ?', [username]);
  if (rows.length === 0) throw new Error(`Client not found for username: ${username}`);
  return rows[0].id;
};

const buildTranscript = (messages) => {
  const convMap = new Map();
  for (const msg of messages) {
    if (!convMap.has(msg.conversation_id)) {
      convMap.set(msg.conversation_id, { channel: msg.channel, started_at: msg.conv_started_at, lines: [] });
    }
    const role = msg.sender_type === 'agent' ? 'Agent' : 'User';
    const text = (msg.message_text || '').trim();
    if (text) convMap.get(msg.conversation_id).lines.push(`${role}: ${text}`);
  }

  let idx = 1;
  const parts = [];
  for (const [, conv] of convMap) {
    const date = conv.started_at ? new Date(conv.started_at).toISOString().split('T')[0] : 'Unknown';
    parts.push(`[Conversation ${idx} | ${conv.channel} | ${date}]\n${conv.lines.join('\n')}`);
    idx++;
  }
  return parts.join('\n\n');
};

const runGemini = async (userId, clientId, userName) => {
  const [messages] = await db.query(
    `SELECT m.id, m.conversation_id, m.sender_type, m.message_text, m.created_at,
            c.channel, c.started_at as conv_started_at,
            CASE WHEN m.sender_type = 'user' THEN cu.name
                 WHEN m.sender_type = 'agent' THEN a.name
                 ELSE 'System' END as sender_name
     FROM messages m
     INNER JOIN conversations c ON m.conversation_id = c.id
     LEFT JOIN agents a ON c.agent_id = a.id
     LEFT JOIN chat_users cu ON m.sender_type = 'user' AND m.sender_id = cu.id
     WHERE c.chat_user_id = ? AND c.client_id = ?
     ORDER BY m.created_at ASC
     LIMIT ?`,
    [userId, clientId, MAX_MESSAGES]
  );

  if (messages.length === 0) return null;

  const transcript = buildTranscript(messages);

  const prompt = `You are a CRM assistant for a real estate company. Analyze the following chatbot conversation history with a lead named "${userName}".

CONVERSATION HISTORY:
${transcript}

Classify and summarize this lead. Return a JSON object with exactly these keys:

1. "leadType": Classify using EXACTLY one of: "high_intent", "hot", "warm", "cold", "dead"
   - "high_intent": Asked for a call/site visit OR showed urgency (needs response within 24 hrs)
   - "hot": Answered most qualifying questions (budget, location, BHK, timeline)
   - "warm": Gave partial responses, showed moderate interest
   - "cold": Minimal interaction, short replies, low engagement
   - "dead": No response after first message or completely disengaged

2. "leadProfile": Who is this lead and what are they looking for? (2-3 sentences)

3. "keyInterests": Extract every specific detail the lead mentioned as a labeled key-value object.
   Use ONLY these keys (omit a key entirely if the lead never mentioned it):
   - "Property"   → property type, e.g. "2BHK", "3BHK Flat", "Villa", "Plot", "Commercial"
   - "Location"   → area/city preference, e.g. "Baner, Pune", "Near metro station"
   - "Budget"     → stated budget range, e.g. "Under 80L", "50–70L", "1Cr+"
   - "Timeline"   → urgency or possession date, e.g. "Ready to move", "Within 6 months", "2026 possession"
   - "Purpose"    → reason for buying, e.g. "Investment", "Self use", "Rental income"
   - "Floor"      → floor or facing preference, e.g. "High floor", "East facing", "Ground floor"
   - "Amenities"  → specific amenities asked for, e.g. "Gym + Pool", "Covered parking", "Clubhouse"
   - "Other"      → any other specific requirement that doesn't fit above categories
   Return as a JSON object, e.g. {"Property": "2BHK", "Location": "Baner Pune", "Budget": "Under 80L", "Timeline": "Ready to move"}
   Include ONLY what was actually mentioned — do not guess or fill in blanks.

4. "conversationSummary": What happened across all conversations? Key touchpoints. (3-4 sentences)

5. "followUp": What should the sales team do next? Be specific.

6. "immediate": Is this lead showing urgent signals that need immediate attention? Answer ONLY "yes" or "no".
   Answer "yes" if ANY of the following are true:
   - Lead mentions needing a property urgently (within a week, very soon, immediately, ASAP)
   - Lead asks to schedule a call, callback, or site visit
   - Lead asks the bot to connect them with someone or arrange a meeting
   - Lead explicitly says they want to move quickly or buy soon
   - Lead shows very high urgency about timeline or possession
   Answer "no" for everything else — general enquiries, browsing, or low-engagement leads.

Respond ONLY in valid JSON with exactly these keys: leadType, leadProfile, keyInterests, conversationSummary, followUp, immediate`;

  const resp = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 1500 },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini error: ${err}`);
  }

  const data = await resp.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini returned empty response');

  return JSON.parse(raw);
};

const saveSummary = async (userId, clientId, summary) => {
  const [existing] = await db.query(
    'SELECT id FROM lead_summary WHERE chat_user_id = ? AND client_id = ?',
    [userId, clientId]
  );

  const leadType     = summary.leadType             || 'unknown';
  const leadProfile  = summary.leadProfile          || null;
  const keyInterests = JSON.stringify(summary.keyInterests || []);
  const convSummary  = summary.conversationSummary  || null;
  const followUp     = summary.followUp             || null;

  if (existing.length > 0) {
    await db.query(
      `UPDATE lead_summary
       SET lead_type = ?, lead_profile = ?, lead_key_interests = ?,
           conversation_summary = ?, follow_up_action = ?, updated_at = NOW()
       WHERE chat_user_id = ? AND client_id = ?`,
      [leadType, leadProfile, keyInterests, convSummary, followUp, userId, clientId]
    );
  } else {
    await db.query(
      `INSERT INTO lead_summary
         (chat_user_id, client_id, lead_type, lead_profile, lead_key_interests, conversation_summary, follow_up_action)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, clientId, leadType, leadProfile, keyInterests, convSummary, followUp]
    );
  }

  // Mark chat_user as summarized
  await db.query(
    'UPDATE chat_users SET is_summarized = 1 WHERE id = ?',
    [userId]
  );

  // Save immediate flag to lead_followups
  const immediate = summary.immediate === 'yes' ? 'yes' : 'no';
  const [followupExisting] = await db.query(
    'SELECT id FROM lead_followups WHERE chat_user_id = ? AND client_id = ?',
    [userId, clientId]
  );

  if (followupExisting.length > 0) {
    await db.query(
      'UPDATE lead_followups SET immediate = ?, updated_at = NOW() WHERE chat_user_id = ? AND client_id = ?',
      [immediate, userId, clientId]
    );
  } else {
    await db.query(
      'INSERT INTO lead_followups (chat_user_id, client_id, immediate, status) VALUES (?, ?, ?, ?)',
      [userId, clientId, immediate, 'pending']
    );
  }
};

// POST /api/summary/batch — runs Gemini on all (user, client) pairs with no summary yet
const batchProcess = async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ success: false, message: 'GEMINI_API_KEY not configured' });
  }

  try {
    const [users] = await db.query(
      `SELECT c.chat_user_id AS id, cu.name, c.client_id
       FROM conversations c
       INNER JOIN chat_users cu ON c.chat_user_id = cu.id
       WHERE cu.is_summarized = 0
       GROUP BY c.chat_user_id, c.client_id
       LIMIT ?`,
      [BATCH_LIMIT]
    );

    if (users.length === 0) {
      return res.json({ success: true, message: 'No unsummarized users found', processed: 0, results: {} });
    }

    console.log(`[BatchSummary] Processing ${users.length} (user, client) pairs`);

    const results = { success: 0, skipped: 0, failed: 0, errors: [] };

    for (const user of users) {
      try {
        console.log(`[BatchSummary] Processing user ${user.id} (${user.name}) for client ${user.client_id}`);

        const summary = await runGemini(user.id, user.client_id, user.name);

        if (!summary) {
          results.skipped++;
          console.log(`[BatchSummary] Skipped user ${user.id} / client ${user.client_id} — no messages`);
          continue;
        }

        await saveSummary(user.id, user.client_id, summary);
        results.success++;
        console.log(`[BatchSummary] Done user ${user.id} / client ${user.client_id} — leadType: ${summary.leadType}`);

        await sleep(500);
      } catch (err) {
        console.error(`[BatchSummary] Failed user ${user.id} / client ${user.client_id}:`, err.message);
        results.failed++;
        results.errors.push({ userId: user.id, clientId: user.client_id, name: user.name, error: err.message });
      }
    }

    return res.json({
      success: true,
      message: `Batch complete. ${results.success} processed, ${results.skipped} skipped, ${results.failed} failed.`,
      processed: users.length,
      results,
    });
  } catch (error) {
    console.error('[BatchSummary] Fatal error:', error);
    return res.status(500).json({ success: false, message: 'Batch processing failed', error: error.message });
  }
};

// GET /api/summary/lead/:userId — fetch saved summary scoped to the logged-in client
const getLeadSummary = async (req, res) => {
  try {
    const { userId } = req.params;
    const clientId = await getClientId(req.user.username);

    const [rows] = await db.query(
      `SELECT ls.*, cu.name AS user_name
       FROM lead_summary ls
       INNER JOIN chat_users cu ON ls.chat_user_id = cu.id
       WHERE ls.chat_user_id = ? AND ls.client_id = ?`,
      [userId, clientId]
    );

    if (rows.length === 0) {
      return res.json({ success: false, message: 'No summary found. Run batch process first.' });
    }

    const row = rows[0];
    const keyInterests = typeof row.lead_key_interests === 'string'
      ? JSON.parse(row.lead_key_interests)
      : (row.lead_key_interests || []);

    return res.json({
      success: true,
      data: {
        id: row.id,
        chatUserId: row.chat_user_id,
        clientId: row.client_id,
        leadType: row.lead_type,
        leadProfile: row.lead_profile,
        keyInterests,
        conversationSummary: row.conversation_summary,
        followUp: row.follow_up_action,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (error) {
    console.error('[GetLeadSummary] Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch summary', error: error.message });
  }
};

// PATCH /api/summary/lead/:userId/category — manually override lead_type for this client
const updateLeadCategory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { leadType } = req.body;
    const clientId = await getClientId(req.user.username);

    const VALID = ['high_intent', 'hot', 'warm', 'cold', 'dead', 'unknown'];
    if (!leadType || !VALID.includes(leadType)) {
      return res.status(400).json({ success: false, message: 'Invalid leadType value' });
    }

    const [existing] = await db.query(
      'SELECT id FROM lead_summary WHERE chat_user_id = ? AND client_id = ?',
      [userId, clientId]
    );

    if (existing.length > 0) {
      await db.query(
        'UPDATE lead_summary SET lead_type = ?, updated_at = NOW() WHERE chat_user_id = ? AND client_id = ?',
        [leadType, userId, clientId]
      );
    } else {
      await db.query(
        'INSERT INTO lead_summary (chat_user_id, client_id, lead_type) VALUES (?, ?, ?)',
        [userId, clientId, leadType]
      );
    }

    return res.json({ success: true, leadType });
  } catch (error) {
    console.error('[UpdateLeadCategory] Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update category', error: error.message });
  }
};

module.exports = { batchProcess, getLeadSummary, updateLeadCategory };
