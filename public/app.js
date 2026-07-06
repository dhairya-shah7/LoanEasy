// Disable Browser Developer Tools (F12, right-click, shortcuts)
(function() {
  // Disable right-click context menu
  document.addEventListener('contextmenu', event => event.preventDefault());

  // Disable keyboard shortcuts for DevTools and Source view
  document.addEventListener('keydown', event => {
    if (
      event.key === 'F12' ||
      (event.ctrlKey && event.shiftKey && (event.key === 'I' || event.key === 'i' || event.key === 'J' || event.key === 'j' || event.key === 'C' || event.key === 'c')) ||
      (event.ctrlKey && (event.key === 'U' || event.key === 'u'))
    ) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
  });

  // Detection loop using debugger
  setInterval(() => {
    const startTime = performance.now();
    debugger;
    if (performance.now() - startTime > 100) {
      document.body.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#0c101b;color:#e2e8f0;font-family:sans-serif;text-align:center;padding:20px;"><h1>Developer tools are disabled for security reasons.</h1></div>';
    }
  }, 1000);
})();

// Global State
let currentUser = null;
let currentWizardStep = 1;
let allLoansRecords = [];

// Initialize Page
window.onload = async () => {
  // Set default login date to today's date in local time zone
  const dateInput = document.getElementById('loan-login-date');
  if (dateInput) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    dateInput.value = `${yyyy}-${mm}-${dd}`;
  }

  // Setup live input listeners
  setupInputListeners();

  // Run session check
  await checkSession();
};

// Setup Input Listeners for UX enhancements
function setupInputListeners() {
  const panInput = document.getElementById('loan-pan');
  if (panInput) {
    panInput.addEventListener('input', (e) => {
      // Auto-capitalize PAN
      e.target.value = e.target.value.toUpperCase();
    });
  }

  const amtInput = document.getElementById('loan-amount');
  const amtPreview = document.getElementById('amount-text-preview');
  if (amtInput && amtPreview) {
    amtInput.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      if (!val || val <= 0) {
        amtPreview.textContent = 'Amount in words: -';
      } else {
        amtPreview.textContent = `Amount: ${numberToIndianWords(val)} Rupees Only`;
      }
    });
  }
}

// Session Management
async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();

    if (data.authenticated) {
      currentUser = data.user;
      
      // Update displays
      document.getElementById('user-email-display').textContent = currentUser.email;
      document.getElementById('user-status-container').style.display = 'flex';
      document.getElementById('nav-menu').style.display = 'flex';

      // Admin access validation
      const adminLink = document.getElementById('nav-admin');
      if (currentUser.role === 'admin') {
        adminLink.style.display = 'flex';
      } else {
        adminLink.style.display = 'none';
      }

      // Hide login, show portal dashboard
      document.getElementById('view-login').style.display = 'none';
      switchView('dashboard');
    } else {
      // User is not authenticated -> show login card and strip headers
      currentUser = null;
      document.getElementById('user-status-container').style.display = 'none';
      document.getElementById('nav-menu').style.display = 'none';
      
      // Toggle to login view
      hideAllSections();
      document.getElementById('view-login').style.display = 'block';
    }
  } catch (err) {
    console.error('Session check failed:', err);
    showToast('Failed to connect to authentication services.');
  }
}

// Handle Login Form Submission
async function handleLogin(e) {
  e.preventDefault();
  const emailInput = document.getElementById('login-email');
  const btn = document.getElementById('btn-login-submit');
  const spinner = document.getElementById('login-spinner');

  if (!emailInput.value) return;

  btn.disabled = true;
  spinner.style.display = 'block';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailInput.value })
    });
    const data = await res.json();

    if (res.ok) {
      emailInput.value = '';
      await checkSession();
    } else {
      alert(data.error || 'Authentication failed.');
    }
  } catch (err) {
    console.error('Login request failed:', err);
    alert('Failed to contact login endpoint.');
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
  }
}

// Handle Logout
async function handleLogout() {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (res.ok) {
      await checkSession();
    }
  } catch (err) {
    console.error('Logout request failed:', err);
  }
}

// Dynamic UI Page Switcher
function switchView(viewId) {
  if (!currentUser) {
    hideAllSections();
    document.getElementById('view-login').style.display = 'block';
    return;
  }

  hideAllSections();
  document.getElementById(`view-${viewId}`).style.display = 'block';

  // Toggle nav-link active classes
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.classList.remove('active');
    if (link.id === `nav-${viewId}`) {
      link.classList.add('active');
    }
  });

  // Pull fresh lists on tabs activation
  if (viewId === 'dashboard') {
    loadDashboardStats();
  } else if (viewId === 'records') {
    loadLoansData();
  }
}

