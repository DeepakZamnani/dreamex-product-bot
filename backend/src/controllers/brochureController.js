const db = require('../config/database');
const logger = require('../utils/logger.js');
const _log = logger.child({ module: 'brochureController' });

const brochureController = {

  addGeneration: async (req, res) => {
    _log.info('[Brochure] addGeneration called');

    const { name, phone, template_name } = req.body;
    _log.info(`[Brochure] Payload received — name=${name} phone=${phone} template_name=${template_name}`);

    if (!name || !String(name).trim()) {
      _log.warn('[Brochure] Validation failed — name missing');
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    if (!phone || !String(phone).trim()) {
      _log.warn('[Brochure] Validation failed — phone missing');
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    if (!template_name || !String(template_name).trim()) {
      _log.warn('[Brochure] Validation failed — template_name missing');
      return res.status(400).json({ success: false, message: 'template_name is required' });
    }

    _log.info('[Brochure] Validation passed — acquiring DB connection');

    try {
      _log.info('[Brochure] Running INSERT query');

      const [result] = await db.query(
        'INSERT INTO brochure_generations (name, phone, template_name) VALUES (?, ?, ?)',
        [String(name).trim(), String(phone).trim(), String(template_name).trim()]
      );

      _log.info(`[Brochure] INSERT success — insertId=${result.insertId}`);

      return res.status(201).json({ success: true, id: result.insertId });
    } catch (err) {
      _log.error(`[Brochure] DB error: ${err.message} — code=${err.code} errno=${err.errno}`);
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  },

  status: async (_req, res) => {
    _log.info('[Brochure] Status check — testing DB connection');
    try {
      await db.query('SELECT 1');
      _log.info('[Brochure] DB connection OK');
      return res.json({ success: true, db: 'ok' });
    } catch (err) {
      _log.error(`[Brochure] DB connection failed — ${err.message} code=${err.code}`);
      return res.json({ success: false, db: 'error', error: err.message });
    }
  },

};

module.exports = brochureController;
