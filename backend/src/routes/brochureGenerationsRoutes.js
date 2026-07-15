const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/authMiddleware');
const brochureGenerationsController = require('../controllers/brochureGenerationsController');

router.use(authMiddleware);
router.use(adminOnly);

router.get('/', brochureGenerationsController.getAll);

module.exports = router;
