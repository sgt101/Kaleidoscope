# Development Guide

This document is for developers who want to extend or modify the LaTeX Web Editor.

## Project Structure

```
latex-editor/
├── public/
│   ├── index.html          # Main HTML - UI layout
│   ├── styles.css          # Styling - Dark theme (VS Code inspired)
│   └── app.js              # Client-side JavaScript - Editor logic
├── server.js               # Backend - Express server, compilation, Trifle API
├── package.json            # Node.js dependencies
├── Dockerfile              # Docker container definition
├── docker-compose.yml      # Docker Compose configuration
├── README.md               # Full documentation
├── QUICKSTART.md           # Quick setup guide
├── DEVELOPMENT.md          # This file
└── .env.example            # Environment variables template
```

## Architecture Overview

### Frontend (Client-Side)

**File: `index.html`**
- Semantic HTML structure
- Three-pane layout with sidebar
- Chat interface at bottom
- Loads CSS and JavaScript bundles

**File: `styles.css`**
- CSS3 Grid/Flexbox layout
- Dark theme (colors from VS Code)
- Responsive breakpoints
- Custom scrollbars

**File: `app.js`**
- State management with localStorage
- Event handlers for editor actions
- File management (create, read, delete, upload)
- Chat message handling
- API communication with backend

### Backend (Server-Side)

**File: `server.js`**
- Express.js web server
- Static file serving
- `/api/compile` - LaTeX PDF compilation
- `/api/chat` - Trifle AI assistant integration
- Temporary file management for compilation
- Error handling and logging

## Key Technologies

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Frontend | HTML5, CSS3, Vanilla JS | Editor UI and interaction |
| Backend | Node.js, Express | API and file compilation |
| LaTeX | pdflatex | PDF generation from .tex |
| PDF Viewing | PDF.js | Browser PDF rendering |
| AI | Trifle API | Assistant responses |
| Storage | localStorage | Browser file storage |

## Adding Features

### 1. Add a New UI Button

**Example: Syntax highlighting**

In `index.html`:
```html
<button id="syntaxHighlightBtn" class="btn-icon" title="Toggle Syntax Highlighting">✨</button>
```

In `styles.css`:
```css
.syntax-highlight { /* styles */ }
```

In `app.js`:
```javascript
document.getElementById('syntaxHighlightBtn').addEventListener('click', () => {
    document.getElementById('editor').classList.toggle('syntax-highlight');
});
```

### 2. Add a New API Endpoint

In `server.js`:
```javascript
app.post('/api/new-feature', (req, res) => {
    const { data } = req.body;
    try {
        // Process data
        res.json({ result: 'success' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
```

In `app.js`:
```javascript
async function newFeature() {
    const response = await fetch('/api/new-feature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'value' })
    });
    const data = await response.json();
    // Handle response
}
```

### 3. Extend Trifle Integration

In `server.js`, modify `callTrifle()`:
```javascript
async function callTrifle(message, texContent, history) {
    // Customize system prompt
    const systemPrompt = `You are a specialized LaTeX expert...`;
    
    // Add custom tools handling
    const response = await fetch(...);
    
    // Process response
    return response.response;
}
```

### 4. Add Persistent Backend Storage

Replace localStorage with database:

**Install database package:**
```bash
npm install mongoose sqlite3 # or your choice
```

**Modify `app.js`:**
```javascript
// Use /api/files endpoint instead of localStorage
async function saveFile() {
    await fetch('/api/files', {
        method: 'POST',
        body: JSON.stringify({ filename, content })
    });
}
```

**Add in `server.js`:**
```javascript
const db = require('./db'); // your database module

app.post('/api/files', async (req, res) => {
    const { filename, content } = req.body;
    await db.files.create({ filename, content });
    res.json({ success: true });
});
```

## Styling Guide

### Color Palette (Dark Theme)

```css
--bg-primary: #1e1e1e       /* Main background */
--bg-secondary: #252526     /* Secondary background */
--bg-tertiary: #3e3e42      /* Hover background */
--text-primary: #d4d4d4     /* Main text */
--text-secondary: #b4b4b4   /* Dimmed text */
--accent: #0e639c           /* Button accent (blue) */
--accent-hover: #1177bb     /* Button hover */
```

### Adding New Components

```css
.new-component {
    background-color: #252526;
    color: #d4d4d4;
    border: 1px solid #3e3e42;
    padding: 10px;
    border-radius: 3px;
    transition: background-color 0.2s;
}

.new-component:hover {
    background-color: #3e3e42;
}
```

## Testing

### Manual Testing Checklist

