# Installation and Setup Guide

Complete installation instructions for the LaTeX Web Editor.

## System Requirements

### Minimum Requirements
- **OS**: Windows, macOS, or Linux
- **Memory**: 512 MB RAM
- **Disk**: 100 MB free space
- **Browser**: Chrome 88+, Firefox 85+, Safari 14+, Edge 88+

### Recommended
- **OS**: Linux (Ubuntu 20.04+) or macOS 10.15+
- **Memory**: 2 GB RAM
- **Node.js**: 16 LTS or later
- **LaTeX**: TeX Live 2022+ or MiKTeX 21+

## Prerequisites Installation

### 1. Install Node.js

**Windows & macOS:**
- Download from [nodejs.org](https://nodejs.org)
- Select LTS version (v18+ recommended)
- Run installer and follow prompts
- Verify: `node --version` and `npm --version`

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Red Hat/CentOS/Fedora:**
```bash
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install nodejs
```

**macOS with Homebrew:**
```bash
brew install node
```

### 2. Install LaTeX Compiler

Choose ONE option based on your OS:

#### Windows

**Option A: MiKTeX (Easier)**
1. Download from [miktex.org](https://miktex.org/download)
2. Run installer
3. Select "Install missing packages on-the-fly"
4. Restart computer
5. Verify: Open Command Prompt, type `pdflatex --version`

**Option B: TeX Live**
1. Download [install-tl-windows.exe](https://tug.org/texlive/acquire-netinstall.html)
2. Run installer with admin privileges
3. Choose "Full installation" for all packages
4. Restart computer
5. Verify: Open Command Prompt, type `pdflatex --version`

#### macOS

**Option A: MacTeX (Full, ~4GB)**
```bash
# Download from https://www.tug.org/mactex/
# Or use Homebrew:
brew install --cask mactex
```

**Option B: BasicTeX + Selected Packages (Minimal, ~100MB)**
```bash
brew install --cask basictex
# Then install needed packages:
sudo tlmgr update --self
sudo tlmgr install amsmath amssymb babel-english
```

After installation:
```bash
# Restart shell
exec zsh
# Verify
pdflatex --version
```

#### Ubuntu/Debian

**Minimal (300MB):**
```bash
sudo apt-get update
sudo apt-get install -y texlive-latex-base texlive-fonts-recommended
```

**Complete (1.5GB):**
```bash
sudo apt-get update
sudo apt-get install -y texlive-full
```

**Verify:**
```bash
pdflatex --version
```

#### Red Hat/CentOS/Fedora

**Minimal:**
```bash
sudo yum install -y texlive-latex texlive-fonts
```

**Complete:**
```bash
sudo yum install -y texlive-latex-extra texlive-fonts-recommended
```

**Verify:**
```bash
pdflatex --version
```

---

## Installation Methods

### Method 1: Direct Installation (Recommended for Development)

**Step 1: Clone or Download**
```bash
# If you have git:
git clone https://github.com/yourusername/latex-editor.git
cd latex-editor

# Or download as ZIP and extract
cd latex-editor
```

**Step 2: Install Dependencies**
```bash
npm install
```

This will download and install:
- express (web framework)
- cors (cross-origin requests)
- Additional development tools

**Step 3: Verify Setup**
```bash
npm test  # If test script exists
node --version  # Check Node.js
pdflatex --version  # Check LaTeX
```

**Step 4: Start Server**
```bash
npm start
```

Expected output:
```
LaTeX Editor running on http://localhost:3000

Configuration:
- TRIFLE_API_KEY: Not set (using mock responses)
- TRIFLE_BASE_URL: https://api.trifle.dev (default)
```

**Step 5: Open Browser**
- Open http://localhost:3000
- You should see the editor interface

---

### Method 2: Docker Installation (Recommended for Deployment)

**Step 1: Install Docker**

**Windows & macOS:**
- Download [Docker Desktop](https://www.docker.com/products/docker-desktop)
- Run installer
- Start Docker Desktop (runs in background)

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose
sudo usermod -aG docker $USER
# Log out and log back in
```

**Verify Installation:**
```bash
docker --version
docker-compose --version
```

**Step 2: Build and Run**

```bash
# Navigate to project directory
cd latex-editor

# Build image
docker build -t latex-editor:latest .

# Run container
docker run -p 3000:3000 -d --name latex-editor latex-editor:latest
```

Or use Docker Compose (simpler):
```bash
docker-compose up -d
```

**Step 3: Verify**
```bash
# Check container is running
docker ps

# View logs
docker logs latex-editor

# Open browser
# http://localhost:3000
```

**Stop Container:**
```bash
docker stop latex-editor
docker rm latex-editor

# Or with Docker Compose:
docker-compose down
```

---

### Method 3: Cloud Deployment (Advanced)

#### Heroku

```bash
# Install Heroku CLI
npm install -g heroku

# Login
heroku login

# Create app
heroku create your-app-name

# Set buildpack for Node.js + LaTeX
heroku buildpacks:add heroku/nodejs
heroku buildpacks:add https://github.com/asexton/heroku-buildpack-latex

# Add Trifle API key (if using)
heroku config:set TRIFLE_API_KEY=your-key

# Deploy
git push heroku main

# View logs
heroku logs --tail
```

#### AWS EC2

```bash
# Launch Ubuntu 20.04 instance
# SSH into instance
ssh -i key.pem ubuntu@your-instance-ip

# Install dependencies
sudo apt-get update
sudo apt-get install -y nodejs npm
sudo apt-get install -y texlive-latex-extra

# Clone and run
git clone https://github.com/yourusername/latex-editor.git
cd latex-editor
npm install
npm start
```

Then configure:
- Security group to allow port 3000
- Elastic IP for consistent address
- SSL certificate (use nginx proxy)

#### DigitalOcean App Platform

1. Connect GitHub repo
2. Create App from Dockerfile
3. Set environment variables
4. Deploy

---

## Post-Installation Configuration

### 1. Configure Trifle API (Optional)

To enable real AI assistant responses:

**Create `.env` file in project root:**
```bash
cp .env.example .env
```

**Edit `.env`:**
```
TRIFLE_API_KEY=your-actual-api-key
TRIFLE_BASE_URL=https://api.trifle.dev
NODE_ENV=development
PORT=3000
```

**Restart server:**
```bash
npm start
```

### 2. Verify All Components

**Test LaTeX compilation:**
1. Open http://localhost:3000
2. Click `+` to create file
3. Name it `test.tex`
4. Paste this content:
```latex
\documentclass{article}
\begin{document}
Hello World!
\end{document}
```
5. Click "Compile PDF"
6. Should see PDF in right panel

**Test chat:**
1. Type "Hello" in chat box
2. Click Send
3. Should get response (mock or real depending on config)

### 3. Performance Tuning

**For Large Documents:**
```bash
# In server.js, increase timeout:
timeout: 60000  # 60 seconds instead of 30
```

**For High Traffic:**
```bash
# Use process manager (production)
npm install -g pm2
pm2 start server.js -i max  # Cluster mode
```

**For Docker:**
```yaml
# docker-compose.yml - add resource limits
services:
  latex-editor:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

---

## Troubleshooting Installation

### "npm: command not found"
- Node.js not installed correctly
- Solution: Reinstall from nodejs.org and restart terminal

### "pdflatex: command not found"
- LaTeX not installed or not in PATH
- Solution:
  ```bash
  # Verify LaTeX installed
  pdflatex --version
  
  # If not found, install:
  # Ubuntu: sudo apt-get install texlive-latex-extra
  # macOS: brew install --cask mactex
  # Windows: Install MiKTeX
  
  # Restart terminal/computer after installing
  ```

### "Cannot find module 'express'"
- Dependencies not installed
- Solution:
  ```bash
  npm install
  ```

### "Port 3000 already in use"
- Another process using the port
- Solution:
  ```bash
  # Use different port
  PORT=3001 npm start
  
  # Or kill process on 3000 (Linux/macOS)
  lsof -i :3000
  kill -9 <PID>
  
  # Windows
  netstat -ano | findstr :3000
  taskkill /PID <PID> /F
  ```

### "Docker build fails"
- Missing Dockerfile or build context
- Solution:
  ```bash
  # Ensure in correct directory
  ls Dockerfile  # Should exist
  
  # Try building again
  docker build -t latex-editor:latest .
  
  # Check Docker daemon running
  docker ps
  ```

### "Compilation timeout"
- Complex document or LaTeX packages
- Solution:
  - Try simpler document first
  - Check LaTeX is working: `pdflatex` in terminal
  - Increase timeout in server.js

### "Browser shows "Cannot GET /"
- Server not running or wrong port
- Solution:
  ```bash
  # Check server running
  ps aux | grep node
  
  # Check correct port
  curl http://localhost:3000
  
  # Restart if needed
  npm start
  ```

---

## Verification Checklist

After installation, verify:

- [ ] Node.js installed: `node --version`
- [ ] npm installed: `npm --version`
- [ ] LaTeX installed: `pdflatex --version`
- [ ] Dependencies installed: `npm install` completed
- [ ] Server starts: `npm start` shows "running on http://localhost:3000"
- [ ] Browser opens: http://localhost:3000 loads the editor
- [ ] Can create file: `+` button works
- [ ] Can edit: Text appears in editor
- [ ] Can compile: PDF appears (or error message shown)
- [ ] Can chat: Message sends and response appears

---

## Next Steps

1. **Read QUICKSTART.md** for first usage
2. **Read README.md** for full documentation
3. **Read DEVELOPMENT.md** if customizing
4. **Configure Trifle** for AI features
5. **Deploy** to production when ready

---

## Getting Help

- **Error in browser?** Check DevTools (F12) > Console
- **Error on server?** Check terminal output
- **Compilation fails?** Try simple test document
- **Chat not working?** Ensure backend is running
- **Still stuck?** Check README.md troubleshooting section

---

## Uninstallation

**Remove Local Installation:**
```bash
rm -rf latex-editor node_modules
# Or just delete the folder in file explorer
```

**Remove Docker Image:**
```bash
docker rmi latex-editor:latest
```

**Uninstall Node.js:**
- Windows: Programs > Programs and Features > Uninstall
- macOS: `brew uninstall node` or run installer "Uninstall" option
- Linux: `sudo apt-get remove nodejs npm`

**Uninstall LaTeX:**
- Windows: MiKTeX/TeX Live > Uninstall (via Programs and Features)
- macOS: `brew uninstall --cask mactex` or `sudo rm -rf /usr/local/texlive`
- Linux: `sudo apt-get remove texlive-*`

---

Happy editing! 🎉
