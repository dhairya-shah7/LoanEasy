const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');

// Configuration
const rootAdminEmail = 'vimal1511786@gmail.com';
const isMongo = !!process.env.MONGODB_URI;
const isPg = !isMongo && !!process.env.DATABASE_URL;

let pool = null;
let mongoClient = null;
let mongoDb = null;

if (isPg) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
} else if (isMongo) {
  mongoClient = new MongoClient(process.env.MONGODB_URI);
}

// Local File Paths
const DATA_DIR = path.join(__dirname, 'data');
const LOANS_FILE = path.join(DATA_DIR, 'loans.csv');
const USERS_FILE = path.join(DATA_DIR, 'users.csv');
const AUDIT_FILE = path.join(DATA_DIR, 'audit_logs.csv');

// --- Helper Functions for CSV ---
function ensureLocalDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  // Initialize CSV files with headers if they don't exist
  if (!fs.existsSync(LOANS_FILE)) {
    fs.writeFileSync(LOANS_FILE, 'id,name,pan,login_date,loan_amt,branch,dsa_name,customer_type,loan_type,logged_by,month\n', 'utf8');
  }
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, 'email,role,first_login,last_login,ip_address\n', 'utf8');
  }
  if (!fs.existsSync(AUDIT_FILE)) {
    fs.writeFileSync(AUDIT_FILE, 'id,timestamp,user_email,ip_address,action,details\n', 'utf8');
  }
}

function parseCsvRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function readCsv(filePath) {
  ensureLocalDir();
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  if (lines.length <= 1) return [];
  
  const headers = parseCsvRow(lines[0]).map(h => h.trim());
  const records = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = parseCsvRow(lines[i]);
    const record = {};
    headers.forEach((header, idx) => {
      record[header] = row[idx] || '';
    });
    records.push(record);
  }
  return records;
}

