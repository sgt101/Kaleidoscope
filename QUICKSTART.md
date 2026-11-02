# Quick Start Guide

Get the LaTeX Web Editor running in 5 minutes!

## Option 1: Local Setup (Recommended for Development)

### Step 1: Prerequisites
- **Node.js**: Install from [nodejs.org](https://nodejs.org) (v14+)
- **LaTeX**: Choose one:
  - **Ubuntu/Debian**: `sudo apt-get install texlive-latex-base texlive-latex-extra`
  - **macOS**: `brew install --cask mactex`
  - **Windows**: Download [MiKTeX](https://miktex.org/) or [TeX Live](https://www.tug.org/texlive/)

### Step 2: Install Dependencies
```bash
cd latex-editor
npm install
```

### Step 3: Start the Server
```bash
npm start
```

Open http://localhost:3000 in your browser. That's it!

---

## Option 2: Docker (Recommended for Deployment)

### Step 1: Install Docker
Get Docker from [docker.com](https://docker.com)

### Step 2: Build and Run
```bash
docker-compose up
```

Open http://localhost:3000

---

## Option 3: Docker Hub (No Build Required)

```bash
docker run -p 3000:3000 -e TRIFLE_API_KEY=your-key your-docker-image
```

---

## Using the Editor

### 1️⃣ Create a Document
- Click the **+** button in the left sidebar
- Name it (e.g., `thesis.tex`)
- Start editing!

### 2️⃣ Edit LaTeX
- Type or paste your LaTeX code in the center editor
- Use the default template as a starting point

### 3️⃣ Compile & Preview
- Click **Compile PDF** button
- See the result on the right side
- Errors appear in the preview pane

### 4️⃣ Chat with AI
- Type a question at the bottom (e.g., "How do I make a table?")
- Press Enter or click Send
- The assistant responds based on your document

---

## Common Tasks

### Import an Existing .tex File
1. Click the **↑** button in the sidebar
2. Select your `.tex` file
3. It opens ready to edit

### Delete a File
- Click the **✕** next to a filename

### Clear Chat History
- Refresh the page (stored in browser memory)

### Export Your Files
- Copy-paste from the editor
- Or use "Save As" in your browser

---

## Troubleshooting

**"Can't find pdflatex"**
- Ensure LaTeX is installed: `pdflatex --version`
- On Windows, restart your terminal after installing

**"Compilation fails on startup"**
- Try a simple test document first
- Check LaTeX is working: `pdflatex --help`

**"Chat doesn't work"**
- Make sure backend is running (you should see logs in terminal)
- Check http://localhost:3000/api/chat exists with a test request

**"No PDF shows up"**
- Check browser console (F12) for errors
- Try compiling a simple 3-line LaTeX document

---

## Enabling Trifle AI Assistant

The chat works with mock responses by default. To use real Trifle:

1. Get your Trifle API key
2. Create a `.env` file:
   ```
   TRIFLE_API_KEY=your-api-key-here
   TRIFLE_BASE_URL=https://your-trifle-instance.com
   ```
3. Restart the server: `npm start`
4. Chat will now use real Trifle responses

---

## Configuration

Edit these files to customize:

- **`styles.css`** - Colors, layout, fonts
- **`app.js`** - Editor behavior, defaults
- **`server.js`** - Compilation settings, API
- **`.env`** - API keys, paths, environment

---

## Development Tips

### Auto-reload on Code Changes
```bash
npm run dev
```
(Requires `nodemon`: `npm install -g nodemon`)

### View Server Logs
- Look at terminal output when running `npm start`
- Use browser DevTools (F12) for client-side logs

### Test PDF Compilation
```bash
curl -X POST http://localhost:3000/api/compile \
  -H "Content-Type: application/json" \
  -d '{"texContent":"\\\\documentclass{article}\\\\begin{document}Hello\\\\end{document}"}'
```

---

## Next Steps

1. **Customize styling** in `styles.css`
2. **Configure Trifle** for real AI responses
3. **Deploy** using Docker or your hosting platform
4. **Add features** - syntax highlighting, snippets, templates, etc.

---

## Getting Help

- Check `README.md` for detailed documentation
- Review `server.js` comments for API details
- Check browser console (F12) for errors
- Verify prerequisites are installed correctly

Happy LaTeX editing! 🚀
