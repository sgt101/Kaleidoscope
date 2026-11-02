# LaTeX Web Editor

A modern, web-based LaTeX editor with a clean three-pane interface and a task-oriented AI assistant that talks to model providers directly (a local MLX server, Claude, any OpenAI-compatible API) and proposes edits you accept or reject.

## Features

✅ **File Browser** - Left sidebar for managing LaTeX documents
✅ **Text Editor** - Plain-text LaTeX editor in the center (no syntax highlighting yet)
✅ **PDF Preview** - Preview pane on the right, refreshed when you press Compile
✅ **LaTeX Compilation** - Compile documents to PDF with error reporting
✅ **Assistant** - Fix a compile error, rewrite a selection, explain, or ask; changes arrive as diffs you accept or reject
✅ **Local Storage** - Auto-saves files to browser localStorage
✅ **File Upload** - Import existing LaTeX documents
✅ **Dark Theme** - Professional VS Code-like dark interface

## Architecture

```
┌─────────────────────────────────────────────────┐
│  LaTeX Web Editor                               │
├──────────┬──────────────────────┬───────────────┤
│          │                      │               │
│ File     │   Text Editor        │ PDF Preview   │
│ Browser  │   (textarea)         │ (PDF.js)      │
│          │                      │               │
├──────────┴──────────────────────┴───────────────┤
│  Assistant (model providers, edit diffs)        │
└─────────────────────────────────────────────────┘
```

## Setup

### Prerequisites

- **Node.js** 20.12+ (for the backend server)
- **pdflatex** (for LaTeX compilation)
- **npm** or **yarn**

### Installation

1. **Clone or download the project**

```bash
cd latex-editor
```

2. **Install dependencies**

```bash
npm install
```

3. **Install LaTeX compiler** (if not already installed)

**On Ubuntu/Debian:**
```bash
sudo apt-get install texlive-latex-base texlive-fonts-recommended texlive-latex-extra
```

**On macOS:**
```bash
brew install --cask mactex
# Or use MacTeX full installation
```