function writeCsv(filePath, headers, records) {
  ensureLocalDir();
  let content = headers.join(',') + '\n';
  records.forEach(rec => {
    content += headers.map(header => {
      const val = rec[header];
      if (val === undefined || val === null) return '';
      let str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        str = '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',') + '\n';
  });
  fs.writeFileSync(filePath, content, 'utf8');
}

function appendToCsv(filePath, headers, record) {
  ensureLocalDir();
  const row = headers.map(header => {
    const val = record[header];
    if (val === undefined || val === null) return '';
    let str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }).join(',') + '\n';
  fs.appendFileSync(filePath, row, 'utf8');
}

// --- Database Operations API ---
const db = {
  // Initialize Database schemas or directory/files
  async init() {
    if (isPg) {
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS loans (
            id VARCHAR(100) PRIMARY KEY,
            name VARCHAR(255),
            pan VARCHAR(20),
            login_date DATE,
            loan_amt NUMERIC,
            branch VARCHAR(255),
            dsa_name VARCHAR(255),
            customer_type VARCHAR(10),
            loan_type VARCHAR(50),
            logged_by VARCHAR(255),
            month VARCHAR(50)
          );
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            email VARCHAR(255) PRIMARY KEY,
            role VARCHAR(50) DEFAULT 'customer',
            first_login TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            last_login TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            ip_address VARCHAR(100)
          );
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS audit_logs (
            id VARCHAR(100) PRIMARY KEY,
            timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            user_email VARCHAR(255),
            ip_address VARCHAR(100),
            action VARCHAR(100),
            details TEXT
          );
        `);
        console.log('PostgreSQL database schemas verified/created.');
      } catch (err) {
        console.error('Error initializing PostgreSQL schemas:', err);
        throw err;
      } finally {
        client.release();
      }
    } else if (isMongo) {
      try {
        await mongoClient.connect();
        mongoDb = mongoClient.db();
        // Create indexes for fast lookup and uniqueness
        await mongoDb.collection('users').createIndex({ email: 1 }, { unique: true });
        await mongoDb.collection('loans').createIndex({ login_date: -1, id: -1 });
        await mongoDb.collection('audit_logs').createIndex({ timestamp: -1 });
        console.log('MongoDB database connection established and indexes verified.');
      } catch (err) {
        console.error('Error connecting to MongoDB:', err);
        throw err;
      }
    } else {
      ensureLocalDir();
      console.log('Local CSV storage structure initialized at ./data/');
    }
  },

  // --- Loan Actions ---
  async saveLoan(loan) {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthName = monthNames[new Date().getMonth()];

    let loanId = loan.id;
    if (!loanId) {
      try {
        const loans = await db.getLoans();
        let nextIdNum = 1;
        loans.forEach(l => {
          const num = parseInt(l.id, 10);
          if (!isNaN(num) && num >= nextIdNum) {
            nextIdNum = num + 1;
          }
        });
        loanId = String(nextIdNum);
      } catch (err) {
        console.error('Failed to generate sequential ID, fallback to timestamp ID:', err);
        loanId = `loan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      }
    }

    const loanRecord = {
      id: loanId,
      name: loan.name,
      pan: loan.pan.toUpperCase(),
      login_date: loan.login_date,
      loan_amt: Number(loan.loan_amt),
      branch: loan.branch,
      dsa_name: loan.dsa_name,
      customer_type: loan.customer_type, // ETB / NTB
      loan_type: loan.loan_type,
      logged_by: loan.logged_by || 'anonymous',
      month: monthName
    };

    if (isPg) {
      await pool.query(
        `INSERT INTO loans (id, name, pan, login_date, loan_amt, branch, dsa_name, customer_type, loan_type, logged_by, month)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          loanRecord.id,
          loanRecord.name,
          loanRecord.pan,
          loanRecord.login_date,
          loanRecord.loan_amt,
          loanRecord.branch,
          loanRecord.dsa_name,
          loanRecord.customer_type,
          loanRecord.loan_type,
          loanRecord.logged_by,
          loanRecord.month
        ]
      );
    } else if (isMongo) {
      await mongoDb.collection('loans').insertOne(loanRecord);
    } else {
      const headers = ['id', 'name', 'pan', 'login_date', 'loan_amt', 'branch', 'dsa_name', 'customer_type', 'loan_type', 'logged_by', 'month'];
      appendToCsv(LOANS_FILE, headers, loanRecord);
    }
    return loanRecord;
  },

  async getLoans() {
    if (isPg) {
      const res = await pool.query('SELECT * FROM loans ORDER BY login_date DESC, id DESC');
      // Format Date type back to string format for consistency
      return res.rows.map(row => ({
        ...row,
        login_date: row.login_date ? new Date(row.login_date).toISOString().split('T')[0] : '',
        loan_amt: Number(row.loan_amt)
      }));
    } else if (isMongo) {
      const records = await mongoDb.collection('loans')
        .find({})
        .sort({ login_date: -1, id: -1 })
        .toArray();
      return records.map(rec => ({
        ...rec,
        login_date: rec.login_date ? new Date(rec.login_date).toISOString().split('T')[0] : '',
        loan_amt: Number(rec.loan_amt)
      }));
    } else {
      const records = readCsv(LOANS_FILE);
      return records.map(rec => ({
        ...rec,
        loan_amt: Number(rec.loan_amt)
      }));
    }
  },

  // --- User / Session Actions ---
  async upsertUser(email, ip) {
    const userEmail = email.toLowerCase().trim();
    const isRootAdmin = userEmail === rootAdminEmail;
    const now = new Date().toISOString();

    if (isPg) {
      // Find user
      const findRes = await pool.query('SELECT * FROM users WHERE email = $1', [userEmail]);
      if (findRes.rows.length > 0) {
        const existingUser = findRes.rows[0];
        // Ensure root admin remains admin
        const updatedRole = isRootAdmin ? 'admin' : existingUser.role;
        const updateRes = await pool.query(
          `UPDATE users 
           SET last_login = $1, ip_address = $2, role = $3
           WHERE email = $4
           RETURNING *`,
          [now, ip, updatedRole, userEmail]
        );
        return updateRes.rows[0];
      } else {
        const role = isRootAdmin ? 'admin' : 'customer';
        const insertRes = await pool.query(
          `INSERT INTO users (email, role, first_login, last_login, ip_address)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [userEmail, role, now, now, ip]
        );
        return insertRes.rows[0];
      }
    } else if (isMongo) {
      const existingUser = await mongoDb.collection('users').findOne({ email: userEmail });
      if (existingUser) {
        const updatedRole = isRootAdmin ? 'admin' : existingUser.role;
        await mongoDb.collection('users').updateOne(
          { email: userEmail },
          { $set: { last_login: now, ip_address: ip, role: updatedRole } }
        );
        const updatedUser = await mongoDb.collection('users').findOne({ email: userEmail });
        return { ...updatedUser, _id: updatedUser._id.toString() };
      } else {
        const role = isRootAdmin ? 'admin' : 'customer';
        const newUser = {
          email: userEmail,
          role: role,
          first_login: now,
          last_login: now,
          ip_address: ip
        };
        await mongoDb.collection('users').insertOne(newUser);
        return { ...newUser, _id: newUser._id ? newUser._id.toString() : undefined };
      }
    } else {
      const users = readCsv(USERS_FILE);
      let user = users.find(u => u.email.toLowerCase() === userEmail);
      
      if (user) {
        user.last_login = now;
        user.ip_address = ip;
        if (isRootAdmin) {
          user.role = 'admin';
        }
      } else {
        user = {
          email: userEmail,
          role: isRootAdmin ? 'admin' : 'customer',
          first_login: now,
          last_login: now,
          ip_address: ip
        };
        users.push(user);
      }
      
      const headers = ['email', 'role', 'first_login', 'last_login', 'ip_address'];
      writeCsv(USERS_FILE, headers, users);
      return user;
    }
  },

  async getUsers() {
    if (isPg) {
      const res = await pool.query('SELECT * FROM users ORDER BY last_login DESC');
      return res.rows;
    } else if (isMongo) {
      const records = await mongoDb.collection('users').find({}).sort({ last_login: -1 }).toArray();
      return records.map(rec => ({ ...rec, _id: rec._id.toString() }));
    } else {
      return readCsv(USERS_FILE);
    }
  },

  async setUserRole(email, role) {
    const userEmail = email.toLowerCase().trim();
    // Protect root admin from demotion
    if (userEmail === rootAdminEmail) return { success: false, error: "Cannot demote root admin" };
    
    if (isPg) {
      const res = await pool.query(
        'UPDATE users SET role = $1 WHERE email = $2 RETURNING *',
        [role, userEmail]
      );
      if (res.rows.length === 0) return { success: false, error: "User not found" };
      return { success: true, user: res.rows[0] };
    } else if (isMongo) {
      const res = await mongoDb.collection('users').updateOne(
        { email: userEmail },
        { $set: { role: role } }
      );
      if (res.matchedCount === 0) return { success: false, error: "User not found" };
      const updatedUser = await mongoDb.collection('users').findOne({ email: userEmail });
      return { success: true, user: { ...updatedUser, _id: updatedUser._id.toString() } };
    } else {
      const users = readCsv(USERS_FILE);
      const user = users.find(u => u.email.toLowerCase() === userEmail);
      if (!user) return { success: false, error: "User not found" };
      
      user.role = role;
      const headers = ['email', 'role', 'first_login', 'last_login', 'ip_address'];
      writeCsv(USERS_FILE, headers, users);
      return { success: true, user };
    }
  },

  async clearUserIp(email) {
    const userEmail = email.toLowerCase().trim();
    if (isPg) {
      await pool.query(
        'UPDATE users SET ip_address = NULL WHERE email = $1',
        [userEmail]
      );
    } else if (isMongo) {
      await mongoDb.collection('users').updateOne(
        { email: userEmail },
        { $set: { ip_address: null } }
      );
    } else {
      const users = readCsv(USERS_FILE);
      const user = users.find(u => u.email.toLowerCase() === userEmail);
      if (user) {
        user.ip_address = '';
        const headers = ['email', 'role', 'first_login', 'last_login', 'ip_address'];
        writeCsv(USERS_FILE, headers, users);
      }
    }
  },

  // --- Audit Log Actions ---
  async logAudit(userEmail, ip, action, details) {
    const logRecord = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      user_email: userEmail ? userEmail.toLowerCase().trim() : 'anonymous',
      ip_address: ip || 'unknown',
      action: action,
      details: details || ''
    };

    if (isPg) {
      await pool.query(
        `INSERT INTO audit_logs (id, timestamp, user_email, ip_address, action, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          logRecord.id,
          logRecord.timestamp,
          logRecord.user_email,
          logRecord.ip_address,
          logRecord.action,
          logRecord.details
        ]
      );
    } else if (isMongo) {
      await mongoDb.collection('audit_logs').insertOne(logRecord);
    } else {
      const headers = ['id', 'timestamp', 'user_email', 'ip_address', 'action', 'details'];
      appendToCsv(AUDIT_FILE, headers, logRecord);
    }
    return logRecord;
  },

  async getAuditLogs() {
    if (isPg) {
      const res = await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC');
      return res.rows;
    } else if (isMongo) {
      const records = await mongoDb.collection('audit_logs').find({}).sort({ timestamp: -1 }).toArray();
      return records.map(rec => ({ ...rec, _id: rec._id.toString() }));
    } else {
      return readCsv(AUDIT_FILE);
    }
  }
};

module.exports = db;
