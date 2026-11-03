<p align="center"><img src="public/kaleidoscope.svg" width="140" alt="Kaleidoscope logo"></p>

# Kaleidoscope

A web-based LaTeX editor that runs on your own machine: edit on the left, compile with pdfLaTeX, LuaLaTeX or XeLaTeX, read the PDF on the right, and ask a model of your choice (a local MLX server, Claude, or any OpenAI-compatible API) to fix errors or rewrite text. The model proposes changes as diffs; nothing changes until you accept it.

## Features

- **Files** - open any `.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.txt` or `.md` file from a workspace folder on disk, or keep scratch files in the browser. Save writes back to disk; nothing is written until you press Save.
- **Editor** - a plain-text editor with command and environment completion (`\c` + Tab gives `\cite{}`), text zoom and resizable panes.
- **Compile** - pdfLaTeX, LuaLaTeX and XeLaTeX, chosen automatically or by you. A file is compiled together with its folder (`\input`, images, `.bib`), BibTeX and Biber run when needed, and passes repeat until references settle.
- **Preview** - the PDF is drawn in the page, fitted to the pane, with zoom.
- **Assistant** - Fix error, Rewrite selection, Explain, or ask a question. You pick the provider and the model; answers stream in and suggested edits appear as diffs to accept or reject.
- **Contained** - `./run_contained.sh` runs the server and TeX in Docker, which sees one folder of yours and nothing else.
- **Local first** - your files go to a model only if you pick a hosted provider, and the page says so.

## Quickstart

The easiest way to run Kaleidoscope is in a container: the server, TeX Live (pdfLaTeX, LuaLaTeX, XeLaTeX, BibTeX, Biber) and every document you compile stay inside Docker, and see only one folder of yours.

**You need** Docker (Docker Desktop on macOS). Nothing else: no Node.js and no TeX installation.

```bash
git clone https://github.com/sgt101/Kaleidoscope.git
cd Kaleidoscope
./run_contained.sh
```

Open **http://localhost:3000**. The first run builds the image (TeX Live: a few minutes and about 2 GB); later runs start in seconds. Press Ctrl+C to stop.

1. **Open a file.** The workspace is the `documents/` folder next to the script. Click the folder icon at the top left to browse it and click a `.tex` file to open it, or use `+` to create a scratch file.
2. **Compile.** Choose an engine (Auto, pdfLaTeX, LuaLaTeX, XeLaTeX) and press **Compile PDF**. Errors appear in the preview pane. Save (Ctrl/Cmd+S) writes the file back to the workspace folder.
3. **Ask the assistant.** It needs a model: see below. Then use **Fix error**, **Rewrite selection**, **Explain**, or type a question in the box at the bottom.

**Common options**

```bash
./run_contained.sh --work ~/papers     # use another folder as the workspace
./run_contained.sh --port 8080         # another port
./run_contained.sh --detach            # run in the background...
./run_contained.sh --stop              # ...and stop it again
./run_contained.sh --rebuild           # rebuild the image from scratch
./run_contained.sh --help              # everything the script can do
```

**Giving the assistant a model**