function hideAllSections() {
  const sections = ['login', 'dashboard', 'apply', 'records'];
  sections.forEach(sec => {
    const el = document.getElementById(`view-${sec}`);
    if (el) el.style.display = 'none';
  });
}

// Wizard Step Navigation
function nextWizardStep() {
  if (currentWizardStep === 1) {
    // Validate Step 1 Inputs
    const name = document.getElementById('loan-name').value.trim();
    const pan = document.getElementById('loan-pan').value.trim();
    const date = document.getElementById('loan-login-date').value;
    const branch = document.getElementById('loan-branch').value;

    let valid = true;

    // Name Validation
    if (!name) {
      document.getElementById('error-name').textContent = 'Applicant Name is required.';
      valid = false;
    } else {
      document.getElementById('error-name').textContent = '';
    }

    // PAN Validation
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i;
    if (!panRegex) {
      document.getElementById('error-pan').textContent = 'PAN is required.';
      valid = false;
    } else if (!panRegex.test(pan)) {
      document.getElementById('error-pan').textContent = 'Invalid PAN format. Must match standard (e.g. ABCDE1234F).';
      valid = false;
    } else {
      document.getElementById('error-pan').textContent = '';
    }

    // Date Check
    if (!date) {
      document.getElementById('error-login-date').textContent = 'Login Date is required.';
      valid = false;
    } else {
      document.getElementById('error-login-date').textContent = '';
    }

    // Branch Check
    if (!branch) {
      document.getElementById('error-branch').textContent = 'Please assign a branch.';
      valid = false;
    } else {
      document.getElementById('error-branch').textContent = '';
    }

    if (!valid) return;

    // Proceed to Step 2
    currentWizardStep = 2;
    document.getElementById('form-step-1').style.display = 'none';
    document.getElementById('form-step-2').style.display = 'block';
    
    // Update step Indicators
    document.getElementById('step-2-indicator').classList.add('active');
    document.getElementById('step-line-1').classList.add('active');
  }
}

function prevWizardStep() {
  if (currentWizardStep === 2) {
    currentWizardStep = 1;
    document.getElementById('form-step-2').style.display = 'none';
    document.getElementById('form-step-1').style.display = 'block';

    // Remove active styles from step 2 indicator
    document.getElementById('step-2-indicator').classList.remove('active');
    document.getElementById('step-line-1').classList.remove('active');
  }
}

// Select Loan Card Style Handler
function selectLoanCard(radioInput) {
  const cards = document.querySelectorAll('.loan-type-card');
  cards.forEach(card => card.classList.remove('active'));
  radioInput.closest('.loan-type-card').classList.add('active');
}

// Handle Form Submit
async function handleLoanSubmit(e) {
  e.preventDefault();

  const btn = document.getElementById('btn-loan-submit');
  const spinner = document.getElementById('loan-spinner');

  const name = document.getElementById('loan-name').value.trim();
  const pan = document.getElementById('loan-pan').value.trim().toUpperCase();
  const login_date = document.getElementById('loan-login-date').value;
  const branch = document.getElementById('loan-branch').value;
  const loan_amt = document.getElementById('loan-amount').value;
  const dsa_name = document.getElementById('loan-dsa').value.trim();
  const customer_type = document.querySelector('input[name="customer_type"]:checked').value;
  const loan_type = document.querySelector('input[name="loan_type"]:checked').value;

  // Final step 2 validation
  if (!loan_amt || Number(loan_amt) <= 0) {
    document.getElementById('error-amount').textContent = 'Please enter a valid loan amount.';
    return;
  } else {
    document.getElementById('error-amount').textContent = '';
  }

  if (!dsa_name) {
    document.getElementById('error-dsa').textContent = 'Connector/DSA name is required.';
    return;
  } else {
    document.getElementById('error-dsa').textContent = '';
  }

  btn.disabled = true;
  spinner.style.display = 'block';

  try {
    const res = await fetch('/api/loans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        pan,
        login_date,
        branch,
        loan_amt,
        dsa_name,
        customer_type,
        loan_type
      })
    });
    const data = await res.json();

    if (res.ok) {
      // Trigger dynamic success popup modal
      showSuccessModal(data.loan);
      
      // Reset form variables
      resetApplicationForm();
    } else {
      alert(data.error || 'Failed to submit loan details.');
    }
  } catch (err) {
    console.error('Loan submission failed:', err);
    alert('Internal connection failed during submission.');
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
  }
}

