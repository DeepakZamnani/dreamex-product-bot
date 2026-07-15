const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const {
  getAllAgents,
  getAgentById,
  createAgent,
  updateAgent,
  deleteAgent,
  getAllClients,
  toggleAgentStatus,
} = require('../controllers/agentsController');


router.use(authMiddleware);

router.get('/clients', getAllClients);

router.get('/', getAllAgents);

router.get('/:id', getAgentById);

router.post('/', createAgent);


router.put('/:id', updateAgent);


router.delete('/:id', deleteAgent);

router.patch('/:id/toggle-status', toggleAgentStatus);

module.exports = router;