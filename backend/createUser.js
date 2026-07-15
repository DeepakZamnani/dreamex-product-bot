const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function createUser(username, password, role = 'client') {
  try {
    // Validate role
    if (!['admin', 'client'].includes(role)) {
      console.error('❌ Invalid role. Must be "admin" or "client"');
      return;
    }

    // Connect to database
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    // Check if user already exists
    const [existingUsers] = await connection.query(
      'SELECT username FROM users WHERE username = ?',
      [username]
    );

    if (existingUsers.length > 0) {
      console.error(`❌ User "${username}" already exists!`);
      await connection.end();
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user with role
    await connection.query(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, hashedPassword, role]
    );

    console.log('✅ User created successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Username:', username);
    console.log('Password:', password);
    console.log('Role:', role.toUpperCase());
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━');

    await connection.end();
  } catch (error) {
    console.error('❌ Error creating user:', error.message);
  }
}

// Get command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📝 Usage: node createUser.js <username> <password> [role]');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Roles: admin | client (default: client)');
  console.log('');
  console.log('Examples:');
  console.log('  node createUser.js admin admin123 admin');
  console.log('  node createUser.js john john123 client');
  console.log('  node createUser.js jane jane123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(1);
}

const username = args[0];
const password = args[1];
const role = args[2] || 'client';

createUser(username, password, role);