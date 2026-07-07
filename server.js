require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// Track active SSE admin connections for notifications
const connectedAdmins = new Set();

// Lazy database initialization for serverless / Vercel compatibility
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized) {
    try {
      await db.init();
      dbInitialized = true;
    } catch (err) {
      console.error('Database initialization failed:', err);
      return res.status(500).json({ error: 'Database initialization failed.' });
    }
  }
  next();
});

// Configuration Secrets
const COOKIE_SECRET = process.env.SESSION_SECRET || 'loaneasy-signed-cookie-secret-998811';

// Setup Express middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(COOKIE_SECRET));

// Client IP detection helper
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // Take the first IP from proxy chain
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket.remoteAddress;
}

// Session resolution & Auto-login middleware
async function sessionMiddleware(req, res, next) {
  const ip = getClientIp(req);
  let sessionUser = null;

  // 1. Try to read signed cookie session
  const sessionCookie = req.signedCookies.session;
  if (sessionCookie && sessionCookie.email) {
    try {
      sessionUser = await db.upsertUser(sessionCookie.email, ip);
    } catch (err) {
      console.error('Session cookie validation error:', err);
    }
  }

  // 2. Fallback: Auto-login based on client IP if there is a recent session (within 24 hours)
  if (!sessionUser) {
    try {
      const users = await db.getUsers();
      const ipUser = users.find(u => u.ip_address === ip);
      if (ipUser) {
        const lastLoginTime = new Date(ipUser.last_login).getTime();
        const now = Date.now();
        
        // Auto-login active for 24 hours from last login on same IP
        if (now - lastLoginTime < 24 * 60 * 60 * 1000) {
          sessionUser = ipUser;
          // Renew cookie
          res.cookie('session', { email: ipUser.email, role: ipUser.role }, {
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
            httpOnly: true,
            signed: true,
            sameSite: 'lax'
          });
          await db.logAudit(ipUser.email, ip, 'AUTO_LOGIN_IP', `Auto logged in via IP address matching: ${ip}`);
        }
      }
    } catch (err) {
      console.error('IP-based auto-login failed:', err);
    }
  }

  req.user = sessionUser;
  next();
}

// Statically serve public assets (static web pages, forms, styles)
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTHENTICATION ENDPOINTS ---

// Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const ip = getClientIp(req);

  try {
    const user = await db.upsertUser(email.trim().toLowerCase(), ip);
    
    // Set secure HTTP-only signed session cookie
    res.cookie('session', { email: user.email, role: user.role }, {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      signed: true,
      sameSite: 'lax'
    });

    await db.logAudit(user.email, ip, 'LOGIN', `Logged in via email form.`);
    return res.json({ success: true, user });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Authentication failed.' });
  }
});

// Current User Endpoint
app.get('/api/auth/me', sessionMiddleware, (req, res) => {
  if (req.user) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.json({ authenticated: false });
});

// Logout Endpoint
app.post('/api/auth/logout', sessionMiddleware, async (req, res) => {
  const ip = getClientIp(req);
  if (req.user) {
    try {
      await db.clearUserIp(req.user.email);
    } catch (err) {
      console.error('Error clearing IP on logout:', err);
    }
    await db.logAudit(req.user.email, ip, 'LOGOUT', 'User logged out.');
  }
  res.clearCookie('session');
  return res.json({ success: true });
});

// --- LOAN APPLICATION ENDPOINTS ---

// Create Loan Application
app.post('/api/loans', sessionMiddleware, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized. Please log in first.' });
  }

  const { name, pan, login_date, loan_amt, branch, dsa_name, customer_type, loan_type } = req.body;

  // Validation checks
  if (!name || !pan || !login_date || !loan_amt || !branch || !dsa_name || !customer_type || !loan_type) {
    return res.status(400).json({ error: 'All loan application fields are required.' });
  }

  // PAN Check (Indian Permanent Account Number format: 5 letters, 4 numbers, 1 letter)
  const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i;
  if (!panRegex.test(pan)) {
    return res.status(400).json({ error: 'Invalid PAN format. Must match standard alphanumeric format (e.g. ABCDE1234F).' });
  }

  const amount = Number(loan_amt);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Loan amount must be a positive number.' });
  }

  const allowedLoanTypes = ['Home', 'Home Max', 'Home Takeover', 'Home Suvidha', 'Home Top-up', 'Mortgage'];
  if (!allowedLoanTypes.includes(loan_type)) {
    return res.status(400).json({ error: 'Invalid Loan Type selected.' });
  }

  const ip = getClientIp(req);

  try {
    const loan = await db.saveLoan({
      name,
      pan: pan.toUpperCase(),
      login_date,
      loan_amt: amount,
      branch,
      dsa_name,
      customer_type,
      loan_type,
      logged_by: req.user.email
    });

    await db.logAudit(
      req.user.email,
      ip,
      'SUBMIT_LOAN',
      `Submitted loan application ID ${loan.id} for PAN ${loan.pan} of Amount ₹${loan.loan_amt}`
    );

    // Broadcast notification to connected admins
    const notificationPayload = JSON.stringify({
      message: 'New Loan Applied!',
      details: `${loan.name} has applied for a ₹${loan.loan_amt} ${loan.loan_type} loan.`,
      loan: loan
    });
    for (const client of connectedAdmins) {
      client.write(`data: ${notificationPayload}\n\n`);
    }

    return res.json({ success: true, loan });
  } catch (err) {
    console.error('Error saving loan application:', err);
    return res.status(500).json({ error: 'Failed to save loan application.' });
  }
});