// Reset Loan Wizard
function resetApplicationForm() {
  document.getElementById('loan-application-form').reset();
  
  // Set date back to today
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  document.getElementById('loan-login-date').value = `${yyyy}-${mm}-${dd}`;

  // Reset words preview
  document.getElementById('amount-text-preview').textContent = 'Amount in words: -';

  // Toggle wizard styles back to step 1
  currentWizardStep = 1;
  document.getElementById('form-step-2').style.display = 'none';
  document.getElementById('form-step-1').style.display = 'block';
  document.getElementById('step-2-indicator').classList.remove('active');
  document.getElementById('step-line-1').classList.remove('active');
  
  // Clear any errors text
  document.getElementById('error-name').textContent = '';
  document.getElementById('error-pan').textContent = '';
  document.getElementById('error-login-date').textContent = '';
  document.getElementById('error-branch').textContent = '';
  document.getElementById('error-amount').textContent = '';
  document.getElementById('error-dsa').textContent = '';

  // Select defaults
  const firstCardRadio = document.querySelector('.loan-type-cards-grid label input');
  if (firstCardRadio) {
    firstCardRadio.checked = true;
    selectLoanCard(firstCardRadio);
  }
}

// Success Modal Control
function showSuccessModal(loan) {
  const box = document.getElementById('modal-details-box');
  box.innerHTML = `
    <strong>Applicant:</strong> ${escapeHtml(loan.name)}<br>
    <strong>PAN:</strong> ${escapeHtml(loan.pan)}<br>
    <strong>Amount:</strong> ₹${Number(loan.loan_amt).toLocaleString('en-IN')}<br>
    <strong>Type:</strong> ${escapeHtml(loan.loan_type)}<br>
    <strong>Assigned Branch:</strong> ${escapeHtml(loan.branch)}<br>
    <strong>DSA Partner:</strong> ${escapeHtml(loan.dsa_name)} (${escapeHtml(loan.customer_type)})
  `;
  document.getElementById('success-modal').style.display = 'flex';
}

function closeSuccessModal() {
  document.getElementById('success-modal').style.display = 'none';
  switchView('dashboard');
}

