# Loan Easy - Premium Banking Portal

Loan Easy is a lightweight, secure, and responsive full-stack banking portal for logging, tracking, and auditing loan applications. 

Designed with premium typography (**Quincy** and **Playfair Display**) and a clean, light cream-accented corporate layout, it supports email-only login, role-based page security (hack-proof server-side gates), persistent sessions, and a flexible database adapter.

---

## Features

- **Email-Only Login**: Seamless login screen. Sessions are tracked via secure signed cookies.
- **Session Persistence (IP + Cookie)**: The backend automatically logs active users in using their client IP if their cookie is missing (within a 24-hour window), ensuring they don't have to repeatedly enter emails.
- **Admin Control Centre**:
  - Located at `/admin` (a route fully guarded on the server side; markup and JS are kept in private directories and never sent to unauthorized browsers).
  - Promotes/demotes other users to/from admin roles.
  - Reviews live audit trails of portal operations.
  - Downloads application records and audit logs as `.csv` files.
- **Multi-Step Loan Wizard**:
  - Captures Applicant Name, PAN, Login Date, Assigned Branch (manual input), Loan Amount, DSA Name, Customer Type (ETB/NTB), and Loan Type.
  - Selectable visual grid cards instead of basic dropdown menus.
  - Strict format verification for Permanent Account Numbers (PAN).
  - Real-time conversion of loan amounts into Indian numbering system words (e.g. "Lakhs", "Crore") for error-free logging.
- **Dual Storage Engine (CSV & SQL)**:
  - **Local Development**: Appends directly to local CSV files under `data/` (`loans.csv`, `users.csv`, `audit_logs.csv`).
  - **Vercel Serverless Production**: Connects to a PostgreSQL database. When users download CSV reports, the server fetches row data and compiles a clean physical CSV file stream dynamically in real-time.

---

## Folder Structure

```
LoanEasy/
├── data/                  # Local CSV database files (Auto-created during local runs)
│   ├── loans.csv
│   ├── users.csv
│   └── audit_logs.csv
├── private/               # Private views (Server-guarded)
│   └── admin.html
├── public/                # Static public portal
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── db.js                  # Database adapter module
├── server.js              # Core backend server (Express)
├── vercel.json            # Vercel deployment configuration
└── package.json           # npm metadata & dependencies
```

---

## Local Setup

### 1. Prerequisite
Ensure you have **Node.js** (v18+) installed.

### 2. Install Dependencies
Run the following command in the project directory:
```bash
npm install
```

### 3. Run Locally (CSV Mode)
Boot the server locally:
```bash
npm start
```
The application will start on `http://localhost:3000`. By default (without environment variables), it will run in **CSV Mode** and create the `./data/` folder to store all records locally.

---

## Vercel Deployment & Database Setup

Since Vercel is a serverless environment with an ephemeral (temporary) and read-only filesystem, local CSV writing will be wiped out when serverless instances reset. To persist data on Vercel, connect a PostgreSQL database.

### 1. Set Up PostgreSQL Database
Set up a free Postgres instance on **Supabase** (supabase.com) or **Neon DB** (neon.tech).

Run the following SQL script in your database SQL Editor to initialize the tables:

```sql
-- 1. Loans Table
CREATE TABLE IF NOT EXISTS loans (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  pan VARCHAR(20) NOT NULL,
  login_date DATE NOT NULL,
  loan_amt NUMERIC NOT NULL,
  branch VARCHAR(255) NOT NULL,
  dsa_name VARCHAR(255) NOT NULL,
  customer_type VARCHAR(10) NOT NULL,
  loan_type VARCHAR(50) NOT NULL,
  logged_by VARCHAR(255) NOT NULL,
  month VARCHAR(50) NOT NULL
);

-- 2. User Accounts Table
CREATE TABLE IF NOT EXISTS users (
  email VARCHAR(255) PRIMARY KEY,
  role VARCHAR(50) DEFAULT 'customer',
  first_login TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(100)
);

-- 3. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(100) PRIMARY KEY,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  user_email VARCHAR(255) NOT NULL,
  ip_address VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL,
  details TEXT
);
```

### 2. Deploy to Vercel
Deploy using the Vercel CLI or connect your Git repository to Vercel. 

In your Vercel Project Settings, add the following Environment Variables:

1. **`DATABASE_URL`**: Your PostgreSQL/Neon connection string (if using Postgres).
   - Example: `postgres://postgres.xxx:password@aws-0-us-east-1.pooler.supabase.com:6543/postgres`
2. **`MONGODB_URI`**: Your MongoDB connection string (if using MongoDB).
   - Example: `mongodb+srv://admin:<password>@cluster0.xxxxx.mongodb.net/loaneasy?retryWrites=true&w=majority`
3. **`SESSION_SECRET`**: A long random string to encrypt signed session cookies.
   - Example: `super-secret-bank-session-signing-token`

The backend database adapter prioritizes `MONGODB_URI` if present. If not found, it checks for `DATABASE_URL` (Postgres/Neon). If neither is defined, it runs in local CSV mode (creating file logs under `./data/`). All CSV downloads compiled via the control panel stream live data from the active database engine.