**On Windows:**
- Download and install [MiKTeX](https://miktex.org/) or [TeX Live](https://www.tug.org/texlive/)
- Ensure `pdflatex` is in your PATH

### Configuration

#### The assistant

The bar under the editor talks to a model provider. It is task oriented rather than a general agent: the editor decides what the model sees, the model replies with text and edit blocks, and nothing changes in your file until you press **Accept**.

**Providers.** Two wire formats cover most services: OpenAI-compatible chat (MLX `mlx_lm.server`, Ollama, llama.cpp, OpenAI, OpenRouter, ...) and Anthropic Messages (Claude). Without a `providers.json` you get:

- **MLX (local)** at `MLX_URL` (default `http://127.0.0.1:8081/v1`, model `MLX_MODEL`, default `default_model`);
- **Claude** when `ANTHROPIC_API_KEY` is set (model `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`);
- **OpenAI** when `OPENAI_API_KEY` and `OPENAI_MODEL` are set;
- **Trifle** when a Trifle access token is found (see below).

For anything else copy `providers.example.json` to `providers.json` (or point `PROVIDERS_FILE` at a file): a list of `{ id, label, kind, url, model, keyEnv, contextChars, maxTokens, temperature, timeoutSeconds }`, where `kind` is `openai`, `anthropic` or `trifle`. A key is never written in the file: `keyEnv` names the environment variable that holds it, and the key stays on the server, never in the browser. The provider menu above the chat shows which are ready (a local server is probed; a hosted one needs its key). The line beside it says where your text goes: a local provider keeps the open file on your machine, a hosted one **sends the open file to that service**, so pick accordingly.

**Choosing the model.** The box beside the provider menu is the model that answers. Its drop-down lists what the provider reports (`/models`): for MLX, the models in your Hugging Face cache; for Claude, OpenAI and OpenRouter, their catalogues. You can also type any name. An `mlx_lm.server` loads the model a request names, so typing a Hugging Face repo such as `mlx-community/Qwen3-8B-4bit` switches to it; the first question after a switch waits while it loads (if that takes over two minutes, raise `timeoutSeconds`). The choice is remembered per provider in your browser; clear the box to go back to the provider's configured model (`MLX_MODEL`, or `model` in `providers.json`). The provider's `model` is only the default.

**Tasks.** The buttons above the chat start a task with its own instructions and context; typing in the box asks a free question about the file.

| Task | What it does |
|---|---|
| **Fix error** | enabled after a failed compile; the model gets the error and the source around each `l.N` line, and proposes the smallest fix, or says the cause is elsewhere |
| **Rewrite selection** | select text, say in the box how to change it, press the button; one change replaces exactly the selection |
| **Explain** | explains the selection, or the compile error, or the document; never proposes edits |
| (ask) | any question; changes are proposed only if you ask for one |

**What the model sees.** Always the same, built by the editor: the file name; the document with line numbers (so `l.113` in a log points at a real line); your selection with its line range; and, for Fix error, the compile error. A document too large for the provider's `contextChars` (default 32000) is cut down to the preamble, the neighbourhood of the selection, cursor and error lines, and an outline, with the gaps marked. The last eight messages of the conversation go along; nothing else from your machine does.

**Edits.** The model proposes changes as search/replace blocks. Each becomes a card showing the lines removed and added, with **Accept** and **Reject** (and **Accept all** for several). A block applies only where its text occurs exactly once in the file; if a block does not fit, the model is told once and asks again, and a block that still does not fit is shown as not applicable. Accepting changes the editor's text only, through the text field's own undo stack (Ctrl/Cmd+Z undoes it); it is saved to disk only when you press Save. The assistant edits the open file and no other. Because it cannot run commands or write files, a hostile document that says "ignore your instructions" can at worst produce a change you reject.

**Streaming and Stop.** Answers stream in; **Stop** cancels the request to the model. A model that goes silent for two minutes (`timeoutSeconds` to change it) is given up on. Models that print their reasoning as `<think>...</think>` have it hidden.

**In the container**, `./run_contained.sh` reaches your MLX server and other local services as `host.docker.internal` (`localhost` in `MLX_URL` and `providers.json` is rewritten for you), mounts `providers.json` read-only and passes each key it needs by name (`-e NAME`, so it never appears in `ps`). Make sure the model server listens where Docker can reach it; `mlx_lm.server --host 127.0.0.1` works with Docker Desktop on macOS.

**Trifle** is still available as one provider. It is used when a token is found (`TRIFLE_TOKEN`, `TRIFLE_TOKEN_FILE`, or `~/.config/trifle/token`) at `TRIFLE_URL` (default `http://127.0.0.1:8792`, then `:8787`). It has its own model and tools, takes the whole prompt as one message with no streaming, and its conversation lives in Trifle's session. From the container its bridge must accept the name `host.docker.internal` (`--allow-host host.docker.internal`). A failure (token rejected, not reachable, too slow after `TRIFLE_TIMEOUT_MS`) is shown as one.

#### Security defaults

- The server listens on `127.0.0.1` only (`HOST` to change) and serves just the `public/` folder.
- API requests must be same-origin and use a `localhost`/`127.0.0.1` Host header (`ALLOWED_HOSTS` to add names). No CORS headers are sent.
- `pdflatex` runs with `-no-shell-escape` and TeX file access limited to the temporary build folder.
- This is still a single-user local tool: there is no authentication.

## Running

### Development

With auto-reload on file changes:

```bash
npm run dev
```

### Production

```bash
npm start
```

The editor will be available at `http://localhost:3000`

### In a container (recommended for documents you did not write)

```bash
./run_contained.sh                     # workspace ./documents, at http://localhost:3000
./run_contained.sh --work ~/papers     # another workspace folder
./run_contained.sh --detach            # background; stop with ./run_contained.sh --stop
```

The script builds the image (TeX Live is large: the first build takes several minutes) and starts it. Everything, including the TeX engines, runs in Docker. The container sees only the workspace folder and a private font-cache volume; its root filesystem is read-only, it has no Linux capabilities, runs as a non-root user with memory/CPU/process limits, and publishes the page on `127.0.0.1` only. A document compiled there, even a LuaLaTeX one, cannot read your home folder. Only the assistant's settings (model URLs, the API keys your providers name, the Trifle token) and `ALLOWED_HOSTS` are passed in (from the environment or `.env`), and the TeX programs never see them. Other options: `--port N`, `--rebuild` (fresh image), `--help`. Needs Docker Desktop (macOS) or Docker.

## Usage

### Opening and Editing Files

1. **Open from disk**: Click the 📂 button to browse the workspace folder (`WORKSPACE_DIR`, default `./documents`). Click folders to enter them (or use the breadcrumbs), click a `.tex`/`.bib`/`.sty`/`.cls`/`.bst`/`.txt`/`.md` file to open it. Arrow keys move through the list; images and other non-text files are greyed out. You can also create a file in the folder you are looking at.
2. **Save**: Files opened from disk show a ● when changed. Save with the Save button or Ctrl/Cmd+S. Nothing is written to disk until you save. For a browser-storage file, Save opens the folder browser so you can pick a folder and name in the workspace; the file then lives on disk.
3. **Browser-storage files**: `+` creates a scratch file and `↑` imports one from your computer. These live in your browser only (Save moves them into the workspace).
4. **Close or delete**: `✕` closes a file opened from disk (the file on disk is kept) and deletes a browser-storage file.

The browser can only reach files inside the workspace folder. Paths that leave it (`..`, absolute paths, symlinks that point outside) and hidden files are refused.

### Layout and zoom

- **Resize panes:** drag the bars between the file list, editor and preview, and the bar above the chat. Double-click a bar to reset it. With a bar focused, the arrow keys nudge it (Shift for bigger steps) and Home resets it. Sizes are remembered in your browser.
- **Editor text size:** `A−` / `A+` in the editor header, or Ctrl/Cmd + `-` / `=` / `0` (or Ctrl + scroll) while typing. The text size shown resets to 13px when clicked.
- **Preview zoom:** `−` / `+` in the preview header, or Ctrl + scroll (or trackpad pinch) over the preview. 100% fits the page to the pane width and follows the pane as you resize it; click the percentage to return to it. The PDF is redrawn at the new size, so it stays sharp.

### Compiling

- **Engine:** the Engine menu in the editor header chooses pdfLaTeX, LuaLaTeX or XeLaTeX. **Auto** (the default) follows a `% !TEX program = lualatex` comment near the top of the main file (as written by TeXShop, TeXworks and VS Code), and otherwise picks LuaLaTeX for documents that use `\directlua`, `luacode`, `fontspec`, `unicode-math` or `polyglossia`, and pdfLaTeX for everything else. The preview says which engine was used. Your choice is remembered.
- **First LuaLaTeX/XeLaTeX run:** these build a font cache the first time, which can take a minute. Their time limit is 120 s per pass (pdfLaTeX: 30 s); if a first run times out, try again.
- **Security:** `-no-shell-escape` stops documents running programs, and TeX's file access is limited to the build folder. LuaTeX is the exception for reading: Lua code in a document (`\directlua`) can still read any file your user account can, and write to nothing outside the build folder. Compile only documents you trust, or run the editor in Docker.

- **A file opened from disk** is compiled together with the rest of its folder, so `\input`, `\includegraphics` and `.bib` files resolve. The server copies the folder (text, style, image and data files; subfolders included) to a scratch directory, so your folder gets no `.aux`/`.log` clutter. Unsaved edits in other open files of that folder are included, so the PDF matches what you see.
- Passes run until references settle (at most 5): `pdflatex`, then `bibtex` (for `\bibliography`) or `biber` (for `biblatex`) when needed, then `pdflatex` again. If the bibliography tool is not installed, the PDF still builds and the preview says citations are unresolved.
- Compile the **main** file. A file with no `\documentclass` (for example one that is `\input` from elsewhere) is refused with an explanation.
- Folders larger than 3000 files or 100 MB are refused; hidden files and other file types are not copied. Documents cannot read files outside their own folder.
- **Browser-storage files** have no folder, so they compile on their own as before.
- Set `PDFLATEX_PATH`, `BIBTEX_PATH` or `BIBER_PATH` if the tools are not on `PATH`.

### Compiling Documents

1. Click the **"Compile PDF"** button in the editor header
2. The PDF preview will display on the right side
3. Any compilation errors will be shown in the preview pane

### Assistant

1. Pick a provider above the chat (the line next to it says whether the file stays on your machine).
2. **Fix error** after a failed compile; **Rewrite selection** (select, type the instruction, press); **Explain**; or just type a question and press **Enter**.
3. Read the diff on each suggested change, then **Accept** or **Reject**. Accepting edits the editor text only; Ctrl/Cmd+Z undoes it and Save writes it.

See "The assistant" above for providers and what the model is shown.

### Browser Storage

- All files are automatically saved to browser localStorage
- Chat history is preserved across sessions
- Files persist even after closing the browser

## API Endpoints

### POST `/api/compile`

Compile LaTeX to PDF.

**Request:**
```json
{
  "texContent": "\\documentclass{article}..."
}
```

**Response:**
- Binary PDF data (Content-Type: application/pdf)
- Or error JSON

### GET `/api/assistant`

The configured providers and whether each is ready: `{ providers: [{ id, label, kind, model, models, local, host, ready, detail }], default }`, where `model` is the configured default and `models` the names the provider offers (empty when it cannot say).

### POST `/api/chat`

Ask the assistant about the open file. The reply is a stream of newline-delimited JSON.

**Request:**
```json
{
  "provider": "mlx",
  "model": "mlx-community/Qwen3-8B-4bit",
  "task": "ask",
  "message": "Make the abstract shorter",
  "history": [{ "role": "user", "content": "..." }],
  "texContent": "\\documentclass{article}...",
  "fileName": "main.tex",
  "selStart": 0, "selEnd": 0, "cursor": 0,
  "compileError": ""
}
```
`task` is `ask`, `fix`, `rewrite` or `explain`. `model` is optional and replaces the provider's configured model for this question.

**Response:** lines of `{"type":"text","text":"..."}` as the answer arrives, `{"type":"reset","text":"..."}` when it is replaced, `{"type":"retry","reason":"..."}` when an edit did not fit and the model is asked again, then `{"type":"done","text":"...","truncated":false,"failures":[]}` or `{"type":"error","message":"..."}`. One question is answered at a time (HTTP 409 otherwise); closing the connection cancels it.

## Customization

### Styling

Edit `styles.css` to customize:
- Color scheme (dark theme by default)
- Layout proportions
- Font sizes and families
- Sidebar/preview/chat dimensions

### Editor Settings

In `app.js`, modify:
- Default LaTeX template in `createNewFile()`
- Auto-save debounce delay
- Chat history limit
- File storage

### Assistant

- `assistant.js`: the task prompts and the context the model is shown (`TASK_PROMPTS`, `buildUserMessage`, `documentView`), and the retry for edits that do not fit.
- `providers.js`: provider loading and the two wire formats (`complete`).
- `public/edits.js`: the edit-block format, shared by the server (to check a proposal) and the browser (to show and apply it).

## Troubleshooting

### LaTeX Compilation Fails

**"pdflatex not found"**
- Ensure pdflatex is installed and in PATH
- On Windows, add TeX Live bin directory to PATH
- Restart the server after installing LaTeX

**"Timeout" or slow compilation**
- Large documents or complex packages may take time
- Increase `COMPILE_TIMEOUT_MS` in `server.js`

### Files Not Persisting

- Check browser localStorage is enabled
- Try clearing browser cache if corrupted
- Export files manually if needed

### Chat Not Working

- Ensure backend server is running (`npm start`)
- Check browser console for network errors
- The provider menu marks a provider "(not ready)" and the line beside it says why: a local model server that is not running, or an API key that is not set on the server (`ANTHROPIC_API_KEY` or the `keyEnv` of the provider)
- In the container a local server must be reachable as `host.docker.internal`; for Trifle add `--allow-host host.docker.internal` to its bridge
- "did not match the file text" on a card: the model quoted the file inexactly twice. Ask again, or select the lines first and use Rewrite selection

### PDF Preview Blank

- Check compilation succeeded (look for errors)
- Try a simple document first to test setup
- Verify PDF.js CDN is accessible

## Browser Support

- Chrome/Edge 88+
- Firefox 85+
- Safari 14+
- Modern mobile browsers (responsive design)

## Performance Notes

- Large documents (100+ pages) may be slower
- Preview updates after each successful compilation
- Chat history is kept to last 20 messages to save memory
- Local storage limit: typically 5-10 MB per domain

## Limitations & Future Enhancements

**Current Limitations:**
- Single-threaded compilation (processes one file at a time)
- No collaborative editing
- Limited to browser's localStorage capacity
- No canned answers: with no provider ready the assistant says so

**Potential Enhancements:**
- Database backend for file storage
- Real-time collaboration (WebSockets)
- Syntax highlighting for LaTeX
- Code completion and snippets
- Custom templates library
- Export to other formats
- Version control/undo history
- User authentication

## License

MIT

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review browser console for errors
3. Verify all prerequisites are installed
4. Check server logs for backend errors

## Technical Stack

- **Frontend**: HTML5, CSS3, vanilla JavaScript
- **Backend**: Node.js, Express.js
- **PDF Handling**: PDF.js (viewer), pdflatex (compilation)
- **AI Integration**: model providers called directly (OpenAI-compatible, Anthropic), Trifle optional
- **Storage**: Browser localStorage (with server option available)
- **Styling**: CSS3 with dark theme (VS Code inspired)
