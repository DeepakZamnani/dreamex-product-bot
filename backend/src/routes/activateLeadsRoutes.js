const express = require('express');
const router = express.Router();
const activateLeadsController = require('../controllers/activateLeadsController');
const { authMiddleware, clientOnly } = require('../middleware/authMiddleware');

router.use(authMiddleware);
router.use(clientOnly);

router.get('/templates', activateLeadsController.getTemplates);
router.post('/send', activateLeadsController.sendBulkTemplates);

module.exports = router;
