const logger = require('../utils/logger.js');
const _log = logger.child({ module: 'activateLeadsController' });

const AZMARQ_API_URL = process.env.AZMARQ_API_URL || 'https://api.azmarq.com';
const AZMARQ_API_KEY = process.env.AZMARQ_API_KEY;
const AZMARQ_BUSINESS_NUMBER = process.env.AZMARQ_BUSINESS_NUMBER;

const formatPhone = (phone) => {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
};

const activateLeadsController = {

  getTemplates: async (req, res) => {
    try {
      _log.info('[ActivateLeads] Fetching templates from Azmarq');

      const response = await fetch(`${AZMARQ_API_URL}/v1/whatsapp/getWaTemplate`, {
        method: 'GET',
        headers: {
          'apikey': AZMARQ_API_KEY,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        _log.warn(`[ActivateLeads] Template list endpoint returned ${response.status} — using fallback`);
        return res.json({ success: true, fallback: true, templates: [] });
      }

      const data = await response.json();
      _log.info('[ActivateLeads] Templates fetched successfully');

      const templates = Array.isArray(data) ? data : (data.templates || data.data || []);

      return res.json({ success: true, fallback: false, templates });
    } catch (err) {
      _log.warn(`[ActivateLeads] Could not fetch templates: ${err.message} — using fallback`);
      return res.json({ success: true, fallback: true, templates: [] });
    }
  },

  sendBulkTemplates: async (req, res) => {
    const { templateName, contacts } = req.body;

    if (!templateName || !templateName.trim()) {
      return res.status(400).json({ success: false, message: 'Template name is required' });
    }

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, message: 'Contacts list is required and must not be empty' });
    }

    if (!AZMARQ_BUSINESS_NUMBER) {
      return res.status(500).json({ success: false, message: 'WhatsApp business number not configured. Set AZMARQ_BUSINESS_NUMBER in .env' });
    }

    _log.info(`[ActivateLeads] Sending template "${templateName}" to ${contacts.length} contacts`);

    const results = [];

    for (const contact of contacts) {
      const phone = formatPhone(contact.phone);

      try {
        const response = await fetch(`${AZMARQ_API_URL}/v1/whatsapp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': AZMARQ_API_KEY,
          },
          body: JSON.stringify({
            from: AZMARQ_BUSINESS_NUMBER,
            to: phone,
            type: 'template',
            templateName: templateName.trim(),
            campaignName: 'OldLeadActivation',
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          _log.warn(`[ActivateLeads] Failed to send to ${phone}: ${errText}`);
          results.push({ phone, name: contact.name || '', status: 'failed', error: `HTTP ${response.status}` });
        } else {
          const data = await response.json();
          const messageId = data?.data?.[0]?.messageId || data?.id || null;
          _log.info(`[ActivateLeads] Sent to ${phone}, messageId: ${messageId}`);
          results.push({ phone, name: contact.name || '', status: 'sent', messageId });
        }
      } catch (err) {
        _log.error(`[ActivateLeads] Error sending to ${phone}: ${err.message}`);
        results.push({ phone, name: contact.name || '', status: 'failed', error: err.message });
      }

      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 100));
    }

    const sent = results.filter((r) => r.status === 'sent').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    _log.info(`[ActivateLeads] Done — sent: ${sent}, failed: ${failed}`);

    return res.json({
      success: true,
      total: contacts.length,
      sent,
      failed,
      results,
    });
  },
};

module.exports = activateLeadsController;