// Retrieve Loan Applications List
app.get('/api/loans', sessionMiddleware, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const allLoans = await db.getLoans();
    // Multi-tenant privacy rule:
    // Admins see all logs, standard connectors only see applications they personally logged.
    if (req.user.role === 'admin') {
      return res.json({ loans: allLoans });
    } else {
      const filteredLoans = allLoans.filter(l => l.logged_by && l.logged_by.toLowerCase() === req.user.email.toLowerCase());
      return res.json({ loans: filteredLoans });
    }
  } catch (err) {
    console.error('Error fetching loans:', err);
    return res.status(500).json({ error: 'Failed to fetch loan applications.' });
  }
});

// --- ADMIN CONTROL CENTRE ROUTING & APIS (HARDENED) ---

// Server-side check before serving admin.html (prevents client bypasses & DevTools bypasses)
app.get('/admin', sessionMiddleware, (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    const ip = getClientIp(req);
    const email = req.user ? req.user.email : 'anonymous';
    db.logAudit(email, ip, 'UNAUTHORIZED_ADMIN_ATTEMPT', 'User attempted to load admin page directly.');
    
    // Serve beautiful custom Forbidden error rather than a plain string
    return res.status(403).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Access Denied - Loan Easy</title>
        <style>
          body {
            background-color: #0c101b;
            color: #e2e8f0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
          }
          .card {
            background: rgba(22, 28, 45, 0.4);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 16px;
            padding: 40px;
            max-width: 440px;
            text-align: center;
            box-shadow: 0 20px 40px rgba(0,0,0,0.4);
            backdrop-filter: blur(12px);
          }
          .icon {
            font-size: 48px;
            color: #ef4444;
            margin-bottom: 20px;
          }
          h1 {
            font-size: 24px;
            margin-bottom: 12px;
            color: #ffffff;
            font-weight: 700;
          }
          p {
            color: #94a3b8;
            font-size: 15px;
            line-height: 1.6;
            margin-bottom: 30px;
          }
          .btn {
            background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%);
            color: #ffffff;
            border: none;
            padding: 12px 28px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            text-decoration: none;
            display: inline-block;
            transition: transform 0.2s, box-shadow 0.2s;
          }
          .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 15px rgba(6, 182, 212, 0.4);
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">🔒</div>
          <h1>Security Lockout</h1>
          <p>Access is restricted to authorized administrative personnel. Your attempts have been logged for safety purposes.</p>
          <a href="/" class="btn">Return to Home Portal</a>
        </div>
      </body>
      </html>
    `);
  }

  // Session verified as Admin. Serve the private file.
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});

// Admin API: Get Users List
app.get('/api/admin/users', sessionMiddleware, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access Denied.' });
  }

  try {
    const users = await db.getUsers();
    return res.json({ users });
  } catch (err) {
    console.error('Error fetching users:', err);
    return res.status(500).json({ error: 'Failed to retrieve users.' });
  }
});

// Admin API: Toggle User Role (Admin Status)
app.post('/api/admin/toggle', sessionMiddleware, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access Denied.' });
  }

  const { email, role } = req.body;
  if (!email || !role || !['admin', 'customer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid toggle parameters.' });
  }

  const ip = getClientIp(req);

  try {
    const result = await db.setUserRole(email, role);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    await db.logAudit(
      req.user.email,
      ip,
      'TOGGLE_ADMIN',
      `Toggled admin role for user ${email.toLowerCase()} to status: ${role.toUpperCase()}`
    );

    return res.json({ success: true, user: result.user });
  } catch (err) {
    console.error('Error toggling user role:', err);
    return res.status(500).json({ error: 'Failed to update user role.' });
  }
});

// Admin API: Retrieve Audit Logs List
app.get('/api/admin/audit-logs', sessionMiddleware, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access Denied.' });
  }

  try {
    const auditLogs = await db.getAuditLogs();
    return res.json({ auditLogs });
  } catch (err) {
    console.error('Error fetching audit logs:', err);
    return res.status(500).json({ error: 'Failed to retrieve audit logs.' });
  }
});

// Admin API: Notification SSE Stream
app.get('/api/admin/notifications/stream', sessionMiddleware, (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access Denied.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  connectedAdmins.add(res);

  req.on('close', () => {
    connectedAdmins.delete(res);
  });
});

// Admin API: Download Active Loan Applications as Multi-Sheet Excel (Monthwise)
app.get('/api/admin/download-excel', sessionMiddleware, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access Denied.' });
  }

  const ip = getClientIp(req);

  try {
    const loans = await db.getLoans();
    const wb = XLSX.utils.book_new();

    const monthGroups = {};
    loans.forEach(loan => {
      let mName = loan.month;
      if (!mName && loan.login_date) {
        const dateObj = new Date(loan.login_date);
        if (!isNaN(dateObj.getTime())) {
          const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
          mName = monthNames[dateObj.getMonth()];
        }
      }
      if (!mName) mName = "Other";

      if (!monthGroups[mName]) {
        monthGroups[mName] = [];
      }
      monthGroups[mName].push(loan);
    });

    if (Object.keys(monthGroups).length === 0) {
      const ws = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, "No Data");
    } else {
      const monthOrder = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const sortedMonths = Object.keys(monthGroups).sort((a, b) => {
        return monthOrder.indexOf(a) - monthOrder.indexOf(b);
      });

      sortedMonths.forEach(mName => {
        const sheetData = monthGroups[mName].map(loan => ({
          'ID': loan.id,
          'Name': loan.name,
          'PAN': loan.pan,
          'Login Date': loan.login_date,
          'Loan Amount': loan.loan_amt,
          'Branch': loan.branch,
          'DSA Name': loan.dsa_name,
          'Customer Type': loan.customer_type,
          'Loan Type': loan.loan_type,
          'Logged By': loan.logged_by,
          'Month': loan.month
        }));
        const ws = XLSX.utils.json_to_sheet(sheetData);
        XLSX.utils.book_append_sheet(wb, ws, mName);
      });
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await db.logAudit(req.user.email, ip, 'DOWNLOAD_EXCEL_LOANS', `Downloaded full loan records Excel file (Total records: ${loans.length})`);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="loan_easy_applications.xlsx"');
    return res.send(buf);
  } catch (err) {
    console.error('Error generating loans Excel:', err);
    return res.status(500).send('Error compiling Excel.');
  }
});

// Admin API: Download Active Loan Applications as CSV
app.get('/api/admin/download-csv', sessionMiddleware, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access Denied.' });
  }

  const ip = getClientIp(req);

  try {
    const loans = await db.getLoans();
    const headers = ['id', 'name', 'pan', 'login_date', 'loan_amt', 'branch', 'dsa_name', 'customer_type', 'loan_type', 'logged_by', 'month'];
    
    let csv = headers.join(',') + '\n';
    loans.forEach(loan => {
      csv += headers.map(header => {
        const val = loan[header];
        if (val === undefined || val === null) return '';
        let str = String(val);
        // Escape characters for CSV format
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
          str = '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }).join(',') + '\n';
    });

    await db.logAudit(req.user.email, ip, 'DOWNLOAD_CSV_LOANS', `Downloaded full loan records CSV file (Total records: ${loans.length})`);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="loan_easy_applications.csv"');
    return res.send(csv);
  } catch (err) {
    console.error('Error generating loans CSV:', err);
    return res.status(500).send('Error compiling CSV.');
  }
});

// Admin API: Download System Audit Logs as CSV
app.get('/api/admin/download-audit-logs', sessionMiddleware, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access Denied.' });
  }

  const ip = getClientIp(req);

  try {
    const logs = await db.getAuditLogs();
    const headers = ['id', 'timestamp', 'user_email', 'ip_address', 'action', 'details'];
    
    let csv = headers.join(',') + '\n';
    logs.forEach(log => {
      csv += headers.map(header => {
        const val = log[header];
        if (val === undefined || val === null) return '';
        let str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
          str = '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }).join(',') + '\n';
    });

    await db.logAudit(req.user.email, ip, 'DOWNLOAD_CSV_AUDIT', `Downloaded system audit logs CSV file (Total records: ${logs.length})`);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="loan_easy_audit_logs.csv"');
    return res.send(csv);
  } catch (err) {
    console.error('Error generating audit logs CSV:', err);
    return res.status(500).send('Error compiling CSV.');
  }
});

// Route everything else to home portal index page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Export app for Vercel serverless environment
module.exports = app;

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  // Initialize database storage structure before launching server locally
  db.init().then(() => {
    app.listen(PORT, () => {
      console.log(`Loan Easy Server running successfully on http://localhost:${PORT}`);
    });
  }).catch(err => {
    console.error('CRITICAL: Server failed to start due to database adapter initialization failure:', err);
  });
}
