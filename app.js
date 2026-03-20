// ── Firebase Config ──
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDpOMSGLIZXm1o0GE13NAe6fctMWC-khRk",
    authDomain: "my-notes-63ce0.firebaseapp.com",
    databaseURL: "https://my-notes-63ce0-default-rtdb.firebaseio.com",
    projectId: "my-notes-63ce0",
    storageBucket: "my-notes-63ce0.firebasestorage.app",
    messagingSenderId: "890920806003",
    appId: "1:890920806003:web:d9bcb77be35a3a9f09ec06"
};

// ── State ──
let results = [];
let uploadedFiles = [];
let parseMode = 'basic';
let firebaseUser = null;
let dataListener = null;
let sortField = 'name';
let sortDir = 'asc';
const pdfBlobUrls = {}; // id -> blob URL for viewing PDFs
const DEFAULT_STATUS_OPTIONS = ['New', 'Reviewing', 'Interview', 'Hired', 'Rejected'];
let statusOptions = [...DEFAULT_STATUS_OPTIONS];
const DEFAULT_COMMS_OPTIONS = ['Not Contacted', 'Email Sent', 'Phone Call', 'Scheduled', 'Follow Up', 'No Response'];
let commsOptions = [...DEFAULT_COMMS_OPTIONS];

// ── PDF.js Setup ──
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ── Utilities ──
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Firebase Helpers ──
function userRef() {
    return firebase.database().ref('users/' + firebaseUser.uid);
}

function saveToFirebase() {
    if (!firebaseUser) return;
    const statusEl = document.getElementById('syncStatus');
    statusEl.textContent = 'Saving...';
    userRef().update({
        resumeparser_results: JSON.stringify(results),
        resumeparser_lastModified: Date.now()
    }).then(() => {
        statusEl.textContent = 'Saved';
        setTimeout(() => { if (statusEl.textContent === 'Saved') statusEl.textContent = ''; }, 3000);
    }).catch(e => {
        console.warn('Save failed:', e);
        statusEl.textContent = 'Save error';
    });
}

function startDataListener() {
    if (dataListener) return;
    const statusEl = document.getElementById('syncStatus');
    statusEl.textContent = 'Loading...';
    dataListener = userRef().on('value', snap => {
        const data = snap.val();
        if (data) {
            try { results = JSON.parse(data.resumeparser_results || '[]'); } catch (e) { results = []; }
            try { indeedResults = JSON.parse(data.resumeparser_indeed || '[]'); } catch (e) { indeedResults = []; }
        } else {
            results = [];
        }
        statusEl.textContent = '';
        renderTable();
        renderIndeedTable();
    });
}

function stopDataListener() {
    if (dataListener && firebaseUser) userRef().off('value', dataListener);
    dataListener = null;
}

// ── Firebase Auth ──
function initFirebase() {
    firebase.initializeApp(FIREBASE_CONFIG);
    firebase.auth().onAuthStateChanged(user => {
        if (user) {
            firebaseUser = user;
            document.getElementById('signInScreen').classList.remove('show');
            document.getElementById('app').style.display = 'flex';
            startDataListener();
        } else {
            stopDataListener();
            firebaseUser = null;
            results = [];
            document.getElementById('app').style.display = 'none';
            showSignInScreen();
        }
    });
}

function showSignInScreen() {
    const screen = document.getElementById('signInScreen');
    const box = document.getElementById('signInBox');
    screen.classList.add('show');
    box.innerHTML = `
        <h2>Resume Parser</h2>
        <p>Sign in to access your data</p>
        <input type="email" id="authEmail" placeholder="Email" autofocus>
        <input type="password" id="authPassword" placeholder="Password">
        <div class="auth-error" id="authError"></div>
        <button onclick="firebaseSignIn()">Sign In</button>
        <button onclick="firebaseSignUp()" style="background:#5cb85c;border-color:#5cb85c;">Create Account</button>
        <button class="auth-secondary" onclick="firebaseForgotPassword()">Forgot password?</button>
    `;
    setTimeout(() => { const el = document.getElementById('authEmail'); if (el) el.focus(); }, 50);
    box.onkeydown = function(e) { if (e.key === 'Enter') firebaseSignIn(); };
}

async function firebaseSignIn() {
    const email = document.getElementById('authEmail').value;
    const pw = document.getElementById('authPassword').value;
    const err = document.getElementById('authError');
    if (!email || !pw) { err.textContent = 'Enter email and password'; return; }
    err.textContent = 'Signing in...';
    try { await firebase.auth().signInWithEmailAndPassword(email, pw); }
    catch (e) { err.textContent = e.message.replace('Firebase: ', '').replace(/\(auth\/[^)]*\)\.?/, '').trim() || 'Sign-in failed'; }
}

async function firebaseSignUp() {
    const email = document.getElementById('authEmail').value;
    const pw = document.getElementById('authPassword').value;
    const err = document.getElementById('authError');
    if (!email) { err.textContent = 'Enter an email address'; return; }
    if (!pw || pw.length < 6) { err.textContent = 'Password must be at least 6 characters'; return; }
    err.textContent = 'Creating account...';
    try { await firebase.auth().createUserWithEmailAndPassword(email, pw); }
    catch (e) { err.textContent = e.message.replace('Firebase: ', '').replace(/\(auth\/[^)]*\)\.?/, '').trim() || 'Sign-up failed'; }
}

