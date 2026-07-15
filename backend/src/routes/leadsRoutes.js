const express = require('express');
const router = express.Router();
const leadsController = require('../controllers/leadsController');
const notesController = require('../controllers/notesController');
const { authMiddleware } = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.get('/', leadsController.getLeads);
router.get('/templates', leadsController.getTemplates);


router.get('/:userId', leadsController.getLeadDetails);

router.get('/:userId/conversations', leadsController.getUserConversations);
router.patch('/followup/:userId',          leadsController.updateFollowup);
router.patch('/next-action/:userId',       leadsController.updateNextAction);
router.patch('/lead-status/:userId',       leadsController.updateLeadStatus);
router.patch('/schedule-visit/:userId',    leadsController.scheduleVisit);
router.delete('/:userId',                  leadsController.deleteLead);
router.post('/send-followup/:userId',      leadsController.sendFollowupTemplate);
router.post('/bulk-followup',              leadsController.bulkFollowupTemplate);

// Notes — must come before /:userId to avoid route conflicts
router.get('/:userId/notes',       notesController.getNotes);
router.post('/:userId/notes',      notesController.addNote);
router.patch('/notes/:noteId',     notesController.updateNote);
router.delete('/notes/:noteId',    notesController.deleteNote);

module.exports = router;