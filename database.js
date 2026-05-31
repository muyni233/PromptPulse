import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize SQLite database file in the workspace
const dbPath = join(__dirname, 'prompt_pulse.db');
const db = new DatabaseSync(dbPath);

console.log(`[Database] Connected to SQLite database at ${dbPath}`);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER,
    model TEXT,
    system_prompt TEXT,
    user_prompt TEXT,
    messages TEXT,
    response_text TEXT,
    response_json TEXT,
    duration INTEGER,
    status INTEGER,
    tokens_prompt INTEGER,
    tokens_completion INTEGER,
    error_message TEXT,
    upstream_url TEXT,
    is_stream INTEGER
  );
`);

// Create indexes
db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_model ON logs(model);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_status ON logs(status);`);

// Initialize default settings if they don't exist
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?);');
insertSetting.run('default_upstream_url', 'https://api.openai.com/v1');
insertSetting.run('default_upstream_key', '');
insertSetting.run('collector_api_key', '');
insertSetting.run('dashboard_password', '');
insertSetting.run('default_gemini_url', 'https://generativelanguage.googleapis.com');
insertSetting.run('default_gemini_key', '');

// Legacy mock defaults migration to official URLs
db.exec(`
  UPDATE settings 
  SET value = 'https://api.openai.com/v1' 
  WHERE key = 'default_upstream_url' AND (value = 'http://localhost:3000/mock/v1' OR value = 'http://127.0.0.1:3000/mock/v1');
`);
db.exec(`
  UPDATE settings 
  SET value = 'https://generativelanguage.googleapis.com' 
  WHERE key = 'default_gemini_url' AND (value = 'http://localhost:3000/mock/v1beta' OR value = 'http://127.0.0.1:3000/mock/v1beta');
`);

/**
 * Database interface helper methods
 */
export const dbService = {
  // --- Settings ---
  getSettings() {
    const query = db.prepare('SELECT key, value FROM settings;');
    const rows = query.all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  },

  getSetting(key) {
    const query = db.prepare('SELECT value FROM settings WHERE key = ?;');
    const row = query.get(key);
    return row ? row.value : null;
  },

  saveSettings(settingsObj) {
    const updateQuery = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?);');
    for (const [key, value] of Object.entries(settingsObj)) {
      updateQuery.run(key, String(value));
    }
    return true;
  },

  // --- Logs ---
  saveLog(log) {
    const insertQuery = db.prepare(`
      INSERT INTO logs (
        id, timestamp, model, system_prompt, user_prompt, messages, 
        response_text, response_json, duration, status, 
        tokens_prompt, tokens_completion, error_message, upstream_url, is_stream
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      );
    `);

    insertQuery.run(
      log.id,
      log.timestamp || Date.now(),
      log.model || 'unknown',
      log.system_prompt || '',
      log.user_prompt || '',
      JSON.stringify(log.messages || []),
      log.response_text || '',
      log.response_json ? JSON.stringify(log.response_json) : null,
      log.duration || 0,
      log.status || 200,
      log.tokens_prompt || 0,
      log.tokens_completion || 0,
      log.error_message || null,
      log.upstream_url || '',
      log.is_stream ? 1 : 0
    );
    return log.id;
  },

  getLogs({ search = '', limit = 100, offset = 0, status = null, model = null } = {}) {
    let sql = 'SELECT * FROM logs WHERE 1=1';
    const params = [];

    if (search) {
      sql += ' AND (model LIKE ? OR system_prompt LIKE ? OR user_prompt LIKE ? OR response_text LIKE ? OR error_message LIKE ?)';
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam, searchParam, searchParam);
    }

    if (status !== null && status !== undefined && status !== '') {
      sql += ' AND status = ?';
      params.push(Number(status));
    }

    if (model) {
      sql += ' AND model = ?';
      params.push(model);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const query = db.prepare(sql);
    const rows = query.all(...params);

    // Format logs back to JSON structures
    return rows.map(row => ({
      ...row,
      messages: JSON.parse(row.messages || '[]'),
      response_json: row.response_json ? JSON.parse(row.response_json) : null,
      is_stream: row.is_stream === 1
    }));
  },

  getLogById(id) {
    const query = db.prepare('SELECT * FROM logs WHERE id = ?;');
    const row = query.get(id);
    if (!row) return null;
    return {
      ...row,
      messages: JSON.parse(row.messages || '[]'),
      response_json: row.response_json ? JSON.parse(row.response_json) : null,
      is_stream: row.is_stream === 1
    };
  },

  clearLogs() {
    db.exec('DELETE FROM logs;');
    return true;
  },

  // --- Statistics ---
  getStats() {
    // Basic stats
    const totalQuery = db.prepare('SELECT COUNT(*) as count FROM logs;').get();
    const successQuery = db.prepare('SELECT COUNT(*) as count FROM logs WHERE status >= 200 AND status < 300;').get();
    const errorQuery = db.prepare('SELECT COUNT(*) as count FROM logs WHERE status >= 400 OR status = 0;').get();
    
    const tokensQuery = db.prepare('SELECT SUM(tokens_prompt) as input, SUM(tokens_completion) as output FROM logs WHERE status >= 200 AND status < 300;').get();
    const durationQuery = db.prepare('SELECT AVG(duration) as avg_duration FROM logs WHERE status >= 200 AND status < 300;').get();

    // Models breakdown
    const modelsBreakdown = db.prepare(`
      SELECT model, COUNT(*) as count, SUM(tokens_prompt + tokens_completion) as total_tokens 
      FROM logs 
      GROUP BY model 
      ORDER BY count DESC;
    `).all();

    // Recent latency list
    const recentLatency = db.prepare(`
      SELECT timestamp, duration, status, model 
      FROM logs 
      ORDER BY timestamp DESC 
      LIMIT 20;
    `).all();

    // Daily volume (last 7 days)
    const dailyVolume = db.prepare(`
      SELECT 
        strftime('%Y-%m-%d', datetime(timestamp / 1000, 'unixepoch', 'localtime')) as date,
        COUNT(*) as count,
        SUM(tokens_prompt + tokens_completion) as total_tokens
      FROM logs
      WHERE timestamp > ?
      GROUP BY date
      ORDER BY date ASC;
    `).all(Date.now() - 7 * 24 * 60 * 60 * 1000);

    return {
      total_requests: totalQuery ? totalQuery.count : 0,
      success_requests: successQuery ? successQuery.count : 0,
      error_requests: errorQuery ? errorQuery.count : 0,
      total_tokens_input: tokensQuery ? (tokensQuery.input || 0) : 0,
      total_tokens_output: tokensQuery ? (tokensQuery.output || 0) : 0,
      avg_latency_ms: durationQuery ? Math.round(durationQuery.avg_duration || 0) : 0,
      models_breakdown: modelsBreakdown || [],
      recent_latency: recentLatency || [],
      daily_volume: dailyVolume || []
    };
  }
};
