const db = require('../config/database');

const getClientId = async (username) => {
  const [rows] = await db.query('SELECT id FROM clients WHERE name = ?', [username]);
  if (!rows.length) throw new Error(`Client not found: ${username}`);
  return rows[0].id;
};

// GET /api/leads/:userId/notes
const getNotes = async (req, res) => {
  try {
    const clientId = await getClientId(req.user.username);
    const { userId } = req.params;

    const [notes] = await db.query(
      `SELECT id, note, note_date, note_time, created_at, updated_at
       FROM lead_notes
       WHERE chat_user_id = ? AND client_id = ?
       ORDER BY note_date DESC, note_time DESC`,
      [userId, clientId]
    );

    res.json({ success: true, notes });
  } catch (err) {
    console.error('[getNotes]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch notes' });
  }
};

// POST /api/leads/:userId/notes
const addNote = async (req, res) => {
  try {
    const clientId = await getClientId(req.user.username);
    const { userId } = req.params;
    const { note, note_date, note_time } = req.body;

    if (!note?.trim()) return res.status(400).json({ success: false, message: 'Note cannot be empty' });

    const date = note_date || new Date().toISOString().split('T')[0];
    const time = note_time || new Date().toTimeString().slice(0, 5);

    const [result] = await db.query(
      'INSERT INTO lead_notes (chat_user_id, client_id, note, note_date, note_time) VALUES (?, ?, ?, ?, ?)',
      [userId, clientId, note.trim(), date, time]
    );

    const [rows] = await db.query(
      'SELECT id, note, note_date, note_time, created_at FROM lead_notes WHERE id = ?',
      [result.insertId]
    );

    res.json({ success: true, note: rows[0] });
  } catch (err) {
    console.error('[addNote]', err.message);
    res.status(500).json({ success: false, message: 'Failed to add note' });
  }
};

// PATCH /api/leads/notes/:noteId
const updateNote = async (req, res) => {
  try {
    const clientId = await getClientId(req.user.username);
    const { noteId } = req.params;
    const { note, note_date, note_time } = req.body;

    if (!note?.trim()) return res.status(400).json({ success: false, message: 'Note cannot be empty' });

    const [existing] = await db.query(
      'SELECT id FROM lead_notes WHERE id = ? AND client_id = ?',
      [noteId, clientId]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Note not found' });

    await db.query(
      'UPDATE lead_notes SET note = ?, note_date = ?, note_time = ?, updated_at = NOW() WHERE id = ?',
      [note.trim(), note_date, note_time, noteId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[updateNote]', err.message);
    res.status(500).json({ success: false, message: 'Failed to update note' });
  }
};

// DELETE /api/leads/notes/:noteId
const deleteNote = async (req, res) => {
  try {
    const clientId = await getClientId(req.user.username);
    const { noteId } = req.params;

    await db.query(
      'DELETE FROM lead_notes WHERE id = ? AND client_id = ?',
      [noteId, clientId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[deleteNote]', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete note' });
  }
};

module.exports = { getNotes, addNote, updateNote, deleteNote };
