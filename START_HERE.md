# 🚀 START HERE - Kaleidoscope

Welcome! You now have a working prototype of a web-based LaTeX editor with AI assistant integration. This file will get you started in 2 minutes.

## ⚡ 60-Second Setup

### Prerequisites (Do These First!)

**Check if you have them:**
```bash
node --version    # Need v14+
npm --version     # Should show version
pdflatex --version  # Need this!
```

**Don't have them?** → Go to INSTALLATION.md → Pick your OS → Follow steps in "Prerequisites Installation"

### Run It!

```bash
# Install dependencies
npm install

# Start server
npm start

# Open browser
# Go to http://localhost:3000
```

**That's it!** You should see the editor. If not → See "Troubleshooting" below.

---

## 🎯 What You Got

```
┌────────────────────────────────────────┐
│         Kaleidoscope               │
├─────────┬──────────────┬───────────────┤
│  Files  │   Editor     │   PDF Preview │
│  Sidebar│   (editable) │   (compiled)  │
├─────────┴──────────────┴───────────────┤
│  💬 Chat with AI Assistant             │
└────────────────────────────────────────┘
```

**3 Panes + Chat Bar:**
1. **Left** - File browser (create, upload, delete files)
2. **Center** - LaTeX editor (type/edit your document)
3. **Right** - PDF preview (see compiled result)
4. **Bottom** - Chat bar (talk to AI about LaTeX)

---

## 📚 Documentation Quick Links

| Document | When to Read |
|----------|--------------|
| **QUICKSTART.md** | You want to use it NOW |
| **README.md** | You want full details |
| **FEATURES.md** | You want to know ALL capabilities |
| **INSTALLATION.md** | Setup is broken/stuck |
| **DEVELOPMENT.md** | You want to customize/extend |
| **PROJECT_SUMMARY.md** | You want project overview |

---

## 🎮 First Time Usage (2 Minutes)

### Step 1: Create a Document
1. Click the **`+`** button in the left sidebar
2. Type a filename like `hello.tex`
3. Click OK

### Step 2: Edit
```latex
\documentclass{article}
\usepackage[utf-8]{inputenc}

\title{Hello World}
\author{You}
\date{}

\begin{document}

\maketitle

\section{Introduction}

This is my first LaTeX document!

\end{document}
```
Paste or type this into the editor.

### Step 3: Compile
1. Click **"Compile PDF"** button
2. Wait 2-3 seconds
3. See your PDF on the right!

### Step 4: Chat with AI
1. Type: `How do I add an image?`
2. Click Send or press Enter
3. Get help from the assistant

**Boom! You're using it.** 🎉

---

## ⚠️ Troubleshooting

### "pdflatex: command not found"
**Problem:** LaTeX not installed or not in PATH

**Solution:**
- **Windows:** Install MiKTeX or TeX Live (see INSTALLATION.md)
- **macOS:** `brew install --cask mactex`
- **Linux:** `sudo apt-get install texlive-latex-extra`
- Restart terminal after installing

### "Cannot find module 'express'"
**Problem:** Dependencies not installed

**Solution:**
```bash
npm install
npm start
```

### "Port 3000 already in use"
**Problem:** Another app using port 3000

**Solution:**
```bash
PORT=3001 npm start
# or
lsof -i :3000  # Find process
kill -9 <PID>  # Kill it
npm start
```

### "Connection refused" or blank page
**Problem:** Server not running

**Solution:**
```bash
# Make sure you ran:
npm start

# You should see:
# "LaTeX Editor running on http://localhost:3000"
```

### Still stuck?
→ See full troubleshooting in **INSTALLATION.md** or **README.md**

---

## 🔧 Optional: Enable Real AI Assistant

By default, the chat uses mock responses. To use **real Trifle AI**:

1. Get your Trifle API key
2. Create a `.env` file:
   ```
   TRIFLE_API_KEY=your-actual-key-here
   TRIFLE_BASE_URL=https://api.trifle.dev
   ```
3. Restart: `npm start`
4. Chat now uses real AI!

(See README.md for more details)

---

## 📁 Project Structure

```
kaleidoscope/
├── index.html          ← Main page (HTML structure)
├── styles.css          ← Styling (look, feel, colors)
├── app.js              ← Editor logic (client-side)
├── server.js           ← Backend (compilation, API)
├── package.json        ← Dependencies
│
├── Dockerfile          ← For Docker deployment
├── docker-compose.yml  ← For Docker Compose
├── .env.example        ← Configuration template
│
└── Documentation:
    ├── README.md       ← Full docs
    ├── QUICKSTART.md   ← Quick start
    ├── INSTALLATION.md ← Setup guide
    ├── DEVELOPMENT.md  ← Developer guide
    ├── FEATURES.md     ← Feature list
    └── PROJECT_SUMMARY.md ← Overview
```

---

## 🚀 What's Next?

### I Just Want to Use It
→ Go to QUICKSTART.md

### I Want Full Documentation
→ Read README.md

### Setup is Broken
→ See INSTALLATION.md troubleshooting section

### I Want to Customize It
→ Read DEVELOPMENT.md

### I Want All Features
→ Check FEATURES.md

### I'm Deploying to Production
→ See INSTALLATION.md → Cloud Deployment section

---

## 💡 Key Features (What You Can Do)

- ✅ **Create, edit, delete LaTeX files** (all in browser)
- ✅ **Upload .tex files** from your computer
- ✅ **Compile to PDF** with one click
- ✅ **Chat with AI** about LaTeX (Trifle integration)
- ✅ **Auto-save** to browser storage
- ✅ **Dark theme** (VS Code style)
- ✅ **Responsive design** (works on tablets)
- ✅ **Error reporting** (shows compilation errors)

---

## 📊 System Requirements

**Minimum:**
- Node.js 14+
- Any modern browser (Chrome, Firefox, Safari, Edge)
- pdflatex (TeX Live or MiKTeX)

**Recommended:**
- Node.js 16+
- Chrome or Firefox
- TeX Live full installation

---

## 🐛 Common Issues

| Issue | Quick Fix |
|-------|-----------|
| No PDF shows | Make sure LaTeX is installed: `pdflatex --version` |
| Can't edit | Click a filename in left sidebar first |
| Chat not working | Check backend is running (see terminal output) |
| File not saving | Check browser storage isn't full |
| Page won't load | Ensure server is running: `npm start` |
| Slow compilation | Large documents take longer (5-10s normal) |

---

## 🔗 Quick Links

- 📖 **Full Docs:** README.md
- ⚡ **Quick Setup:** QUICKSTART.md  
- 🛠️ **Installation Help:** INSTALLATION.md
- 🎨 **Features:** FEATURES.md
- 👨‍💻 **Customization:** DEVELOPMENT.md
- 📊 **Project Info:** PROJECT_SUMMARY.md

---

## ✨ You're All Set!

You have everything you need to:
1. ✅ Use the editor immediately
2. ✅ Create and compile LaTeX documents
3. ✅ Chat with an AI assistant
4. ✅ Customize and extend it
5. ✅ Deploy to production

**Ready?**
```bash
npm start
# Then go to http://localhost:3000
```

**Need help?** Check the documentation files above. Everything is documented!

---

**Happy LaTeX editing!** 🎉

Questions? Check README.md or INSTALLATION.md for detailed answers.