async function firebaseForgotPassword() {
    const email = document.getElementById('authEmail').value;
    const err = document.getElementById('authError');
    if (!email) { err.textContent = 'Enter your email address first'; return; }
    try {
        await firebase.auth().sendPasswordResetEmail(email);
        err.style.color = '#5cb85c';
        err.textContent = 'Password reset email sent — check your inbox';
        setTimeout(() => { err.style.color = ''; }, 5000);
    } catch (e) { err.textContent = e.message.replace('Firebase: ', '').replace(/\(auth\/[^)]*\)\.?/, '').trim() || 'Could not send reset email'; }
}

function firebaseSignOut() {
    if (!confirm('Sign out?')) return;
    stopDataListener();
    firebase.auth().signOut();
}

// ── PDF Text Extraction ──
async function extractTextFromPDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        // Group items by Y position to reconstruct lines
        let lastY = null;
        let line = '';
        textContent.items.forEach(item => {
            const y = Math.round(item.transform[5]);
            if (lastY !== null && Math.abs(y - lastY) > 5) {
                fullText += line.trim() + '\n';
                line = '';
            }
            line += item.str + ' ';
            lastY = y;
        });
        if (line.trim()) fullText += line.trim() + '\n';
        fullText += '\n';
    }
    return fullText;
}

// ── Basic / Regex Parser ──
function parseBasic(text, fileName) {
    return {
        id: generateId(),
        fileName,
        name: extractName(text),
        email: extractEmail(text),
        phone: extractPhone(text),
        degrees: extractDegrees(text),
        securityPlus: extractSecurityPlus(text),
        education: extractEducation(text),
        clearance: extractClearance(text),
        certifications: extractCertifications(text),
        parseMode: 'basic',
        parsedAt: Date.now()
    };
}

