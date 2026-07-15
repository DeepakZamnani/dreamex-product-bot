const express = require('express');
const router = express.Router();
const { authMiddleware, clientOnly } = require('../middleware/authMiddleware');
const { batchProcess, getLeadSummary, updateLeadCategory } = require('../controllers/batchSummaryController');

router.get('/lead/:userId', authMiddleware, clientOnly, getLeadSummary);
router.patch('/lead/:userId/category', authMiddleware, clientOnly, updateLeadCategory);
router.post('/batch', batchProcess);

module.exports = router;
