const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/authMiddleware');
const { getAdminDashboard } = require('../controllers/adminDashboardController');
const brokerAdminController = require('../controllers/brokerAdminController');

router.use(authMiddleware);
router.use(adminOnly);

router.get('/dashboard', getAdminDashboard);

// Broker management
router.get('/brokers',                        brokerAdminController.getBrokers);
router.patch('/brokers/:brokerId/activate',   brokerAdminController.activateBroker);
router.patch('/brokers/:brokerId/suspend',    brokerAdminController.suspendBroker);
router.patch('/brokers/:brokerId/reactivate', brokerAdminController.reactivateBroker);

module.exports = router;