function extractName(text) {
    // Strategy 1: Look for "Name:" label
    const labelMatch = text.match(/(?:name|full\s*name)\s*[:\-]\s*([^\n,]{2,40})/i);
    if (labelMatch) return labelMatch[1].trim();

    // Strategy 2: Look for name near email (line before or same line)
    const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 1);
    const emailIdx = lines.findIndex(l => /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(l));

    // Strategy 3: First few non-trivial lines (most resumes start with the name)
    const skipWords = /^(resume|curriculum|vitae|cv|page|profile|summary|objective|experience|contact|address|phone|email|tel|www|http)/i;
    const candidates = [];
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        const line = lines[i];
        // Skip lines that look like email, phone, URL, or section headers
        if (/@/.test(line) || /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(line)) continue;
        if (/^https?:\/\//i.test(line) || /^www\./i.test(line)) continue;
        if (/linkedin|github/i.test(line)) continue;
        const clean = line.replace(/[^a-zA-Z\s.\-']/g, '').trim();
        if (clean.length < 3 || clean.length > 50) continue;
        if (!clean.includes(' ')) continue;
        if (skipWords.test(clean)) continue;
        // Looks like a name: 2-4 words, mostly letters
        const words = clean.split(/\s+/);
        if (words.length >= 2 && words.length <= 5 && words.every(w => /^[A-Za-z.\-']+$/.test(w))) {
            candidates.push({ text: clean, idx: i });
        }
    }

    // Prefer candidate near the email line, or the first one
    if (candidates.length > 0) {
        if (emailIdx >= 0) {
            const near = candidates.find(c => Math.abs(c.idx - emailIdx) <= 3);
            if (near) return near.text;
        }
        return candidates[0].text;
    }

    // Strategy 4: Try extracting from filename (e.g. "John_Doe_Resume.pdf")
    return 'Not found';
}

function extractEmail(text) {
    const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    return match ? match[0] : 'Not found';
}

function extractPhone(text) {
    const match = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/);
    return match ? match[0] : 'Not found';
}

function extractDegrees(text) {
    const t = text.toLowerCase();
    const found = [];

    // PhD / Doctorate
    if (/ph\.?d|doctorate|doctor\s+of|d\.?b\.?a|ed\.?d/i.test(text)) {
        found.push('PhD');
    }
    // Masters
    if (/master(?:'?s)?|m\.?s\.?\b|m\.?a\.?\b|m\.?b\.?a\.?\b|mba|m\.?sc\.?|m\.?eng|m\.?ed/i.test(text)) {
        found.push('Masters');
    }
    // Bachelors
    if (/bachelor(?:'?s)?|b\.?s\.?\b|b\.?a\.?\b|b\.?sc\.?|b\.?eng|b\.?b\.?a/i.test(text)) {
        found.push('Bachelors');
    }
    // Associates
    if (/associate(?:'?s)?\s+(?:degree|of|in)/i.test(text) || /\ba\.?a\.?\b|\ba\.?s\.?\b/i.test(text)) {
        found.push('Associates');
    }

    return found.length > 0 ? found.join('; ') : 'None';
}

function extractSecurityPlus(text) {
    return /security\s*\+|comptia\s+security|sec\+/i.test(text) ? 'Yes' : 'No';
}

function extractEducation(text) {
    const degrees = text.match(/(?:Bachelor|Master|Ph\.?D|B\.?S\.?|B\.?A\.?|M\.?S\.?|M\.?A\.?|MBA|Associate|Doctorate|GED|High\s+School\s+Diploma)[^.\n;]{0,120}/gi);
    if (degrees && degrees.length > 0) {
        return [...new Set(degrees.map(d => d.trim()))].join('; ');
    }
    return 'Not found';
}

function extractClearance(text) {
    const matches = text.match(/(?:Top\s+Secret(?:\s*\/\s*SCI)?|TS\s*\/\s*SCI|Secret|Confidential|Public\s+Trust|Q\s+Clearance|L\s+Clearance)(?:\s+Clearance)?/gi);
    if (matches && matches.length > 0) {
        return [...new Set(matches.map(m => m.trim()))].join('; ');
    }
    // Check for labeled patterns
    const labeled = text.match(/(?:security\s+)?clearance\s*[:\-]\s*([^\n]{2,50})/i);
    if (labeled) return labeled[1].trim();
    return 'None found';
}

function extractCertifications(text) {
    const certPatterns = /(?:PMP|CISSP|CISM|CISA|CompTIA\s+\w+|AWS\s+(?:Certified\s+)?\w+|Azure\s+\w+|CCNA|CCNP|CCIE|CEH|ITIL|CPA|PE|Six\s+Sigma|OSCP|Security\+|Network\+|A\+|Cloud\+|CASP\+?|GIAC\s+\w+|Certified\s+\w+\s+\w+|SAFe\s+\w+|Scrum\s+Master|CSM|TOGAF|RHCE|MCSE|MCSA|VCP)/gi;
    const matches = text.match(certPatterns);
    if (matches && matches.length > 0) {
        return [...new Set(matches.map(m => m.trim()))].join('; ');
    }
    return 'None found';
}

// ── AI (Claude) Parser ──
async function parseWithAI(text, fileName) {
    const key = localStorage.getItem('resumeparser_apikey');
    if (!key) {
        alert('Set your Claude API key in Settings first.');
        return null;
    }

    const prompt = `Extract the following fields from this resume text. Return ONLY a JSON object with these exact keys:
{
  "name": "Full Name",
  "email": "email@example.com or Not found",
  "phone": "phone number or Not found",
  "degrees": "highest degree level(s) as: PhD, Masters, Bachelors, Associates, or None — semicolon-separated if multiple",
  "education": "full education details with schools and fields of study, semicolon-separated, or Not found",
  "securityPlus": "Yes or No — whether the candidate has CompTIA Security+ certification",
  "clearance": "security clearance level (e.g. Top Secret/SCI, Secret, Public Trust) or None found",
  "certifications": "all certifications, semicolon-separated, or None found"
}

Resume text:
${text.substring(0, 15000)}`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`API ${response.status}: ${errBody.substring(0, 200)}`);
        }

        const data = await response.json();
        const content = data.content[0].text;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in response');
        const parsed = JSON.parse(jsonMatch[0]);

        return {
            id: generateId(),
            fileName,
            name: parsed.name || 'Not found',
            email: parsed.email || 'Not found',
            phone: parsed.phone || 'Not found',
            degrees: parsed.degrees || 'None found',
            securityPlus: parsed.securityPlus === 'Yes' ? 'Yes' : 'No',
            education: parsed.education || 'Not found',
            clearance: parsed.clearance || 'None found',
            certifications: parsed.certifications || 'None found',
            parseMode: 'ai',
            parsedAt: Date.now()
        };
    } catch (e) {
        console.error('AI parse error:', e);
        return {
            id: generateId(),
            fileName,
            name: 'ERROR: ' + e.message,
            email: '', phone: '', education: '', clearance: '', certifications: '',
            parseMode: 'ai-error',
            parsedAt: Date.now()
        };
    }
}

// ── File Upload ──
document.getElementById('fileInput').addEventListener('change', function(e) {
    uploadedFiles = Array.from(e.target.files);
    if (uploadedFiles.length > 0) {
        parseAll().catch(err => {
            console.error('Parse error:', err);
            alert('Error during parsing: ' + err.message);
            hideProgress();
        });
    }
});

function renderFileList() {
    const panel = document.getElementById('fileListPanel');
    const body = document.getElementById('fileListBody');
    const count = document.getElementById('fileCount');

    if (uploadedFiles.length === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = '';
    count.textContent = uploadedFiles.length + ' file' + (uploadedFiles.length !== 1 ? 's' : '');
    body.innerHTML = uploadedFiles.map((f, i) => {
        const size = f.size < 1024 * 1024
            ? (f.size / 1024).toFixed(1) + ' KB'
            : (f.size / (1024 * 1024)).toFixed(1) + ' MB';
        return `<div class="file-item">
            <span>${escapeHtml(f.name)}</span>
            <span class="file-size">${size}</span>
            <button class="file-remove" onclick="removeFile(${i})" title="Remove">&times;</button>
        </div>`;
    }).join('');
}

function removeFile(index) {
    uploadedFiles.splice(index, 1);
    renderFileList();
}

// ── Parse Orchestration ──
async function parseAll() {
    if (uploadedFiles.length === 0) {
        alert('Upload PDF files first.');
        return;
    }

    const rejectDupes = document.getElementById('cbRejectDupes').checked;
    let filesToParse = uploadedFiles;
    if (rejectDupes) {
        const existing = new Set(results.map(r => r.fileName));
        const seen = new Set();
        filesToParse = filesToParse.filter(f => {
            if (existing.has(f.name) || seen.has(f.name)) return false;
            seen.add(f.name);
            return true;
        });
        if (filesToParse.length === 0) {
            alert('All selected files have already been parsed.');
            return;
        }
    }

    const total = filesToParse.length;
    showProgress(0, total);

    for (let i = 0; i < total; i++) {
        const file = filesToParse[i];
        updateProgress(i, total, file.name);

        try {
            const blobUrl = URL.createObjectURL(file);
            const text = await extractTextFromPDF(file);
            let result;
            if (text.trim().length < 50) {
                result = {
                    id: generateId(), fileName: file.name, pdfUrl: '',
                    name: 'WARNING: PDF may be scanned/image-only',
                    email: '', phone: '', education: '', clearance: '', certifications: '',
                    parseMode: parseMode + '-error', parsedAt: Date.now()
                };
            } else if (parseMode === 'ai') {
                result = await parseWithAI(text, file.name);
                if (!result) { hideProgress(); return; }
            } else {
                result = parseBasic(text, file.name);
            }
            result.pdfUrl = '';
            pdfBlobUrls[result.id] = blobUrl;
            results.push(result);

            // Upload PDF to Firebase Storage in background (don't block)
            if (typeof firebase !== 'undefined' && firebase.storage) {
                const resultId = result.id;
                firebase.storage().ref(`users/${firebaseUser.uid}/resumes/${file.name}`)
                    .put(file).then(snap => snap.ref.getDownloadURL())
                    .then(url => {
                        const r = results.find(x => x.id === resultId);
                        if (r) { r.pdfUrl = url; saveToFirebase(); }
                    }).catch(err => console.warn('Storage upload failed:', err));
            }
        } catch (e) {
            console.error('Error parsing ' + file.name, e);
            results.push({
                id: generateId(), fileName: file.name,
                name: 'ERROR: ' + e.message,
                email: '', phone: '', education: '', clearance: '', certifications: '',
                parseMode: parseMode + '-error', parsedAt: Date.now()
            });
        }

        renderTable();
    }

    hideProgress();
    saveToFirebase();
    uploadedFiles = [];
    document.getElementById('fileInput').value = '';
    renderFileList();
}

// ── Progress Bar ──
function showProgress(current, total) {
    const bar = document.getElementById('progressBar');
    bar.style.display = '';
    updateProgress(current, total, '');
}

function updateProgress(current, total, fileName) {
    const pct = total > 0 ? ((current + 1) / total) * 100 : 0;
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressText').textContent = `${current + 1} / ${total}` + (fileName ? ` — ${fileName}` : '');
}

function hideProgress() {
    document.getElementById('progressBar').style.display = 'none';
}

// ── Table Rendering ──
function renderTable() {
    const container = document.getElementById('viewContainer');
    const sorted = getSortedResults();

    let html = '<div class="results-table-wrapper"><table class="results-table">';
    html += '<thead><tr>';
    html += '<th></th>';
    html += buildSortHeader('Review Status', 'status');
    html += buildSortHeader('Comms Status', 'commsStatus');
    html += buildSortHeader('Name', 'name');
    html += buildSortHeader('Email', 'email');
    html += buildSortHeader('Phone', 'phone');
    html += buildSortHeader('Degrees', 'degrees');
    html += buildSortHeader('Sec+', 'securityPlus');
    html += buildSortHeader('Clearance', 'clearance');
    html += buildSortHeader('Certifications', 'certifications');
    html += '<th>Mode</th><th></th>';
    html += '</tr></thead><tbody>';

    if (sorted.length === 0) {
        html += '<tr class="empty-row"><td colspan="12">No results yet. Upload PDFs and click "Parse Resumes".</td></tr>';
    } else {
        sorted.forEach((r, idx) => {
            const modeClass = 'mode-' + (r.parseMode || 'basic');
            html += `<tr data-row="${idx}">`;
            const hasPdf = !!pdfBlobUrls[r.id] || !!r.pdfUrl;
            html += `<td><div class="cell-inner">${hasPdf ? `<button class="btn-see-resume" onclick="viewResume('${r.id}')">See Resume</button>` : ''}</div></td>`;
            const statusOpts = statusOptions.map(s => `<option value="${escapeHtml(s)}"${(r.status || statusOptions[0]) === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
            html += `<td><div class="cell-inner"><select class="status-select" onchange="updateStatus('${r.id}', this.value)">${statusOpts}</select></div></td>`;
            const commsOpts = commsOptions.map(s => `<option value="${escapeHtml(s)}"${(r.commsStatus || commsOptions[0]) === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
            html += `<td><div class="cell-inner"><select class="status-select" onchange="updateCommsStatus('${r.id}', this.value)">${commsOpts}</select></div></td>`;
            html += `<td><div class="cell-inner">${escapeHtml(r.name)}</div></td>`;
            html += `<td><div class="cell-inner cell-email"><a href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a></div></td>`;
            html += `<td><div class="cell-inner">${escapeHtml(r.phone)}</div></td>`;
            html += `<td><div class="cell-inner">${escapeHtml(r.degrees)}</div></td>`;
            html += `<td><div class="cell-inner">${r.securityPlus === 'Yes' ? '<span style="color:var(--success);font-weight:600;">Yes</span>' : 'No'}</div></td>`;
            html += `<td><div class="cell-inner">${escapeHtml(r.clearance)}</div></td>`;
            html += `<td><div class="cell-inner cell-wrap">${escapeHtml(r.certifications)}</div></td>`;
            html += `<td><div class="cell-inner"><span class="mode-badge ${modeClass}">${escapeHtml(r.parseMode)}</span></div></td>`;
            html += `<td><div class="cell-inner"><button class="btn-icon" onclick="deleteResult('${r.id}')" title="Remove">&#10005;</button></div></td>`;
            html += '</tr>';
            html += `<tr class="row-resizer-tr" data-resize-row="${idx}"><td colspan="12"><div class="row-resizer"></div></td></tr>`;
        });
    }

    html += '</tbody></table></div>';
    container.innerHTML = html;
    initRowResizers();
}

function initRowResizers() {
    document.querySelectorAll('.row-resizer').forEach(handle => {
        handle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            const resizerTr = handle.closest('tr');
            const rowIdx = resizerTr.dataset.resizeRow;
            const dataRow = document.querySelector(`tr[data-row="${rowIdx}"]`);
            if (!dataRow) return;
            const cells = dataRow.querySelectorAll('.cell-inner');
            const startY = e.clientY;
            const startHeights = [...cells].map(c => c.offsetHeight);
            const maxH = Math.max(...startHeights);

            function onMove(ev) {
                const dy = ev.clientY - startY;
                const newH = Math.max(20, maxH + dy);
                cells.forEach(c => { c.style.maxHeight = newH + 'px'; });
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

function startColResize(e, handle) {
    e.stopPropagation();
    e.preventDefault();
    const th = handle.parentElement;
    const startX = e.clientX;
    const startW = th.offsetWidth;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';

    function onMove(ev) {
        const dx = ev.clientX - startX;
        th.style.width = Math.max(40, startW + dx) + 'px';
    }
    function onUp() {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

let viewerCurrentId = null;

function getViewableResults() {
    return getSortedResults().filter(r => !!pdfBlobUrls[r.id] || !!r.pdfUrl);
}

function viewResume(id) {
    viewerCurrentId = id;
    loadViewer(id);
    document.getElementById('pdfViewerOverlay').classList.add('show');
}

function loadViewer(id) {
    const r = results.find(x => x.id === id);
    if (!r) return;
    viewerCurrentId = id;

    let url = pdfBlobUrls[id];
    if (!url && r.pdfUrl) url = r.pdfUrl;
    if (!url) { alert('Resume file no longer available.'); return; }

    document.getElementById('pdfViewerFrame').src = url;
    document.getElementById('viewerName').textContent = r.name || r.fileName;

    // Populate review status dropdown
    const revSel = document.getElementById('viewerReviewStatus');
    revSel.innerHTML = statusOptions.map(s => `<option value="${escapeHtml(s)}"${(r.status || statusOptions[0]) === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');

    // Populate comms status dropdown
    const commsSel = document.getElementById('viewerCommsStatus');
    commsSel.innerHTML = commsOptions.map(s => `<option value="${escapeHtml(s)}"${(r.commsStatus || commsOptions[0]) === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
}

function viewerUpdateStatus(field, value) {
    if (!viewerCurrentId) return;
    const r = results.find(x => x.id === viewerCurrentId);
    if (r) { r[field] = value; saveToFirebase(); renderTable(); }
}

function viewerNav(dir) {
    const viewable = getViewableResults();
    if (viewable.length === 0) return;
    const idx = viewable.findIndex(r => r.id === viewerCurrentId);
    let newIdx = idx + dir;
    if (newIdx < 0) newIdx = viewable.length - 1;
    if (newIdx >= viewable.length) newIdx = 0;
    loadViewer(viewable[newIdx].id);
}

function closePdfViewer() {
    document.getElementById('pdfViewerOverlay').classList.remove('show');
    document.getElementById('pdfViewerFrame').src = '';
    viewerCurrentId = null;
}

function buildSortHeader(label, field) {
    const isActive = sortField === field;
    const arrow = isActive ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : '\u25B2';
    const cls = isActive ? 'active' : '';
    return `<th onclick="toggleSort('${field}')">${label} <span class="sort-arrow ${cls}">${arrow}</span><div class="col-resizer" onmousedown="startColResize(event, this)"></div></th>`;
}

function toggleSort(field) {
    if (sortField === field) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortField = field; sortDir = 'asc'; }
    renderTable();
}

function getSortedResults() {
    const sorted = [...results];
    const dir = sortDir === 'asc' ? 1 : -1;
    sorted.sort((a, b) => {
        const va = (a[sortField] || '').toLowerCase();
        const vb = (b[sortField] || '').toLowerCase();
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
    });
    return sorted;
}

// ── Actions ──
function updateStatus(id, value) {
    const r = results.find(x => x.id === id);
    if (r) { r.status = value; saveToFirebase(); }
}

function updateCommsStatus(id, value) {
    const r = results.find(x => x.id === id);
    if (r) { r.commsStatus = value; saveToFirebase(); }
}

function deleteResult(id) {
    results = results.filter(r => r.id !== id);
    renderTable();
    saveToFirebase();
}

function clearResults() {
    if (results.length === 0) return;
    if (!confirm('Clear all parsed results?')) return;
    results = [];
    renderTable();
    saveToFirebase();
}

function setParseMode(mode) {
    parseMode = mode;
    document.getElementById('btnBasicMode').classList.toggle('active', mode === 'basic');
    document.getElementById('btnAiMode').classList.toggle('active', mode === 'ai');
}

// ── CSV Export ──
function exportCSV() {
    if (results.length === 0) { alert('No results to export.'); return; }
    const headers = ['Review Status', 'Comms Status', 'Name', 'Email', 'Phone', 'Degrees', 'Security+', 'Security Clearance', 'Certifications', 'Parse Mode'];
    const rows = [headers];
    results.forEach(r => {
        rows.push([r.status || statusOptions[0], r.commsStatus || commsOptions[0], r.name || '', r.email || '', r.phone || '',
            r.degrees || '', r.securityPlus || 'No', r.clearance || '', r.certifications || '', r.parseMode || '']);
    });
    let csv = rows.map(row => row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'parsed_resumes.csv'; a.click();
    URL.revokeObjectURL(url);
}

// ── Settings Modal ──
function openSettingsModal() {
    document.getElementById('settingsModalOverlay').classList.add('show');
    document.getElementById('apiKeyInput').value = localStorage.getItem('resumeparser_apikey') || '';
    renderStatusOptionsList();
    renderCommsOptionsList();
}

function closeSettingsModal() {
    document.getElementById('settingsModalOverlay').classList.remove('show');
}

// Generic options list editor
function renderOptionsList(listId, options, type) {
    const list = document.getElementById(listId);
    list.innerHTML = options.map((opt, i) => `
        <div class="status-option-item" draggable="true" data-idx="${i}"
             ondragstart="optDragStart(event, ${i}, '${type}')" ondragover="event.preventDefault()" ondrop="optDrop(event, ${i}, '${type}')" ondragend="optDragEnd(event)">
            <span class="status-drag-handle">&#9776;</span>
            <input type="text" value="${escapeHtml(opt)}" onchange="renameOpt(${i}, this.value, '${type}')">
            <button class="btn-icon" onclick="removeOpt(${i}, '${type}')" title="Remove">&times;</button>
        </div>
    `).join('');
}

function renderStatusOptionsList() { renderOptionsList('statusOptionsList', statusOptions, 'status'); }
function renderCommsOptionsList() { renderOptionsList('commsOptionsList', commsOptions, 'comms'); }

let optDragIdx = null; let optDragType = null;
function optDragStart(e, idx, type) { optDragIdx = idx; optDragType = type; e.dataTransfer.effectAllowed = 'move'; e.target.style.opacity = '0.4'; }
function optDragEnd(e) { e.target.style.opacity = ''; optDragIdx = null; optDragType = null; }
function optDrop(e, targetIdx, type) {
    e.preventDefault();
    if (optDragIdx === null || optDragType !== type || optDragIdx === targetIdx) return;
    const arr = type === 'status' ? statusOptions : commsOptions;
    const [moved] = arr.splice(optDragIdx, 1);
    arr.splice(targetIdx, 0, moved);
    optDragIdx = null;
    saveAllOptions();
    if (type === 'status') renderStatusOptionsList(); else renderCommsOptionsList();
}

function addStatusOption() {
    const input = document.getElementById('newStatusInput');
    const val = input.value.trim();
    if (!val || statusOptions.some(s => s.toLowerCase() === val.toLowerCase())) { input.value = ''; return; }
    statusOptions.push(val); input.value = '';
    saveAllOptions(); renderStatusOptionsList();
}

function addCommsOption() {
    const input = document.getElementById('newCommsInput');
    const val = input.value.trim();
    if (!val || commsOptions.some(s => s.toLowerCase() === val.toLowerCase())) { input.value = ''; return; }
    commsOptions.push(val); input.value = '';
    saveAllOptions(); renderCommsOptionsList();
}

function removeOpt(idx, type) {
    const arr = type === 'status' ? statusOptions : commsOptions;
    if (arr.length <= 1) return;
    arr.splice(idx, 1);
    saveAllOptions();
    if (type === 'status') renderStatusOptionsList(); else renderCommsOptionsList();
}

function renameOpt(idx, val, type) {
    val = val.trim(); if (!val) return;
    const arr = type === 'status' ? statusOptions : commsOptions;
    const field = type === 'status' ? 'status' : 'commsStatus';
    const old = arr[idx]; arr[idx] = val;
    results.forEach(r => { if (r[field] === old) r[field] = val; });
    saveAllOptions(); saveToFirebase(); renderTable();
}

function saveAllOptions() {
    localStorage.setItem('resumeparser_statusoptions', JSON.stringify(statusOptions));
    localStorage.setItem('resumeparser_commsoptions', JSON.stringify(commsOptions));
    renderTable();
}

function saveSettings() {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (key) localStorage.setItem('resumeparser_apikey', key);
    else localStorage.removeItem('resumeparser_apikey');
    closeSettingsModal();
}

// ── Tab Switching ──
let activeTab = 'resumes';

function switchTab(tab) {
    activeTab = tab;
    document.getElementById('tabResumes').classList.toggle('active', tab === 'resumes');
    document.getElementById('tabIndeed').classList.toggle('active', tab === 'indeed');
    document.getElementById('resumesTab').style.display = tab === 'resumes' ? 'flex' : 'none';
    document.getElementById('indeedTab').style.display = tab === 'indeed' ? 'flex' : 'none';
}

// ── Indeed Review ──
let indeedResults = [];
const indeedPdfBlobUrls = {};

function parseIndeedPaste() {
    const text = document.getElementById('indeedPasteText').value.trim();
    if (!text) { alert('Paste candidate data first.'); return; }

    // Split into candidate blocks — each starts with a name in ALL CAPS repeated on two lines
    const blocks = [];
    const lines = text.split('\n').map(l => l.replace(/&nbsp;/g, '').trim());
    let current = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Detect candidate start: a line that is mostly uppercase letters and spaces,
        // followed by same name on next line (Indeed duplicates the name)
        if (line.length > 2 && /^[A-Z\s.\-']+$/.test(line) && lines[i + 1] && lines[i + 1].toUpperCase() === line.toUpperCase()) {
            if (current) blocks.push(current);
            current = { name: toTitleCase(line), lines: [] };
            i++; // skip the duplicate name line
            continue;
        }
        if (current) current.lines.push(line);
    }
    if (current) blocks.push(current);

    if (blocks.length === 0) {
        alert('Could not find any candidates in the pasted text.');
        return;
    }

    const rejectDupes = new Set(indeedResults.map(r => r.name.toLowerCase()));
    let added = 0;

    blocks.forEach(block => {
        if (rejectDupes.has(block.name.toLowerCase())) return;

        const allText = block.lines.join('\n');
        const r = {
            id: generateId(),
            name: block.name,
            location: extractIndeedField(block.lines, 0) || '',
            workExperience: extractIndeedSection(block.lines, 'Relevant Work Experience'),
            education: extractIndeedSection(block.lines, 'Education'),
            certifications: extractIndeedSection(block.lines, 'Licenses and certifications'),
            securityPlus: /security\s*\+|sec\+/i.test(allText) ? 'Yes' : 'No',
            clearance: extractClearance(allText),
            lastUpdated: extractIndeedMeta(block.lines, 'Recently updated'),
            lastActive: extractIndeedMeta(block.lines, 'Active'),
            contacted: extractIndeedMeta(block.lines, 'Contacted'),
            status: statusOptions[0],
            commsStatus: commsOptions[0],
            parsedAt: Date.now()
        };
        indeedResults.push(r);
        added++;
    });

    document.getElementById('indeedPasteText').value = '';
    document.getElementById('indeedPasteArea').style.display = 'none';
    renderIndeedTable();
    saveIndeedToFirebase();
    if (added > 0) console.log(`Added ${added} candidate(s) from Indeed.`);
}

function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function extractIndeedField(lines, offset) {
    // First non-empty line after the name (location)
    for (let i = offset; i < lines.length; i++) {
        const l = lines[i].trim();
        if (l && !/^(Relevant|Education|Licenses|Recently|Active|Contacted)/i.test(l)) return l;
        if (/^(Relevant|Education|Licenses)/i.test(l)) break;
    }
    return '';
}

function extractIndeedSection(lines, header) {
    const items = [];
    let inSection = false;
    for (const line of lines) {
        if (line.toLowerCase().startsWith(header.toLowerCase())) { inSection = true; continue; }
        if (inSection) {
            if (/^(Relevant Work|Education|Licenses and cert|Recently updated|Active|Contacted)/i.test(line)) break;
            if (line && line !== '&nbsp;' && !/^\+\d+ more$/.test(line)) items.push(line);
        }
    }
    return items.join('; ').replace(/\s*;\s*;/g, ';').trim() || 'None';
}

function extractIndeedMeta(lines, prefix) {
    for (const line of lines) {
        if (line.toLowerCase().startsWith(prefix.toLowerCase())) return line;
    }
    return '';
}

async function parseIndeed(files) {
    const rejectDupes = document.getElementById('cbIndeedRejectDupes').checked;
    let filesToParse = files;
    if (rejectDupes) {
        const existing = new Set(indeedResults.map(r => r.fileName));
        const seen = new Set();
        filesToParse = filesToParse.filter(f => {
            if (existing.has(f.name) || seen.has(f.name)) return false;
            seen.add(f.name);
            return true;
        });
        if (filesToParse.length === 0) { alert('All selected files already parsed.'); return; }
    }

    for (const file of filesToParse) {
        try {
            const blobUrl = URL.createObjectURL(file);
            const text = await extractTextFromPDF(file);
            const result = {
                id: generateId(),
                fileName: file.name,
                name: extractName(text),
                email: extractEmail(text),
                phone: extractPhone(text),
                degrees: extractDegrees(text),
                securityPlus: extractSecurityPlus(text),
                clearance: extractClearance(text),
                certifications: extractCertifications(text),
                status: statusOptions[0],
                commsStatus: commsOptions[0],
                parsedAt: Date.now()
            };
            indeedPdfBlobUrls[result.id] = blobUrl;
            indeedResults.push(result);

            if (typeof firebase !== 'undefined' && firebase.storage) {
                const rid = result.id;
                firebase.storage().ref(`users/${firebaseUser.uid}/indeed/${file.name}`)
                    .put(file).then(s => s.ref.getDownloadURL())
                    .then(url => { const r = indeedResults.find(x => x.id === rid); if (r) { r.pdfUrl = url; saveIndeedToFirebase(); } })
                    .catch(err => console.warn('Storage upload failed:', err));
            }
        } catch (e) {
            indeedResults.push({
                id: generateId(), fileName: file.name,
                name: 'ERROR: ' + e.message,
                email: '', phone: '', degrees: '', securityPlus: 'No',
                clearance: '', certifications: '',
                status: statusOptions[0], commsStatus: commsOptions[0],
                parsedAt: Date.now()
            });
        }
        renderIndeedTable();
    }
    saveIndeedToFirebase();
    document.getElementById('indeedFileInput').value = '';
}

function renderIndeedTable() {
    const container = document.getElementById('indeedViewContainer');
    let html = '<table class="results-table">';
    html += '<thead><tr>';
    html += '<th>Review Status</th><th>Comms Status</th>';
    html += '<th>Name</th><th>Location</th><th>Work Experience</th><th>Education</th>';
    html += '<th>Sec+</th><th>Clearance</th><th>Certifications</th>';
    html += '<th>Last Updated</th><th>Last Active</th><th>Contacted</th><th></th>';
    html += '</tr></thead><tbody>';
    if (indeedResults.length === 0) {
        html += '<tr class="empty-row"><td colspan="13">No results yet. Click "Paste from Indeed" to get started.</td></tr>';
    } else {
        indeedResults.forEach(r => {
            const statusOpts = statusOptions.map(s => `<option value="${escapeHtml(s)}"${(r.status || statusOptions[0]) === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
            const commsOpts = commsOptions.map(s => `<option value="${escapeHtml(s)}"${(r.commsStatus || commsOptions[0]) === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
            html += '<tr>';
            html += `<td><select class="status-select" onchange="updateIndeedField('${r.id}','status',this.value)">${statusOpts}</select></td>`;
            html += `<td><select class="status-select" onchange="updateIndeedField('${r.id}','commsStatus',this.value)">${commsOpts}</select></td>`;
            html += `<td><strong>${escapeHtml(r.name)}</strong></td>`;
            html += `<td>${escapeHtml(r.location)}</td>`;
            html += `<td class="cell-wrap">${escapeHtml(r.workExperience)}</td>`;
            html += `<td class="cell-wrap">${escapeHtml(r.education)}</td>`;
            html += `<td>${r.securityPlus === 'Yes' ? '<span style="color:var(--success);font-weight:600;">Yes</span>' : 'No'}</td>`;
            html += `<td>${escapeHtml(r.clearance)}</td>`;
            html += `<td class="cell-wrap">${escapeHtml(r.certifications)}</td>`;
            html += `<td style="font-size:11px;">${escapeHtml(r.lastUpdated)}</td>`;
            html += `<td style="font-size:11px;">${escapeHtml(r.lastActive)}</td>`;
            html += `<td style="font-size:11px;">${escapeHtml(r.contacted)}</td>`;
            html += `<td><button class="btn-icon" onclick="deleteIndeedResult('${r.id}')" title="Remove">&#10005;</button></td>`;
            html += '</tr>';
        });
    }
    html += '</tbody></table>';
    container.innerHTML = html;
}

function updateIndeedField(id, field, value) {
    const r = indeedResults.find(x => x.id === id);
    if (r) { r[field] = value; saveIndeedToFirebase(); }
}

function deleteIndeedResult(id) {
    indeedResults = indeedResults.filter(r => r.id !== id);
    renderIndeedTable();
    saveIndeedToFirebase();
}

function clearIndeedResults() {
    if (indeedResults.length === 0) return;
    if (!confirm('Clear all Indeed results?')) return;
    indeedResults = [];
    renderIndeedTable();
    saveIndeedToFirebase();
}

function viewIndeedResume(id) {
    let url = indeedPdfBlobUrls[id];
    if (!url) { const r = indeedResults.find(x => x.id === id); if (r && r.pdfUrl) url = r.pdfUrl; }
    if (!url) { alert('Resume not available.'); return; }
    document.getElementById('pdfViewerFrame').src = url;
    document.getElementById('viewerName').textContent = (indeedResults.find(x => x.id === id) || {}).name || '';
    document.getElementById('pdfViewerOverlay').classList.add('show');
}

function saveIndeedToFirebase() {
    if (!firebaseUser) return;
    userRef().update({ resumeparser_indeed: JSON.stringify(indeedResults) });
}

function exportIndeedCSV() {
    if (indeedResults.length === 0) { alert('No results to export.'); return; }
    const headers = ['Review Status', 'Comms Status', 'Name', 'Location', 'Work Experience', 'Education', 'Security+', 'Clearance', 'Certifications', 'Last Updated', 'Last Active', 'Contacted'];
    const rows = [headers];
    indeedResults.forEach(r => {
        rows.push([r.status || '', r.commsStatus || '', r.name || '', r.location || '', r.workExperience || '',
            r.education || '', r.securityPlus || 'No', r.clearance || '', r.certifications || '',
            r.lastUpdated || '', r.lastActive || '', r.contacted || '']);
    });
    let csv = rows.map(row => row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'indeed_resumes.csv'; a.click();
    URL.revokeObjectURL(url);
}

// ── Init ──
try { const saved = JSON.parse(localStorage.getItem('resumeparser_statusoptions')); if (saved && saved.length) statusOptions = saved; } catch(e) {}
try { const saved = JSON.parse(localStorage.getItem('resumeparser_commsoptions')); if (saved && saved.length) commsOptions = saved; } catch(e) {}

if (typeof firebase !== 'undefined') {
    initFirebase();
} else {
    // Firebase failed to load (e.g. file:// protocol or offline)
    document.getElementById('signInScreen').classList.add('show');
    document.getElementById('signInBox').innerHTML = `
        <h2>Resume Parser</h2>
        <p style="color:#c44;">Firebase failed to load. Please serve this app from a local HTTP server instead of opening the file directly.</p>
        <p style="font-size:12px;color:#888;margin-top:12px;">Run: <code>python -m http.server 8000</code> in the ResumeParser folder, then open <code>http://localhost:8000</code></p>
    `;
}
