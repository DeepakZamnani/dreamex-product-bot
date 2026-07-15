const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const authController = require('../controllers/authController');
const { authMiddleware, adminOnly } = require('../middleware/authMiddleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
      'image/heic', 'image/heif', 'image/avif',
      'application/pdf',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not allowed: ${file.mimetype}. Use JPG, PNG, WebP, HEIC or PDF.`));
  },
});

const brokerUpload = upload.fields([
  { name: 'brochure', maxCount: 1 },
  { name: 'images',   maxCount: 10 },
]);

// Public routes
router.post('/login', authController.login);
router.post('/register-broker', (req, res, next) => {
  brokerUpload(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, authController.registerBroker);


router.get('/me', authMiddleware, authController.getCurrentUser);

// Admin-only routes
router.get('/users', authMiddleware, adminOnly, authController.getAllUsers);
router.get('/users/:id', authMiddleware, adminOnly, authController.getUserById);
router.post('/users', authMiddleware, adminOnly, authController.createUser);
router.put('/users/:id', authMiddleware, adminOnly, authController.updateUser);
router.delete('/users/:id', authMiddleware, adminOnly, authController.deleteUser);
router.get('/clients', authMiddleware, adminOnly, authController.getAllClients);
// New toggle status route
router.patch('/users/:id/toggle-status', authMiddleware, adminOnly, authController.toggleClientStatus);
module.exports = router;