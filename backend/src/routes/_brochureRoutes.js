const express = require('express');
const router = express.Router();
const brochureController = require('../controllers/brochureController');


router.post('/add-generation', brochureController.addGeneration);
router.get('/status', brochureController.status);

module.exports = router;
