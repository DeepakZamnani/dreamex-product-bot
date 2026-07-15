const express = require('express');
const router = express.Router();
const messagesController = require('../controllers/messagesController');
const {authMiddleware} = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.get('/conversation/:conversationId', messagesController.getConversationMessages);

router.get('/user/:userId', messagesController.getUserAllMessages);

module.exports = router;