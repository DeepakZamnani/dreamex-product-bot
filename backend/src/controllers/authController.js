const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');

const slugify = (str) =>
  str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');


exports.registerBroker = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const {
      password,
      property_name, rera_id, property_location, property_city,
      property_type, property_description,
      broker_name, broker_phone, broker_email,
    } = req.body;

    
    if (!password || !property_name || !rera_id || !property_location || !broker_name || !broker_phone) {
      return res.status(400).json({ success: false, message: 'Required fields: password, property_name, rera_id, property_location, broker_name, broker_phone' });
    }
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    // Auto-generate unique slug + username from property name
    let baseSlug = slugify(property_name.trim());
    let slug = baseSlug;
    let suffix = 1;
    while (true) {
      const [taken] = await conn.query('SELECT id FROM brokers WHERE web_slug = ?', [slug]);
      if (!taken.length) break;
      slug = `${baseSlug}-${++suffix}`;
    }

    let username = slug;
    const [uTaken] = await conn.query('SELECT id FROM users WHERE username = ?', [username]);
    if (uTaken.length) username = `${slug}-${Date.now().toString().slice(-4)}`;

    const hashed = await bcrypt.hash(password, 10);

    await conn.beginTransaction();

    // 1. Insert user
    const [userResult] = await conn.query(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, hashed, 'broker']
    );

    // 2. Insert broker row (no files yet — we need brokerId for S3 path)
    const [brokerResult] = await conn.query(
      `INSERT INTO brokers
         (user_id, property_name, rera_id, property_location, property_city,
          property_type, property_description, broker_name, broker_phone, broker_email,
          web_slug, brochure_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending')`,
      [
        userResult.insertId,
        property_name.trim(), rera_id.trim(), property_location.trim(),
        property_city?.trim() || null, property_type?.trim() || null,
        property_description?.trim() || null,
        broker_name.trim(), broker_phone.trim(), broker_email?.trim() || null,
        slug,
      ]
    );

    const brokerId = brokerResult.insertId;

    // 3. Upload files to S3 using broker/{property_name}-{id}/type/
    const { uploadToS3, brokerKey } = require('../utils/s3Upload');
    let brochureUrl = null;
    const imageUrls = [];

    if (req.files?.brochure?.[0]) {
      const f = req.files.brochure[0];
      brochureUrl = await uploadToS3(
        f.buffer,
        brokerKey(property_name.trim(), brokerId, 'brochure', f.originalname),
        f.mimetype
      );
      await conn.query('UPDATE brokers SET brochure_url = ? WHERE id = ?', [brochureUrl, brokerId]);
    }

    if (req.files?.images) {
      for (const f of req.files.images) {
        const url = await uploadToS3(
          f.buffer,
          brokerKey(property_name.trim(), brokerId, 'property', f.originalname),
          f.mimetype
        );
        imageUrls.push(url);
      }
    }

    if (imageUrls.length) {
      const imgRows = imageUrls.map(url => [brokerId, url, 'property']);
      await conn.query('INSERT INTO broker_images (broker_id, image_url, image_type) VALUES ?', [imgRows]);
    }

    await conn.commit();
    conn.release();

    const token = jwt.sign(
      { id: userResult.insertId, username, role: 'broker', userId: userResult.insertId },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful.',
      username,
      web_slug: slug,
      token,
      role: 'broker',
      broker_status: 'pending',
    });
  } catch (error) {
    try { await conn.rollback(); } catch {}
    try { conn.release(); } catch {}
    console.error('Register broker error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
};

// Login controller
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    
    const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);

    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const user = rows[0];

    
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Check broker status — suspended blocked, pending allowed in with status flag
    if (user.role === 'broker') {
      const [brokerRows] = await db.query('SELECT status FROM brokers WHERE user_id = ?', [user.id]);
      const brokerStatus = brokerRows[0]?.status;
      if (brokerStatus === 'suspended') {
        return res.status(403).json({ message: 'Your account has been suspended. Please contact support.' });
      }
      // pending brokers get a flag in the response so frontend shows pending screen
      if (brokerStatus === 'pending') {
        const pendingToken = jwt.sign(
          { id: user.id, username: user.username, role: 'broker', userId: user.id },
          process.env.JWT_SECRET,
          { expiresIn: '24h' }
        );
        return res.json({
          message: 'Login successful',
          token: pendingToken,
          username: user.username,
          role: 'broker',
          broker_status: 'pending',
        });
      }
    }

    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username,
        role: user.role,
        userId: user.id
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      username: user.username,
      role: user.role
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get current user (protected route)
exports.getCurrentUser = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, username, role, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ user: rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get all users (admin only)
exports.getAllUsers = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at DESC'
    );

    res.json({ 
      success: true,
      users: rows 
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error' 
    });
  }
};