- [ ] Create new file
- [ ] Edit and save file
- [ ] Delete file
- [ ] Upload .tex file
- [ ] Compile simple document
- [ ] Compile document with errors
- [ ] Chat with assistant
- [ ] Clear chat
- [ ] Refresh page (data persists)
- [ ] Test on different browsers
- [ ] Test on mobile (responsiveness)

### Automated Testing (To Add)

Create `test/app.test.js`:
```javascript
const assert = require('assert');
const { compileLaTeX } = require('../server');

describe('LaTeX Compilation', () => {
    it('should compile simple document', async () => {
        const pdf = await compileLaTeX('\\documentclass{article}\\begin{document}Test\\end{document}');
        assert(pdf.length > 0);
    });
});
```

Run: `npm test`

## Performance Optimization

### Frontend Optimizations

1. **Debounce auto-save** (already implemented)
   ```javascript
   editor.addEventListener('input', debounce(() => { save(); }, 500));
   ```

2. **Lazy load PDF preview** (currently renders all pages, limit to first 5)

3. **Use Web Workers for heavy computation**
   ```javascript
   const worker = new Worker('worker.js');
   worker.postMessage({ texContent });
   ```

### Backend Optimizations

1. **Cache compilation results**
   ```javascript
   const compilationCache = new Map();
   ```

2. **Limit concurrent compilations**
   ```javascript
   const Queue = require('bull');
   const compilationQueue = new Queue('compilation');
   ```

3. **Optimize pdflatex flags**
   ```bash
   pdflatex -interaction=nonstopmode -halt-on-error -max-print-line=120
   ```

## Security Considerations

### Current Implementation

- Frontend: DOM sanitization via textContent (prevents XSS)
- Backend: Input validation on API endpoints
- File operations: Isolated to temp directories

### Recommendations for Production

1. **Input Validation**
   ```javascript
   const sanitize = require('sanitize-filename');
   const filename = sanitize(req.body.filename);
   ```

2. **Rate Limiting**
   ```bash
   npm install express-rate-limit
   ```
   ```javascript
   const rateLimit = require('express-rate-limit');
   const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
   app.use('/api/', limiter);
   ```

3. **CORS Configuration**
   ```javascript
   app.use(cors({
       origin: 'https://yourdomain.com',
       credentials: true
   }));
   ```

4. **LaTeX Sandboxing**
   - Run pdflatex in restricted environment
   - Use `--shell-escape=no` flag
   - Whitelist allowed packages

## Debugging

### Browser Console Logs

In `app.js`:
```javascript
console.log('Debug:', state);
console.error('Error:', error);
```

Access via F12 > Console

### Server Logs

All console.log/error output appears in terminal:
```bash
npm start
# Watch for: Error messages, API requests, compilation output
```

### Network Inspection

F12 > Network tab shows:
- `/api/compile` requests/responses
- `/api/chat` requests/responses
- File upload progress

### Testing API Endpoints

Using curl:
```bash
# Test compilation
curl -X POST http://localhost:3000/api/compile \
  -H "Content-Type: application/json" \
  -d '{"texContent":"\\documentclass{article}\\begin{document}Hi\\end{document}"}'

# Test chat
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","texContent":""}'
```

## Deployment

### Environment Variables

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
# Edit .env with your settings
```

### Docker Build

```bash
docker build -t latex-editor:latest .
docker run -p 3000:3000 -e TRIFLE_API_KEY=xxx latex-editor:latest
```

### Production Checklist

- [ ] Set NODE_ENV=production
- [ ] Configure Trifle API credentials
- [ ] Set up HTTPS/SSL
- [ ] Configure database backups
- [ ] Set up monitoring/logging
- [ ] Configure rate limiting
- [ ] Set resource limits
- [ ] Test error handling
- [ ] Document deployment steps

## Troubleshooting Development

### Module not found errors

```bash
npm install
npm audit fix
```

### Port 3000 already in use

```bash
# Change in server.js or use different port
PORT=3001 npm start

# Or kill process on port 3000 (Linux/Mac)
lsof -i :3000
kill -9 <PID>
```

### pdflatex command not found

```bash
# Verify LaTeX installation
which pdflatex
pdflatex --version

# Add to PATH if needed (Windows)
# Set PDFLATEX_PATH in .env
```

### Dependencies issues

```bash
# Clear node_modules
rm -rf node_modules package-lock.json
npm install
```

## Contributing

1. Create a feature branch
2. Make changes
3. Test thoroughly
4. Update documentation
5. Submit pull request

---

For questions or issues, refer to README.md or check the code comments!
