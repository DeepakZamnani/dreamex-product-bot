const express = require('express');
const router  = express.Router();
const propertyController = require('../controllers/propertyController');

// All public — no auth middleware
router.get('/:slug',                      propertyController.getProperty);
router.get('/:slug/conversation',         propertyController.newConversationId);
router.post('/:slug/chat',                propertyController.propertyChat);
router.get('/:slug/:leadPhone/messages',  propertyController.getLeadMessages);
router.post('/:slug/:leadPhone/chat',     propertyController.leadChat);

module.exports = router;
