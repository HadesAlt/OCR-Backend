# Resume OCR Server - Render Deployment

Deploy this OCR server to Render in 5 minutes!

## Step 1: Create GitHub Repository

```bash
cd server
git init
git add .
git commit -m "Initial OCR server for Render"
```

Create a new repo on GitHub and push:
```bash
git remote add origin YOUR_GITHUB_REPO_URL
git branch -M main
git push -u origin main
```

## Step 2: Deploy on Render

1. Go to https://render.com and sign up/login with GitHub
2. Click **"New +"** → **"Web Service"**
3. Click **"Connect GitHub"** and authorize Render
4. Select your repository
5. Configure:
   - **Name:** `resume-ocr-server` (or any name you want)
   - **Region:** Choose closest to your users
   - **Branch:** `main`
   - **Root Directory:** Leave blank (or `server` if this is inside a monorepo)
   - **Environment:** **Docker** ⚠️ IMPORTANT!
   - **Dockerfile Path:** `Dockerfile`
   - **Instance Type:** 
     - **Free** (spins down after 15 mins, cold starts ~30s)
     - **Starter $7/mo** (recommended - always on)
6. Click **"Create Web Service"**

## Step 3: Wait for Build (~5-10 minutes)

Render will:
- ✅ Build Docker image
- ✅ Install Tesseract OCR
- ✅ Install Ghostscript
- ✅ Install Python + ocrmypdf
- ✅ Start your server

You'll see logs like:
```
==> Installing system dependencies...
==> Installing ocrmypdf...
==> Starting server...
OCR server running on port 3001
```

## Step 4: Get Your API URL

After deployment succeeds, you'll get a URL like:
```
https://resume-ocr-server.onrender.com
```

## Step 5: Update Frontend

In your main project (frontend), create `.env` file:

```bash
# .env
VITE_OCR_API_URL=https://resume-ocr-server.onrender.com
```

Then update `src/utils/export.js`:

```javascript
const API_URL = import.meta.env.VITE_OCR_API_URL || 'http://localhost:3001'

// In exportToPDFWithOCR function:
const response = await fetch(`${API_URL}/api/ocr`, {
  method: 'POST',
  body: formData
})
```

## Step 6: Test It!

1. Deploy your frontend to Vercel/Netlify
2. Click "Download PDF"
3. Should see: "Generating PDF..." → "Adding searchable text layer..." → Download!

## Troubleshooting

### Build fails
- Make sure you selected **"Docker"** as environment
- Check Render logs for specific error

### OCR timeout
- Reduce image quality in frontend (scale: 2 instead of 3)
- Upgrade to Starter plan for better performance

### Cold start (Free tier)
- First request takes ~30s after server sleeps
- Add loading message: "Waking up server..."
- Or upgrade to Starter ($7/mo) for always-on

## Render Free Tier Limits

- ✅ 750 hours/month (enough for personal use)
- ⚠️ Spins down after 15 mins inactivity
- ⚠️ Cold start takes 30s
- ✅ Automatic SSL (HTTPS)
- ✅ Custom domain support

## Cost

| Plan | Price | Always On | Performance |
|------|-------|-----------|-------------|
| Free | $0 | ❌ | Good |
| Starter | $7/mo | ✅ | Excellent |

**Recommendation:** Start with Free, upgrade to Starter if you get users.

## Your Deployment is Ready! 🎉

URLs to test:
- Health check: `https://YOUR-URL.onrender.com/health`
- Root: `https://YOUR-URL.onrender.com/`
- OCR: `https://YOUR-URL.onrender.com/api/ocr` (POST)
