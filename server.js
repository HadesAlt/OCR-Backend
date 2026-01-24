const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}
if (!fs.existsSync('output')) {
  fs.mkdirSync('output');
}

app.post('/api/ocr', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const inputPath = req.file.path;
    const outputFilename = `ocr_${Date.now()}.pdf`;
    const outputPath = path.join('output', outputFilename);

    console.log('Processing OCR for:', inputPath);

    const command = `ocrmypdf --force-ocr --deskew --clean --optimize 3 "${inputPath}" "${outputPath}"`;

    exec(command, (error, stdout, stderr) => {
      fs.unlinkSync(inputPath);

      if (error) {
        console.error('OCR Error:', error);
        console.error('stderr:', stderr);
        
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
        
        return res.status(500).json({ 
          error: 'OCR processing failed',
          details: stderr || error.message 
        });
      }

      console.log('OCR Success:', stdout);

      res.download(outputPath, 'resume_searchable.pdf', (err) => {
        if (err) {
          console.error('Download error:', err);
        }
        
        setTimeout(() => {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        }, 5000);
      });
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'OCR server is running' });
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Resume OCR API',
    endpoints: {
      health: '/health',
      ocr: '/api/ocr (POST)'
    }
  });
});

app.listen(PORT, () => {
  console.log(`OCR server running on port ${PORT}`);
});