- *Local (MLX):* start a server on your Mac, for example `mlx_lm.server --model mlx-community/Qwen3-8B-4bit --port 8081`. Kaleidoscope looks for it at `http://127.0.0.1:8081/v1` (from the container it is reached as `host.docker.internal`). Choose other models in the box beside the provider menu.
- *Claude or OpenAI:* set the key before starting, e.g. `ANTHROPIC_API_KEY=... ./run_contained.sh`, or put it in `.env` (copy `.env.example`). A hosted provider receives the open file; a local one does not.
- *More control* (several providers, token limits, timeouts, other models): copy `providers.example.json` to `providers.json` and edit it. See [The assistant](#the-assistant).

**Packages that are not in TeX Live** (for example `tikzflora`) go in the same workspace folder as your `.tex` file, with any `.lua` files they use; the container compiles from a copy of that folder.

Prefer no Docker? See [Running without Docker](#running-without-docker).

## Using Kaleidoscope

### Files

- **Open from disk:** the folder icon opens the workspace browser. Click folders (or the breadcrumbs) to move around and a text file to open it; arrow keys move through the list. Images and other non-text files are greyed out. You can create a file in the folder you are looking at.
- **Open files list:** the left panel lists the files you have open. A dot marks unsaved changes. `✕` closes a file opened from disk (the file on disk is kept) and deletes a scratch file.
- **Save:** the Save button or Ctrl/Cmd+S writes the open file to disk. Nothing is written before that. Saving a scratch file asks where in the workspace to put it, and from then on it is a disk file.
- **Scratch files:** `+` creates one and `↑` imports one from your computer. They live in your browser only.

The browser can only reach files inside the workspace folder. Paths that leave it (`..`, absolute paths, symlinks that point outside) and hidden files are refused.

### Compiling

- **Engine:** the Engine menu chooses pdfLaTeX, LuaLaTeX or XeLaTeX. **Auto** (the default) follows a `% !TEX program = lualatex` comment near the top of the file (as written by TeXShop, TeXworks and VS Code), and otherwise picks LuaLaTeX for documents that use `\directlua`, `luacode`, `fontspec`, `unicode-math` or `polyglossia`, and pdfLaTeX for everything else. The preview says which engine was used. Your choice is remembered.
- **Whole folder:** a file opened from disk is compiled together with the rest of its folder, so `\input`, `\includegraphics` and `.bib` files resolve. The server copies the folder (text, style, image, font, Lua and data files; subfolders included) to a scratch directory, so your folder gets no `.aux` or `.log` clutter. Unsaved edits in other open files of that folder are included, so the PDF matches what you see.
- **Passes:** TeX runs, then `bibtex` (for `\bibliography`) or `biber` (for `biblatex`) when needed, then TeX again until references settle (at most 5 passes). If the bibliography tool is missing, the PDF still builds and the preview says citations are unresolved.
- **Main file only:** compile the main file. A file with no `\documentclass` (one that is `\input` from elsewhere) is refused with an explanation.
- **Limits:** folders of more than 3000 files or 100 MB are refused (move the document into its own folder). Each pass may take 30 s (pdfLaTeX) or 120 s (LuaLaTeX, XeLaTeX). The first LuaLaTeX or XeLaTeX run builds a font cache and can take a minute; if it times out, try again.
- **Scratch files** have no folder, so they compile on their own.

### Completions

Type a backslash and a letter (`\c`) and a list of matching commands appears at the caret, each with a short description. **↑ / ↓** choose, **Tab** inserts the command, with `{}` when it takes an argument and the caret placed inside (`\cite{|}`; `\frac` gives `\frac{|}{}`). **Esc** closes the list; typing on narrows it. Commands that take no argument (`\item`) are inserted as they are, and if the command is already followed by braces they are not added again. After `\begin{` or `\end{` the list offers environment names (`itemize`, `equation`, `tabular`, ...) and Tab also closes the brace. Nothing is offered inside a `%` comment. An inserted completion is ordinary typing: Ctrl/Cmd+Z undoes it. The lists are in `public/complete.js`; add your own there.

### Using the assistant

The bar under the editor talks to a model. Read the line beside the provider menu first: it says whether your file stays on your machine or is sent to a hosted service.

1. Pick a **provider** and a **model**.
2. **Fix error** (after a failed compile), **Rewrite selection** (select text, say in the box how to change it, press the button), **Explain** (the selection, the error, or the document), or type a question and press Enter. **Stop** cancels a running answer.
3. Each suggested change is a card showing the lines removed and added. **Accept** puts it into the editor (Ctrl/Cmd+Z undoes it), **Reject** drops it. Accepting changes the editor text only; Save writes it to disk.

See [The assistant](#the-assistant) under Configuration for providers, models and what the model is shown.

### Layout and zoom

- **Resize panes:** drag the bars between the file list, editor and preview, and the bar above the chat. Double-click a bar to reset it. With a bar focused, the arrow keys nudge it (Shift for bigger steps) and Home resets it.
- **Editor text size:** `A−` / `A+` in the editor header, or Ctrl/Cmd + `-` / `=` / `0` (or Ctrl + scroll) while typing. The size shown resets to 13px when clicked.
- **Preview zoom:** `−` / `+` in the preview header, or Ctrl + scroll (or trackpad pinch) over the preview. 100% fits the page to the pane width and follows the pane as you resize it; click the percentage to return to it. The PDF is redrawn at the new size, so it stays sharp.

Sizes, zoom, engine, provider and model are remembered in your browser.

### What is stored where

- **Browser (localStorage):** scratch files, copies of open workspace files and their unsaved edits, the chat, pane sizes, zoom, engine, provider and model. Files and chat survive closing the browser; the storage limit is typically 5 to 10 MB.
- **Workspace folder:** your real files, changed only when you press Save.
- **Server:** nothing is kept between requests except which compiles and questions are running. Scratch build folders are deleted after each compile.

## Configuration

Settings come from the environment or from a `.env` file in the project folder (copy `.env.example`); real environment variables win. `run_contained.sh` reads the same `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | port the server listens on |
| `HOST` | `127.0.0.1` | address to listen on; `0.0.0.0` exposes the compile endpoint to your network, so only behind your own authentication |
| `ALLOWED_HOSTS` | | extra host names the app may be reached by (comma separated), for a reverse proxy |
| `WORKSPACE_DIR` | `./documents` | the one folder the editor may list, open, save and compile |
| `MLX_URL`, `MLX_MODEL` | `http://127.0.0.1:8081/v1`, `default_model` | the built-in local provider |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | adds Claude when the key is set |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_URL` | `https://api.openai.com/v1` | adds an OpenAI-compatible provider when the key and model are set |
| `PROVIDERS_FILE` | `./providers.json` | describe the providers in a file instead (below) |
| `LOOPBACK_HOST` | | a name that replaces `localhost` / `127.x` in provider URLs; the container launcher sets it to `host.docker.internal` |
| `TRIFLE_URL`, `TRIFLE_TOKEN`, `TRIFLE_TOKEN_FILE`, `TRIFLE_TIMEOUT_MS` | see Trifle | the optional Trifle provider |
| `PDFLATEX_PATH`, `LUALATEX_PATH`, `XELATEX_PATH`, `BIBTEX_PATH`, `BIBER_PATH` | found on `PATH` | full paths, if the tools are elsewhere |

### The assistant

It is task oriented rather than a general agent: the editor decides what the model sees, the model replies with text and edit blocks, and nothing changes in your file until you press **Accept**.

**Providers.** Two wire formats cover most services: OpenAI-compatible chat (MLX `mlx_lm.server`, Ollama, llama.cpp, OpenAI, OpenRouter, ...) and Anthropic Messages (Claude). Without a `providers.json` you get:

- **MLX (local)** at `MLX_URL` (default `http://127.0.0.1:8081/v1`, model `MLX_MODEL`, default `default_model`);
- **Claude** when `ANTHROPIC_API_KEY` is set (model `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`);
- **OpenAI** when `OPENAI_API_KEY` and `OPENAI_MODEL` are set;
- **Trifle** when a Trifle access token is found (see below).

For anything else copy `providers.example.json` to `providers.json` (or point `PROVIDERS_FILE` at a file). Once the file exists it replaces the built-in list. It holds a list of `{ id, label, kind, url, model, keyEnv, contextChars, maxTokens, temperature, timeoutSeconds }`, where `kind` is `openai`, `anthropic` or `trifle`. A key is never written in the file: `keyEnv` names the environment variable that holds it, and the key stays on the server, never in the browser. The provider menu shows which are ready (a local server is probed; a hosted one needs its key). The line beside it says where your text goes: a local provider keeps the open file on your machine, a hosted one **sends the open file to that service**, so pick accordingly.

```json
{
  "default": "mlx",
  "providers": [
    { "id": "mlx", "label": "MLX (local)", "kind": "openai", "url": "http://127.0.0.1:8081/v1",
      "model": "default_model", "maxTokens": 16384, "timeoutSeconds": 300 },
    { "id": "claude", "label": "Claude", "kind": "anthropic", "model": "claude-sonnet-5-5", "keyEnv": "ANTHROPIC_API_KEY" }
  ]
}
```

**Choosing the model.** The box beside the provider menu is the model that answers. Its drop-down lists what the provider reports (`/models`): for MLX, the models in your Hugging Face cache; for Claude, OpenAI and OpenRouter, their catalogues. You can also type any name. An `mlx_lm.server` loads the model a request names, so typing a Hugging Face repo such as `mlx-community/Qwen3-8B-4bit` switches to it; the first question after a switch waits while it loads (if that takes over two minutes, raise `timeoutSeconds`). The choice is remembered per provider in your browser; clear the box to go back to the provider's configured model (`MLX_MODEL`, or `model` in `providers.json`).

**Thinking models.** Models that think before answering can use their whole token allowance on thinking and send no answer. The error then says so ("used all N tokens thinking"); raise `maxTokens` for that provider (the default is 4096) or pick a model that does not think. Models that print reasoning as `<think>...</think>` have it hidden.

**Tasks.** The buttons above the chat start a task with its own instructions and context; typing in the box asks a free question about the file.

| Task | What it does |
|---|---|
| **Fix error** | enabled after a failed compile; the model gets the error and the source around each `l.N` line, and proposes the smallest fix, or says the cause is elsewhere |
| **Rewrite selection** | select text, say in the box how to change it, press the button; one change replaces exactly the selection |
| **Explain** | explains the selection, or the compile error, or the document; never proposes edits |
| (ask) | any question; changes are proposed only if you ask for one |

**What the model sees.** Always the same, built by the editor: the file name; the document with line numbers (so `l.113` in a log points at a real line); your selection with its line range; and, for Fix error, the compile error. A document too large for the provider's `contextChars` (default 32000) is cut down to the preamble, the neighbourhood of the selection, cursor and error lines, and an outline, with the gaps marked. The last eight messages of the conversation go along; nothing else from your machine does.

**Edits.** The model proposes changes as search/replace blocks. Each becomes a card showing the lines removed and added, with **Accept** and **Reject** (and **Accept all** for several). A block applies only where its text occurs exactly once in the file; if a block does not fit, the model is told once and asks again, and a block that still does not fit is shown as not applicable. Accepting changes the editor's text only, through the text field's own undo stack; it is saved to disk only when you press Save. The assistant edits the open file and no other. Because it cannot run commands or write files, a hostile document that says "ignore your instructions" can at worst produce a change you reject.

**Streaming and Stop.** Answers stream in; **Stop** cancels the request to the model. A model that goes silent for two minutes (`timeoutSeconds` to change it) is given up on. One question is answered at a time.

**In the container**, `./run_contained.sh` reaches your MLX server and other local services as `host.docker.internal` (`localhost` in `MLX_URL` and `providers.json` is rewritten for you), mounts `providers.json` read-only and passes each key it needs by name (`-e NAME`, so it never appears in `ps`). Make sure the model server listens where Docker can reach it; `mlx_lm.server --host 127.0.0.1` works with Docker Desktop on macOS.

**Trifle** is available as one provider. It is used when a token is found (`TRIFLE_TOKEN`, `TRIFLE_TOKEN_FILE`, or `~/.config/trifle/token`) at `TRIFLE_URL` (default `http://127.0.0.1:8792`, then `:8787`). It has its own model and tools, takes the whole prompt as one message with no streaming, and its conversation lives in Trifle's session. From the container its bridge must accept the name `host.docker.internal` (`--allow-host host.docker.internal`). A failure (token rejected, not reachable, too slow after `TRIFLE_TIMEOUT_MS`) is shown as one.

## Running without Docker

Use this if you want to work on a trusted set of documents with your own TeX installation, or to develop Kaleidoscope. See [Security](#security) first: without the container, LuaLaTeX documents can read files your account can read.

**You need** Node.js 20.12 or newer and a TeX distribution. `pdflatex` is required; `lualatex`, `xelatex` and `biber` are used when present.

```bash
brew install --cask mactex              # macOS; or: sudo apt-get install texlive-full biber   (Debian/Ubuntu)
npm install
npm start                               # http://localhost:3000
```

- On Windows install [MiKTeX](https://miktex.org/) or [TeX Live](https://www.tug.org/texlive/) and make sure `pdflatex` is on your `PATH`.
- A smaller TeX (BasicTeX, `texlive-latex-base`) works, but packages your documents use must then be installed (`tlmgr install <package>`).
- `npm run dev` restarts the server when files change.
- On start the server prints which providers and TeX tools it found and which folder is the workspace. If a tool is not found, set its `*_PATH` variable.
- Settings go in `.env` (see [Configuration](#configuration)). `npm start` serves `documents/` unless `WORKSPACE_DIR` says otherwise.

## Architecture

### The screen

<table>
<tr>
<td width="55%" valign="top">

<img src="public/Kaleidoscope-screenshot.png" alt="Kaleidoscope: open files on the left, the LaTeX source in the middle, the compiled PDF on the right, and the assistant under them">

</td>
<td valign="top">

```
┌────────────────┬──────────────────────────┬───────────────────┐
│ Kaleidoscope   │ Engine  A-  A+  Save     │ Preview    - +  x │
│ open  new  up  │ [ Compile PDF ]          │                   │
├────────────────┤                          │                   │
│ Open files     │ Text editor              │ PDF preview       │
│                │ (textarea) with          │ (PDF.js), zoom    │
│ notes.tex      │ command completion       │ to fit the pane   │
│ refs.bib       │                          │                   │
│                │                          │                   │
├────────────────┴──────────────────────────┴───────────────────┤
│ Provider  Model   status   [Fix error] [Rewrite] [Explain]    │
│ Chat: answers stream in; suggested edits appear as diffs      │
│ with Accept / Reject                                          │
│ [ Ask about this file, or describe a change...  ]  [Send]     │
└───────────────────────────────────────────────────────────────┘
```

</td>
</tr>
</table>

The page has three panes above an assistant bar. All of it is one static page (`public/index.html`) and a few scripts; the panes are separated by draggable bars.

| Area | What it is |
|---|---|
| **Open files** (left) | the files you have open, with a dot on unsaved ones, and buttons to browse the workspace, create a scratch file and import one |
| **Editor** (middle) | a plain `<textarea>`; its header holds the engine menu, text size, Save and Compile PDF; completions appear at the caret |
| **Preview** (right) | the compiled PDF drawn with PDF.js, or the compile error; zoom controls in its header |
| **Assistant** (bottom) | provider menu, model box, a status line (local or hosted), the three task buttons, the conversation with suggested edits as diff cards, and the input box |

### System overview

```
┌─ Browser  (public/, served by the server as static files) ───────────────────────┐
│ index.html, styles.css   the page: no framework, no build step                   │
│ app.js                   UI and state, compile and chat clients, panes, zoom     │
│ complete.js              command and environment completions                     │
│ edits.js                 edit-block parser (also used by the server)             │
│ PDF.js                   draws the compiled PDF (loaded from cdnjs)              │
│ localStorage             open files, chat, layout, zoom, engine, provider, model │
└──────────────────────────────────────────────────────────────────────────────────┘
            ▲ ▼  same-origin HTTP on 127.0.0.1: JSON, PDF bytes, NDJSON stream
┌─ Node server  (server.js, Express; its only runtime dependency) ─────────────────┐
│ /api guard      Host allow-list and same-origin check on every API call          │
│ /api/fs/*       list, read and save text files            → workspace            │
│ /api/compile    scratch copy, engine passes, bibliography → TeX tools            │
│ /api/assistant  providers, readiness, model names         → providers.js         │
│ /api/chat       task → context → model → checked edits    → assistant.js         │
└──────────────────────────────────────────────────────────────────────────────────┘
            ▼                         ▼                             ▼
              files                     child processes               HTTP
┌─ Workspace ──────────┐ ┌─ TeX tools ────────────┐ ┌─ Model providers ────────────┐
│ one folder of your   │ │ pdflatex               │ │ MLX or Ollama (local)        │
│ .tex, .bib, images   │ │ lualatex, xelatex      │ │ Claude, OpenAI-style APIs    │
│ and data files       │ │ bibtex, biber          │ │ Trifle bridge                │
│ (WORKSPACE_DIR)      │ │ in a scratch folder    │ │ keys stay on the server      │
└──────────────────────┘ └────────────────────────┘ └──────────────────────────────┘
```

Kaleidoscope is a small client-server application. The browser holds the editing state and does everything that needs the screen: editing, completion, PDF drawing and applying edits. The server is the only part that touches files, TeX and model services, and it does so on the browser's behalf through a handful of JSON endpoints. There is no database and no build step; the only runtime dependency is Express.

### Components

| File | Runs in | Responsibility |
|---|---|---|
| `server.js` | Node | HTTP server and all endpoints: the request guard, workspace file API, compile pipeline, assistant endpoints, startup report |
| `providers.js` | Node | the model layer: loads the provider list, probes readiness, lists model names, streams a completion over the OpenAI or Anthropic wire format, applies the idle timeout and abort |
| `assistant.js` | Node | the assistant's tasks: system prompts per task, the deterministic context builder, history trimming, `<think>` filtering, and the retry when a proposed edit does not fit |
| `trifle.js` | Node | client for the optional Trifle bridge |
| `public/app.js` | Browser | application state and persistence, file list and workspace browser, compile client and PDF rendering, assistant client and edit cards, pane layout and zoom |
| `public/complete.js` | Browser | command and environment completions: matching, insertion rules and the popup (its logic is plain functions, tested in Node) |
| `public/edits.js` | Both | the edit-block format: parse, locate, apply and check; the server uses it to verify a proposal, the browser to show and apply it |
| `run_contained.sh`, `Dockerfile` | host | build the image and start the container with the isolation flags |
| `test/` | Node | unit tests (`npm test`) for edits, providers, the assistant and completions |

### How a compile works

1. The browser posts the text **in the editor** (not the saved copy), the engine, and, for a file opened from disk, its workspace path and the unsaved text of the other changed files (`overrides`).
2. The server refuses if two compiles are already running (HTTP 503), picks the engine (your choice, a `% !TEX program` comment, Lua or `fontspec` markers, otherwise pdfLaTeX) and refuses a file without `\documentclass`.
3. It creates a scratch directory and copies the main file's folder into it: only regular files with a known extension, no hidden files, no symlinks that leave the workspace, at most 3000 files, 100 MB and eight levels. The unsaved overrides are written over the copies, and the main file is written as `document.tex`.
4. It runs the engine with `-interaction=nonstopmode -halt-on-error -no-shell-escape` and a bare environment (only `PATH`, `HOME` and TeX's paranoid file-access settings), killing it on timeout.
5. If the log shows a bibliography is needed (`\bibdata` in the `.aux`, or a `.bcf` file) it runs `bibtex` or `biber`, then reruns the engine while TeX asks for another pass, up to five passes in all.
6. On success it returns the PDF bytes with `X-Compile-Engine` and `X-Compile-Notes` headers; on failure JSON with the TeX errors extracted from the log (`!` lines, and errors raised in Lua code). The scratch directory is deleted either way.
7. The browser hands the PDF to PDF.js, draws each page to a canvas at pane width times zoom, and swaps the pages in together; a newer render (another zoom step, a resize) cancels an older one. A failure is kept for that file, which is what enables **Fix error**.

### How an assistant request works

1. The browser sends the provider, the optional model, the task, your message, the last messages of the chat, the **whole open file**, the selection and cursor offsets, and the last compile error of that file.
2. The server checks the request (one question at a time, HTTP 409 otherwise) and opens a streaming response of newline-delimited JSON. If the browser disconnects, the upstream model request is aborted.
3. `assistant.js` builds the prompt: the task's instructions plus the edit-block format, then a user message holding the numbered document (cut down around the selection, cursor and error lines if it exceeds the provider's `contextChars`), the selection, and for Fix error the compile error.
4. `providers.js` streams the model's answer (`/chat/completions` or `/v1/messages`), and the text is forwarded as it arrives, with `<think>` blocks removed.
5. When the answer is complete the server checks every edit block against the document. If one does not match exactly once, the model is told what was wrong and asked once more; blocks that still fail are reported to the browser.
6. The browser parses the answer into text and edit blocks, shows each block as a diff card, and on **Accept** applies it to the text field through `document.execCommand`, so the browser's own undo history records it. Nothing is saved until you press Save.

### Data and state

| Where | What | Lifetime |
|---|---|---|
| Browser `localStorage` | `latexFiles` (scratch files, and open workspace files keyed `ws:<path>` with their unsaved text), `currentFile`, `dirtyFiles`, `chatHistory`, `engine`, `provider`, `model:<id>`, `layout`, `zoom` | until cleared |
| Browser memory | the last compile error per file, the loaded PDF, the running assistant request | the page |
| Server memory | the provider list (read at start), counters for running compiles and questions, short caches of provider readiness (3 s) and model lists (3 s local, 60 s hosted) | the process |
| Workspace folder | your files | changed only by Save |
| Scratch directories | one per compile, in the system temp folder | deleted after the compile |
| `HOME` of the server | TeX font and parse caches (LuaLaTeX, XeLaTeX, Biber), kept so that they are not rebuilt on every compile; in the container a named volume | persistent |

### Security

Kaleidoscope is a single-user tool for your own machine. It has no accounts and no authentication, so its protections are about keeping it local and keeping documents contained.

- **Local only.** The server listens on `127.0.0.1` (`HOST` to change). Every `/api` call must carry a `Host` of `localhost`, `127.0.0.1` or `[::1]` (or an `ALLOWED_HOSTS` name) and, if it has an `Origin`, the same one. That stops other sites in your browser, including DNS-rebinding tricks, from using the compile endpoint. No CORS headers are sent. Only `public/` is served: the server code, `.env` and your documents are not.
- **Workspace jail.** Every path from the browser is resolved with `realpath` and must stay inside the workspace folder, so `..`, absolute paths and links pointing outside are refused, as are hidden files. Only text file types can be opened or saved, up to 2 MB.
- **Compiling.** TeX runs with `-no-shell-escape`, in a scratch copy, with file access limited to that folder (`openin_any=p`, `openout_any=p`), a bare environment and a timeout. **LuaTeX is the exception for reading:** Lua code in a document (`\directlua`) can read any file your user account can, and write to nothing outside the build folder. Compile only documents you trust, or use the container.
- **Keys.** API keys are read by the server from the environment and never sent to the browser. In the container they are passed by name (`-e NAME`), so they do not appear in the process list, and the TeX programs never see them.
- **Your text and models.** A local provider keeps the open file on your machine. A hosted provider receives the open file (up to the context limit) and the last chat messages; the page shows which kind is selected. The assistant can only return text: it cannot run commands, read other files or write files.

### The container

`./run_contained.sh` builds an image (`node:20-bookworm` plus TeX Live with LuaLaTeX, XeLaTeX, BibTeX and Biber) containing only the app, not your documents or secrets, and runs it with:

- a **read-only root filesystem**, a 512 MB tmpfs for `/tmp`, **no Linux capabilities**, `no-new-privileges`, a non-root user, and limits of 2 GB memory, 2 CPUs and 512 processes;
- one **bind mount**: the workspace folder, read-write so that Save works (`/` and your home folder are refused as workspaces), and a named volume for TeX caches;
- the page **published on `127.0.0.1` only**;
- the assistant's settings passed in from the environment or `.env`, `providers.json` mounted read-only, and `LOOPBACK_HOST=host.docker.internal` so that a model server on your machine is reachable.

A document compiled there, even a LuaLaTeX one, cannot see your home folder or your keys. `docker-compose.yml` is an alternative way to start the same image.

### Design decisions

- **One folder, one server, no build step.** The page is plain HTML, CSS and JavaScript served as static files, so there is nothing to bundle and the whole front end can be read in an afternoon.
- **The browser is the source of truth while you edit.** Compiles and assistant requests use the text in the editor, not the file on disk, and nothing reaches disk without Save.
- **A task-oriented assistant, not an agent.** The model gets a fixed context built by the editor and can only answer with text and edit blocks. That keeps behaviour predictable, keeps the model unable to touch anything but the open file, and works with small local models.
- **Edits are search/replace blocks, not whole files.** A block is short, can be checked against the document by the server before you see it, and is shown as a diff you can accept one change at a time.
- **Providers are data.** A new OpenAI-compatible service is a few lines in `providers.json`; only a new wire format needs code.
- **Containment over permissions.** Rather than trying to make TeX safe on the host, the supported way to compile documents you did not write is to give the whole stack a throwaway root filesystem and one shared folder.

### Known limits

- Single user, no authentication; do not expose it to a network.
- One assistant question at a time for the whole server, and at most two compiles at once.
- The PDF viewer (PDF.js) is loaded from `cdnjs.cloudflare.com`, so the page needs internet access the first time it loads.
- The editor is a plain `<textarea>`: no syntax highlighting, and completions know commands and environments but not your labels or citation keys.
- Scratch files and chat live in browser storage, which is limited in size and local to that browser.

## API reference

All endpoints are under `/api`, are same-origin only, and answer errors as JSON (`{ "error": "...", "details": "..." }`).

### GET `/api/fs/list?path=<folder>`

Lists a workspace folder (empty path: the root): `{ path, root, entries: [{ name, type: "dir" | "file", size, editable }] }`, folders first.

### GET `/api/fs/file?path=<file>`

Reads a text file: `{ path, content }`. Status 415 for other file types or binary content, 413 above 2 MB.

### PUT `/api/fs/file`

Saves or creates a text file: body `{ "path": "notes/chapter1.tex", "content": "..." }`, answer `{ path, saved: true }`.

### POST `/api/compile`

```json
{
  "texContent": "\\documentclass{article}...",
  "engine": "auto",
  "path": "papers/main.tex",
  "overrides": { "papers/intro.tex": "unsaved text" }
}
```

`engine` is `auto`, `pdflatex`, `lualatex` or `xelatex`. `path` and `overrides` are optional: with `path` the file's whole folder is compiled. **Response:** `application/pdf` with `X-Compile-Engine` and an optional URL-encoded `X-Compile-Notes`; or JSON with `details` holding the TeX errors (400 for a bad request, 503 when busy, 500 when compilation fails).

### GET `/api/assistant`

The configured providers and whether each is ready: `{ providers: [{ id, label, kind, model, models, local, host, ready, detail }], default }`, where `model` is the configured default and `models` the names the provider offers (empty when it cannot say).

### POST `/api/chat`

Ask the assistant about the open file. The reply is a stream of newline-delimited JSON.

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

## Development

```
server.js  providers.js  assistant.js  trifle.js    the server and the assistant's back end
public/        index.html  styles.css  app.js  complete.js  edits.js  kaleidoscope.svg
test/          unit tests (node --test)
documents/     the default workspace
Dockerfile  docker-compose.yml  run_contained.sh      container
providers.example.json  .env.example                 configuration templates
```

The other `.md` and `.txt` files in the project root are earlier notes and may be out of date; this README is the reference.

```bash
npm install
npm test          # unit tests for edits, providers, the assistant and completions
npm run dev       # server with auto-reload
```

Where to change things:

- **Completions:** the `COMMANDS` and `ENVIRONMENTS` lists in `public/complete.js`.
- **Assistant behaviour:** `assistant.js` (`TASK_PROMPTS`, `buildUserMessage`, `documentView`, the retry), `providers.js` (provider loading, the two wire formats), `public/edits.js` (the edit-block format, shared by server and browser).
- **Compiling:** `server.js` (`ENGINES` for engines and timeouts, `PROJECT_EXTS` for the file types copied into a compile, `compileLaTeXToPDF` for the passes).
- **Look and feel:** `public/styles.css` (dark theme, pane sizes, fonts) and `defaultTemplate` in `public/app.js` for the text of a new file.

## Troubleshooting

**The container will not start**
- "Docker is not running": start Docker Desktop and try again.
- "port 3000 is already in use": another program uses it; run with `--port 8080`. An older copy of this container is replaced automatically.
- After renaming or moving the project, an old container from before the rename may still hold the port: `docker ps`, then `docker rm -f <name>`.

**Compilation fails**
- "pdflatex not found" (without Docker): install a TeX distribution or set `PDFLATEX_PATH`, then restart the server.
- "timed out": large documents or heavy packages may need more than the 30 s (pdfLaTeX) or 120 s (LuaLaTeX, XeLaTeX) per pass; the first LuaLaTeX run also builds a font cache, so try again. Timeouts are in `ENGINES` in `server.js`.
- A package that is not in TeX Live, or a `.lua` file a package loads, must sit next to your `.tex` file in the workspace. For example `tikzflora` needs `tikzflora.sty`, `tikzflora-boot.lua` and its `lua/` folder, and LuaLaTeX.
- "no `\documentclass`": you compiled a file that is `\input` from another; compile the main file.

**The preview is blank**
- Check that the compile succeeded (errors show in the preview pane).
- PDF.js is loaded from `cdnjs.cloudflare.com`; check that your browser can reach it.

**The assistant does not answer**
- The provider menu marks a provider "(not ready)" and the line beside it says why: a local model server that is not running, or an API key that is not set on the server (`ANTHROPIC_API_KEY` or the `keyEnv` of the provider). Keys set in a terminal after the container started need a restart.
- In the container a local server must be reachable as `host.docker.internal`; for Trifle add `--allow-host host.docker.internal` to its bridge.
- "used all N tokens thinking", "reached the N token limit": raise `maxTokens` for the provider in `providers.json`, or pick a non-thinking model.
- "closed the connection without answering": look at the model server's own log; a model too big for memory, or one that failed to load, ends like this.
- "did not match the file text" on a card: the model quoted the file inexactly twice. Ask again, or select the lines first and use Rewrite selection.

**Files are missing after a restart**
- Scratch files live in the browser's storage: check that storage is enabled and not cleared on exit. Files in the workspace folder are on disk.
- Saving fails with "Only text files": only `.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.txt` and `.md` can be saved.

**"Host not allowed" or "Cross-origin requests are not allowed"**
- Reach the page as `localhost`, `127.0.0.1` or `[::1]`, or add your name to `ALLOWED_HOSTS`.

## Browser support

A current Chrome, Edge, Firefox or Safari. The page is laid out for a desktop-size window.

## Technical stack

- **Frontend:** HTML, CSS and vanilla JavaScript; PDF.js for the preview
- **Backend:** Node.js 20.12+, Express
- **Compilation:** pdfLaTeX, LuaLaTeX, XeLaTeX, BibTeX, Biber (TeX Live)
- **Assistant:** model providers called directly over HTTP (OpenAI-compatible and Anthropic), Trifle optional
- **Storage:** your workspace folder for files, browser localStorage for everything else
- **Packaging:** Docker, with `run_contained.sh`

## Possible enhancements

- Completion of `\ref` labels and `\cite` keys from the open files and `.bib`
- Syntax highlighting
- Search across files and a project-level file tree
- Version history
- Other export formats

## License

MIT