// Fetch Loans database and populate grid list
async function loadLoansData() {
  try {
    const res = await fetch('/api/loans');
    const data = await res.json();
    allLoansRecords = data.loans || [];

    filterRecords();
  } catch (err) {
    console.error('Failed to load submissions:', err);
    document.getElementById('loans-table-body').innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; color: #ef4444;">Failed to retrieve record directory.</td>
      </tr>
    `;
  }
}

// Search and Filter Loans records
function filterRecords() {
  const searchQuery = document.getElementById('records-search').value.toLowerCase().trim();
  const typeFilter = document.getElementById('filter-loan-type').value;
  const custFilter = document.getElementById('filter-cust-type').value;

  const filtered = allLoansRecords.filter(loan => {
    // Search checks
    const matchSearch = 
      loan.name.toLowerCase().includes(searchQuery) ||
      loan.pan.toLowerCase().includes(searchQuery) ||
      loan.dsa_name.toLowerCase().includes(searchQuery);

    // Filters check
    const matchType = !typeFilter || loan.loan_type === typeFilter;
    const matchCust = !custFilter || loan.customer_type === custFilter;

    return matchSearch && matchType && matchCust;
  });

  // Render Table
  const tbody = document.getElementById('loans-table-body');
  tbody.innerHTML = '';

  document.getElementById('rows-count-badge').textContent = `${filtered.length} Records Found`;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; color: #64748b;">No loan logs matched the filters.</td>
      </tr>
    `;
    return;
  }

  filtered.forEach(loan => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: 600; color: white;">${escapeHtml(loan.name)}</td>
      <td><code>${escapeHtml(loan.pan)}</code></td>
      <td>${escapeHtml(loan.login_date)}</td>
      <td style="font-weight: 700; color: #38bdf8;">₹${Number(loan.loan_amt).toLocaleString('en-IN')}</td>
      <td>${escapeHtml(loan.branch)}</td>
      <td>${escapeHtml(loan.dsa_name)}</td>
      <td><span class="role-badge" style="background: rgba(255,255,255,0.04); color: #cbd5e1;">${escapeHtml(loan.customer_type)}</span></td>
      <td><span class="role-badge" style="background: rgba(6,182,212,0.1); color: #22d3ee;">${escapeHtml(loan.loan_type)}</span></td>
      <td style="font-size: 0.8rem; color: #64748b;">${escapeHtml(loan.logged_by)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Load stats for Dashboard view
async function loadDashboardStats() {
  try {
    const res = await fetch('/api/loans');
    const data = await res.json();
    const loans = data.loans || [];

    // 1. Core Card values
    const count = loans.length;
    const totalVal = loans.reduce((sum, loan) => sum + Number(loan.loan_amt || 0), 0);
    
    document.getElementById('dash-loan-count').textContent = count;
    document.getElementById('dash-total-value').textContent = '₹' + totalVal.toLocaleString('en-IN');

    // Identify primary branch (most frequent branch)
    let primaryBranch = 'Ahmedabad';
    if (loans.length > 0) {
      const branches = {};
      loans.forEach(l => {
        branches[l.branch] = (branches[l.branch] || 0) + 1;
      });
      primaryBranch = Object.keys(branches).reduce((a, b) => branches[a] > branches[b] ? a : b);
    }
    document.getElementById('dash-top-branch').textContent = primaryBranch;

    // 2. Load Type Distribution Bars
    const typeContainer = document.getElementById('loan-type-bars');
    typeContainer.innerHTML = '';

    const allowedTypes = ['Home', 'Home Max', 'Home Takeover', 'Home Suvidha', 'Home Top-up', 'Mortgage'];
    const typeDistribution = {};
    allowedTypes.forEach(t => typeDistribution[t] = 0);
    
    loans.forEach(loan => {
      if (typeDistribution[loan.loan_type] !== undefined) {
        typeDistribution[loan.loan_type]++;
      }
    });

    if (loans.length === 0) {
      typeContainer.innerHTML = `<p style="color: #64748b; font-size: 0.9rem;">No loan distribution records available yet.</p>`;
    } else {
      allowedTypes.forEach(type => {
        const typeCount = typeDistribution[type];
        const percent = ((typeCount / count) * 100).toFixed(0);

        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML = `
          <div class="bar-row-label">
            <span>${type}</span>
            <span style="color: #06b6d4;">${typeCount} (${percent}%)</span>
          </div>
          <div class="bar-bg">
            <div class="bar-indicator" style="width: ${percent}%;"></div>
          </div>
        `;
        typeContainer.appendChild(row);
      });
    }

    // 3. Customer Classification (ETB vs NTB segments progress bar)
    let etbCount = 0;
    let ntbCount = 0;
    loans.forEach(l => {
      if (l.customer_type === 'ETB') etbCount++;
      if (l.customer_type === 'NTB') ntbCount++;
    });

    const etbBar = document.getElementById('bar-etb');
    const ntbBar = document.getElementById('bar-ntb');

    if (loans.length === 0) {
      etbBar.style.width = '50%';
      etbBar.textContent = 'ETB (0)';
      ntbBar.style.width = '50%';
      ntbBar.textContent = 'NTB (0)';
    } else {
      const etbPercent = ((etbCount / count) * 100).toFixed(0);
      const ntbPercent = ((ntbCount / count) * 100).toFixed(0);

      etbBar.style.width = `${etbPercent}%`;
      etbBar.textContent = etbPercent > 10 ? `ETB: ${etbCount} (${etbPercent}%)` : '';
      
      ntbBar.style.width = `${ntbPercent}%`;
      ntbBar.textContent = ntbPercent > 10 ? `NTB: ${ntbCount} (${ntbPercent}%)` : '';
    }

  } catch (err) {
    console.error('Failed to update stats widgets:', err);
  }
}

// Utility: Convert Number values to Words (Indian Numbering System Format)
function numberToIndianWords(num) {
  if (isNaN(num)) return '';
  
  const a = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'
  ];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function convertLessThanThousand(n) {
    if (n === 0) return '';
    let str = '';
    if (n >= 100) {
      str += a[Math.floor(n / 100)] + ' Hundred ';
      n %= 100;
    }
    if (n >= 20) {
      str += b[Math.floor(n / 10)] + ' ';
      n %= 10;
    }
    if (n > 0) {
      str += a[n] + ' ';
    }
    return str.trim();
  }

  let n = Math.floor(num);
  if (n === 0) return 'Zero';

  let str = '';
  
  // Crores (1,00,00,000)
  if (n >= 10000000) {
    str += convertLessThanThousand(Math.floor(n / 10000000)) + ' Crore ';
    n %= 10000000;
  }
  
  // Lakhs (1,00,000)
  if (n >= 100000) {
    str += convertLessThanThousand(Math.floor(n / 100000)) + ' Lakh ';
    n %= 100000;
  }
  
  // Thousands (1,000)
  if (n >= 1000) {
    str += convertLessThanThousand(Math.floor(n / 1000)) + ' Thousand ';
    n %= 1000;
  }
  
  // Hundreds (100)
  if (n > 0) {
    str += convertLessThanThousand(n);
  }

  return str.trim();
}

// Helper: Escape strings for safe DOM placement
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Helper: Global Toast Alert popup
function showToast(message) {
  const toast = document.getElementById('global-toast');
  if (toast) {
    toast.textContent = message;
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 4000);
  }
}
