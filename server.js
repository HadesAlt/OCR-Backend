'use strict';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3001;
const EXPECTED_AMOUNT = 29;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const DB_PATH = path.join(__dirname, 'licenses.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    licenseKey        TEXT PRIMARY KEY,
    upiRef            TEXT UNIQUE NOT NULL,
    amount            REAL NOT NULL,
    fromName          TEXT,
    vpa               TEXT,
    issuedAt          TEXT NOT NULL,
    deviceFingerprint TEXT,
    activatedAt       TEXT,
    active            INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_upiRef ON licenses(upiRef);
`);

const stmts = {
  insert: db.prepare(`INSERT OR IGNORE INTO licenses (licenseKey, upiRef, amount, fromName, vpa, issuedAt, deviceFingerprint, activatedAt, active) VALUES (@licenseKey, @upiRef, @amount, @fromName, @vpa, @issuedAt, NULL, NULL, 1)`),
  findByRef: db.prepare(`SELECT * FROM licenses WHERE UPPER(upiRef) = UPPER(@upiRef) LIMIT 1`),
  findByKey: db.prepare(`SELECT * FROM licenses WHERE licenseKey = @licenseKey LIMIT 1`),
  activate: db.prepare(`UPDATE licenses SET deviceFingerprint = @fp, activatedAt = @ts WHERE licenseKey = @licenseKey AND deviceFingerprint IS NULL`),
  validate: db.prepare(`SELECT active, deviceFingerprint FROM licenses WHERE licenseKey = @key LIMIT 1`),
};

function generateLicenseKey() {
  const part = () => crypto.randomBytes(4).toString('hex').toUpperCase();
  return `RB-${part()}-${part()}-${part()}`;
}

function log(tag, ...args) {
  console.log(`[${new Date().toISOString()}] [${tag}]`, ...args);
}

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: ['https://resumebuilder-theta-seven.vercel.app', 'http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('output')) fs.mkdirSync('output');

const getLicenseLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many requests. Please wait a few minutes.' } });
const activateLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Too many activation attempts. Try again in an hour.' } });
const validateLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many requests.' } });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many webhook calls.' } });

app.post('/api/payment-webhook', webhookLimiter, (req, res) => {
  log('webhook', 'query =', JSON.stringify(req.query));
  log('webhook', 'body  =', JSON.stringify(req.body));

  if (WEBHOOK_SECRET) {
    const provided = req.query.secret || req.headers['x-webhook-secret'];
    if (!provided || provided !== WEBHOOK_SECRET) {
      log('webhook', 'REJECTED — bad secret');
      return res.status(403).json({ error: 'Forbidden' });
    }
  } else {
    log('webhook', 'WARN: WEBHOOK_SECRET not set');
  }

  const secretVerified = !WEBHOOK_SECRET || (req.query.secret === WEBHOOK_SECRET || req.headers['x-webhook-secret'] === WEBHOOK_SECRET);
  const { referenceNumber, amount, from, vpa } = req.body;
  const ref = (referenceNumber || '').toString().trim();
  const paid = parseFloat(amount) || 0;

  if (!ref) {
    log('webhook', 'Missing referenceNumber');
    return res.status(200).json({ message: 'No reference number' });
  }

  if (!secretVerified && (!Number.isFinite(paid) || paid !== EXPECTED_AMOUNT)) {
    log('webhook', `Unauthenticated call with bad amount ₹${paid} — rejected`);
    return res.status(200).json({ message: 'Incorrect amount' });
  }
  if (secretVerified && paid > 0 && paid !== EXPECTED_AMOUNT) {
    log('webhook', `Amount ₹${paid} !== ₹${EXPECTED_AMOUNT} — rejected`);
    return res.status(200).json({ message: 'Incorrect amount' });
  }

  const licenseKey = generateLicenseKey();
  const info = stmts.insert.run({ licenseKey, upiRef: ref, amount: paid, fromName: from || null, vpa: vpa || null, issuedAt: new Date().toISOString() });

  if (info.changes === 0) {
    log('webhook', 'Duplicate ref:', ref);
    return res.status(200).json({ message: 'Already processed' });
  }

  log('webhook', 'License issued:', licenseKey, '| ref:', ref);
  return res.status(200).json({ success: true, licenseKey });
});

app.post('/api/get-license', getLicenseLimiter, (req, res) => {
  const { upiRef } = req.body;
  log('get-license', 'Lookup:', upiRef);

  if (!upiRef || !upiRef.trim()) {
    return res.status(400).json({ error: 'UPI reference number is required.' });
  }

  const row = stmts.findByRef.get({ upiRef: upiRef.trim() });
  if (!row) {
    log('get-license', 'NOT FOUND:', upiRef.trim());
    return res.status(404).json({ error: 'No license found for this UPI reference. If you just paid, please wait 1–2 minutes and try again.' });
  }

  log('get-license', 'Found:', row.licenseKey, '| activated:', !!row.deviceFingerprint);
  return res.json({ licenseKey: row.licenseKey, alreadyActivated: !!row.deviceFingerprint });
});

app.post('/api/activate-license', activateLimiter, (req, res) => {
  const { licenseKey, fingerprint } = req.body;

  if (!licenseKey || !fingerprint) {
    return res.status(400).json({ error: 'License key and device fingerprint are required.' });
  }

  const key = licenseKey.trim().toUpperCase();
  const row = stmts.findByKey.get({ licenseKey: key });

  if (!row) return res.status(404).json({ error: 'Invalid license key. Please check and try again.' });
  if (!row.active) return res.status(403).json({ error: 'This license has been deactivated.' });

  if (row.deviceFingerprint && row.deviceFingerprint !== fingerprint) {
    log('activate', 'Device mismatch:', key);
    return res.status(403).json({ error: 'This license is already activated on another device. Each license works on only 1 device.' });
  }

  if (row.deviceFingerprint === fingerprint) {
    return res.json({ success: true, message: 'License activated! Welcome to Resume Builder.' });
  }

  const result = stmts.activate.run({ fp: fingerprint, ts: new Date().toISOString(), licenseKey: key });
  if (result.changes === 0) {
    const fresh = stmts.findByKey.get({ licenseKey: key });
    if (fresh.deviceFingerprint !== fingerprint) {
      return res.status(403).json({ error: 'License was just activated on another device.' });
    }
  }

  log('activate', 'Activated:', key);
  return res.json({ success: true, message: 'License activated! Welcome to Resume Builder.' });
});

app.get('/api/validate-license', validateLimiter, (req, res) => {
  const { key, fp } = req.query;
  if (!key || !fp) return res.json({ valid: false, error: 'Missing parameters' });

  const row = stmts.validate.get({ key: key.trim().toUpperCase() });
  if (!row) return res.json({ valid: false, error: 'Invalid license key' });
  if (!row.active) return res.json({ valid: false, error: 'License deactivated' });
  if (!row.deviceFingerprint) return res.json({ valid: false, error: 'License not yet activated' });
  if (row.deviceFingerprint !== fp) return res.json({ valid: false, error: 'Wrong device' });

  return res.json({ valid: true });
});

app.post('/api/ocr', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    const inputPath = req.file.path;
    const outputPath = path.join('output', `ocr_${Date.now()}.pdf`);
    exec(`ocrmypdf --force-ocr "${inputPath}" "${outputPath}"`, { timeout: 120000 }, (error, _stdout, stderr) => {
      try { fs.unlinkSync(inputPath); } catch (_) { }
      if (error) {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) { }
        return res.status(500).json({ error: 'OCR processing failed', details: stderr || error.message });
      }
      res.download(outputPath, 'resume_searchable.pdf', (err) => {
        if (err) log('ocr', 'Download error:', err.message);
        setTimeout(() => { try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) { } }, 5000);
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/', (_req, res) => res.json({
  status: 'ok', message: 'Resume Builder API', storage: 'SQLite',
  endpoints: { webhook: 'POST /api/payment-webhook', getLicense: 'POST /api/get-license', activate: 'POST /api/activate-license', validate: 'GET /api/validate-license?key=&fp=', ocr: 'POST /api/ocr' },
}));

app.listen(PORT, () => log('server', `Running on port ${PORT} | DB: ${DB_PATH}`));
