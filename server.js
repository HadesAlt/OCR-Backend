const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// ── License config ──────────────────────────────────────────────────────────
const LICENSES_FILE = path.join(__dirname, 'licenses.json');
const EXPECTED_AMOUNT = 29;
const UROPAY_API_KEY = process.env.UROPAY_API_KEY || 'NR86ZTDJ7ZDTX1MW1Z6SR4FIW85GM9YT';

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://resumebuilder-theta-seven.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

// ── File upload setup ────────────────────────────────────────────────────────
const upload = multer({ dest: 'uploads/' });

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('output')) fs.mkdirSync('output');

// ── License helpers ──────────────────────────────────────────────────────────
function readLicenses() {
  if (!fs.existsSync(LICENSES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeLicenses(data) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(data, null, 2));
}

function generateLicenseKey() {
  const part = () => crypto.randomBytes(4).toString('hex').toUpperCase();
  return `RB-${part()}-${part()}-${part()}`;
}

// ────────────────────────────────────────────────────────────────────────────
//  LICENSE ENDPOINTS
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/payment-webhook
 * Called by UroPay when a UPI credit SMS is detected via companion app,
 * or when an order is manually updated.
 *
 * UroPay payload: { amount: "29.00", referenceNumber: "430686551035", from: "...", vpa: "..." }
 * NOTE: No "status" field. No companion app → amount may be "0" or empty.
 */
app.post('/api/payment-webhook', (req, res) => {
  console.log('[webhook] Received payload:', JSON.stringify(req.body));

  // UroPay sends referenceNumber (not payment_reference)
  const { referenceNumber, amount, from, vpa } = req.body;

  const ref = (referenceNumber || '').toString().trim();
  const paid = parseFloat(amount) || 0;

  if (!ref) {
    console.log('[webhook] No referenceNumber — ignoring');
    return res.status(200).json({ message: 'No reference number, ignored' });
  }

  // Accept payment if amount matches OR if no companion app (amount = 0)
  // If amount > 0, it must be >= EXPECTED_AMOUNT
  if (paid > 0 && paid < EXPECTED_AMOUNT) {
    console.warn('[webhook] Incorrect amount:', amount);
    return res.status(200).json({ message: 'Incorrect amount ignored' });
  }

  const licenses = readLicenses();

  // Deduplicate — don't issue two keys for the same payment reference
  const alreadyExists = Object.values(licenses).find(
    l => l.upiRef && l.upiRef.toUpperCase() === ref.toUpperCase()
  );
  if (alreadyExists) {
    console.log('[webhook] Already processed ref:', ref);
    return res.status(200).json({ message: 'Already processed' });
  }

  const licenseKey = generateLicenseKey();
  licenses[licenseKey] = {
    upiRef: ref,
    from: from || null,
    vpa: vpa || null,
    amount: paid,
    issuedAt: new Date().toISOString(),
    deviceFingerprint: null,
    activatedAt: null,
    active: true
  };

  writeLicenses(licenses);
  console.log('[webhook] License key issued:', licenseKey, 'for ref:', ref);

  // Must respond 200 or UroPay marks the call as FAILED
  res.status(200).json({ success: true, licenseKey });
});


/**
 * POST /api/get-license
 * User submits their UPI transaction reference to retrieve their license key.
 * This is the fallback if the webhook hasn't fired yet or user needs to re-enter key.
 */
app.post('/api/get-license', (req, res) => {
  const { upiRef } = req.body;
  if (!upiRef || !upiRef.trim()) {
    return res.status(400).json({ error: 'UPI reference number is required.' });
  }

  const licenses = readLicenses();
  const entry = Object.entries(licenses).find(
    ([, v]) => v.upiRef && v.upiRef.toUpperCase() === upiRef.trim().toUpperCase()
  );

  if (!entry) {
    return res.status(404).json({
      error: 'No license found for this UPI reference. If you just paid, please wait 1–2 minutes and try again.'
    });
  }

  const [licenseKey, data] = entry;
  res.json({
    licenseKey,
    alreadyActivated: !!data.deviceFingerprint
  });
});

/**
 * POST /api/activate-license
 * Binds a device fingerprint to a license key (one-time, irreversible).
 */
app.post('/api/activate-license', (req, res) => {
  const { licenseKey, fingerprint } = req.body;

  if (!licenseKey || !fingerprint) {
    return res.status(400).json({ error: 'License key and device fingerprint are required.' });
  }

  const licenses = readLicenses();
  const entry = licenses[licenseKey.trim().toUpperCase()];

  if (!entry) {
    return res.status(404).json({ error: 'Invalid license key. Please check and try again.' });
  }

  if (!entry.active) {
    return res.status(403).json({ error: 'This license has been deactivated.' });
  }

  // Already activated on a DIFFERENT device → block
  if (entry.deviceFingerprint && entry.deviceFingerprint !== fingerprint) {
    return res.status(403).json({
      error: 'This license is already activated on another device. Each license works on only 1 device.'
    });
  }

  // First activation — bind fingerprint
  if (!entry.deviceFingerprint) {
    entry.deviceFingerprint = fingerprint;
    entry.activatedAt = new Date().toISOString();
    writeLicenses(licenses);
  }

  res.json({ success: true, message: 'License activated! Welcome to Resume Builder.' });
});

/**
 * GET /api/validate-license?key=XXX&fp=YYY
 * Called on every app load to silently verify the stored license.
 */
app.get('/api/validate-license', (req, res) => {
  const { key, fp } = req.query;

  if (!key || !fp) {
    return res.json({ valid: false, error: 'Missing parameters' });
  }

  const licenses = readLicenses();
  const entry = licenses[key.trim().toUpperCase()];

  if (!entry) return res.json({ valid: false, error: 'Invalid license key' });
  if (!entry.active) return res.json({ valid: false, error: 'License deactivated' });
  if (!entry.deviceFingerprint) return res.json({ valid: false, error: 'License not yet activated' });
  if (entry.deviceFingerprint !== fp) return res.json({ valid: false, error: 'Wrong device' });

  res.json({ valid: true });
});

// ────────────────────────────────────────────────────────────────────────────
//  OCR ENDPOINT (existing)
// ────────────────────────────────────────────────────────────────────────────
app.post('/api/ocr', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });

    const inputPath = req.file.path;
    const outputFilename = `ocr_${Date.now()}.pdf`;
    const outputPath = path.join('output', outputFilename);
    const command = `ocrmypdf --force-ocr "${inputPath}" "${outputPath}"`;

    exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
      fs.unlinkSync(inputPath);

      if (error) {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        return res.status(500).json({ error: 'OCR processing failed', details: stderr || error.message });
      }

      res.download(outputPath, 'resume_searchable.pdf', (err) => {
        if (err) console.error('Download error:', err);
        setTimeout(() => { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); }, 5000);
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/', (req, res) => res.json({
  status: 'ok',
  message: 'Resume Builder API',
  endpoints: {
    webhook: 'POST /api/payment-webhook',
    getLicense: 'POST /api/get-license',
    activate: 'POST /api/activate-license',
    validate: 'GET /api/validate-license?key=&fp=',
    ocr: 'POST /api/ocr'
  }
}));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