// Get single user (admin only)
exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      'SELECT id, username, role, created_at FROM users WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }

    res.json({ 
      success: true,
      user: rows[0] 
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error' 
    });
  }
};

// Create new user (admin only)
exports.createUser = async (req, res) => {
  try {
    const { username, password, role } = req.body;

    // Validate input
    if (!username || !password || !role) {
      return res.status(400).json({ 
        success: false,
        message: 'Username, password, and role are required' 
      });
    }

    // Validate role
    if (!['admin', 'client', 'broker'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Role must be admin, client, or broker'
      });
    }

    // Check if username already exists
    const [existingUsers] = await db.query(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({ 
        success: false,
        message: 'Username already exists' 
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    const [result] = await db.query(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, hashedPassword, role]
    );

    // Get created user
    const [newUser] = await db.query(
      'SELECT id, username, role, created_at FROM users WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      user: newUser[0]
    });

  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error' 
    });
  }
};

// Update user (admin only)
exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { username, password, role } = req.body;

    const [existingUser] = await db.query(
      'SELECT id FROM users WHERE id = ?',
      [id]
    );

    if (existingUser.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }

    if (role && !['admin', 'client', 'broker'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Role must be admin, client, or broker'
      });
    }

    if (username) {
      const [duplicateCheck] = await db.query(
        'SELECT id FROM users WHERE username = ? AND id != ?',
        [username, id]
      );

      if (duplicateCheck.length > 0) {
        return res.status(409).json({ 
          success: false,
          message: 'Username already exists' 
        });
      }
    }

    let updateFields = [];
    let updateValues = [];

    if (username) {
      updateFields.push('username = ?');
      updateValues.push(username);
    }

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }

    if (role) {
      updateFields.push('role = ?');
      updateValues.push(role);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'No fields to update' 
      });
    }

    updateValues.push(id);

    await db.query(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    const [updatedUser] = await db.query(
      'SELECT id, username, role, created_at FROM users WHERE id = ?',
      [id]
    );

    res.json({
      success: true,
      message: 'User updated successfully',
      user: updatedUser[0]
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error' 
    });
  }
};

// Delete user (admin only)
exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ 
        success: false,
        message: 'Cannot delete your own account' 
      });
    }

    const [existingUser] = await db.query(
      'SELECT id FROM users WHERE id = ?',
      [id]
    );

    if (existingUser.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }

    await db.query('DELETE FROM users WHERE id = ?', [id]);

    res.json({
      success: true,
      message: 'User deleted successfully'
    });

  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error' 
    });
  }
};

// Get all clients (admin only)
exports.getAllClients = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, username, role, created_at FROM users WHERE role = "client" ORDER BY created_at DESC'
    );

    res.json({ 
      success: true,
      clients: rows 
    });
  } catch (error) {
    console.error('Get clients error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error' 
    });
  }
};



// Toggle client active status
exports.toggleClientStatus = async (req, res) => {
  const clientId = req.params.id;
  const { is_active } = req.body;

  // Validate that is_active is a boolean
  if (typeof is_active !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'Invalid status value'
    });
  }

  try {

    // Check if client exists
    const [clients] = await db.execute(
      'SELECT id, name, email FROM clients WHERE id = ?',
      [clientId]
    );

    if (clients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    // Update client status (both is_active boolean and status enum)
    const statusValue = is_active ? 1 : 0;
    const statusEnum = is_active ? 'active' : 'inactive';
    
    await db.execute(
      'UPDATE clients SET is_active = ?, status = ? WHERE id = ?',
      [statusValue, statusEnum, clientId]
    );

    res.json({
      success: true,
      message: `Client ${is_active ? 'activated' : 'deactivated'} successfully`,
      data: {
        id: parseInt(clientId),
        name: clients[0].name,
        email: clients[0].email,
        is_active: is_active,
        status: statusEnum
      }
    });

  } catch (error) {
    console.error('Toggle client status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating client status'
    });
  }
};


