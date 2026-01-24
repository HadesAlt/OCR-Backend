FROM node:18-bookworm

# Install ALL system dependencies for OCR in one go
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    ghostscript \
    unpaper \
    pngquant \
    qpdf \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install ocrmypdf
RUN pip3 install ocrmypdf

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p uploads output

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "server.js"]
