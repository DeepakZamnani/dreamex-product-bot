const db = require('../config/database');

// GET /api/admin/brokers?status=pending|active|suspended
const getBrokers = async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? 'WHERE b.status = ?' : '';
    const params = status ? [status] : [];

    const [rows] = await db.query(
      `SELECT
         b.id, b.status, b.web_slug, b.n8n_url,
         b.property_name, b.rera_id, b.property_location, b.property_city,
         b.property_type, b.property_description, b.brochure_url,
         b.broker_name, b.broker_phone, b.broker_email,
         b.created_at,
         u.id AS user_id, u.username,
         (SELECT COUNT(*) FROM broker_images WHERE broker_id = b.id) AS image_count,
         (SELECT COUNT(*) FROM broker_leads   WHERE broker_id = u.id) AS lead_count
       FROM brokers b
       JOIN users u ON u.id = b.user_id
       ${where}
       ORDER BY b.created_at DESC`,
      params
    );

    res.json({ success: true, brokers: rows });
  } catch (err) {
    console.error('[brokerAdmin] getBrokers:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /api/admin/brokers/:brokerId/activate  { n8n_url }
const activateBroker = async (req, res) => {
  try {
    const { brokerId } = req.params;
    const { n8n_url }  = req.body;

    if (!n8n_url?.trim()) {
      return res.status(400).json({ success: false, message: 'n8n_url is required to activate' });
    }

    await db.query(
      'UPDATE brokers SET status = "active", n8n_url = ? WHERE id = ?',
      [n8n_url.trim(), brokerId]
    );

    res.json({ success: true, message: 'Broker activated' });
  } catch (err) {
    console.error('[brokerAdmin] activateBroker:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /api/admin/brokers/:brokerId/suspend
const suspendBroker = async (req, res) => {
  try {
    const { brokerId } = req.params;
    await db.query('UPDATE brokers SET status = "suspended" WHERE id = ?', [brokerId]);
    res.json({ success: true, message: 'Broker suspended' });
  } catch (err) {
    console.error('[brokerAdmin] suspendBroker:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /api/admin/brokers/:brokerId/reactivate
const reactivateBroker = async (req, res) => {
  try {
    const { brokerId } = req.params;
    await db.query('UPDATE brokers SET status = "active" WHERE id = ?', [brokerId]);
    res.json({ success: true, message: 'Broker reactivated' });
  } catch (err) {
    console.error('[brokerAdmin] reactivateBroker:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { getBrokers, activateBroker, suspendBroker, reactivateBroker };
