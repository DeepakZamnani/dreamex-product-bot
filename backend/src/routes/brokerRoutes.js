const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const brokerController = require('../controllers/brokerController');
const { authMiddleware } = require('../middleware/authMiddleware');

const storage = multer.diskStorage({
  destination: '/tmp/',
  filename: (req, file, cb) => cb(null, `broker-${Date.now()}${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only CSV and Excel files are allowed'));
  },
});

router.use(authMiddleware);

// Property profile
const propertyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif','image/avif','application/pdf'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});

router.get('/dashboard',                          brokerController.getDashboard);
router.get('/property',                           brokerController.getProperty);
router.patch('/property',                         brokerController.updateProperty);
router.post('/property/images',                   propertyUpload.array('images', 10), brokerController.addPropertyImages);
router.delete('/property/images/:imageId',        brokerController.deletePropertyImage);
router.post('/property/brochure',                 propertyUpload.single('brochure'), brokerController.updateBrochure);
router.delete('/property/brochure',               brokerController.deleteBrochure);

router.post('/upload',                    upload.single('file'), brokerController.uploadLeads);
router.get('/leads',                      brokerController.getLeads);
router.post('/verify',                    brokerController.verifyLeads);
router.delete('/leads',                   brokerController.deleteLeads);
router.get('/leads/:leadId',              brokerController.getBrokerLead);
router.post('/leads/:leadId/analyze',    brokerController.analyzeLead);
router.get('/leads/:leadId/conversation', brokerController.getLeadConversation);
router.patch('/leads/:leadId/status',     brokerController.updateLeadStatus);
router.patch('/leads/:leadId/followup',   brokerController.updateFollowup);

module.exports = router;
