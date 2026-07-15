const db = require('../config/database');
const logger = require('../utils/logger.js');
const _log = logger.child({ module: 'brochureGenerationsController' });

const brochureGenerationsController = {

  getAll: async (req, res) => {
    _log.info('[BrochureGenerations] Fetching all rows from brochure_generations');
    try {
      const [rows] = await db.query(
        'SELECT * FROM brochure_generations ORDER BY id DESC'
      );
      _log.info(`[BrochureGenerations] Fetched ${rows.length} rows`);
      return res.json({ success: true, total: rows.length, generations: rows });
    } catch (err) {
      _log.error(`[BrochureGenerations] DB error: ${err.message} — code=${err.code}`);
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  },

};

module.exports = brochureGenerationsController;
