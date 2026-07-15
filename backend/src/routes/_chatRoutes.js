const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const {authMiddleware} = require('../middleware/authMiddleware');


// router.use(authMiddleware);
// Routes which are public, file name should start with an "_"
//TODO: we can replace public route with a temporary token system.

router.get('/newconversation', chatController.getNewConversationId);
router.post('/webhook/:slug', chatController.webhook);

module.exports = router;