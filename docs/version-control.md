# Version control for Kaleidoscope: design and plan

Status: **phase 1 (local history) implemented** in `history.js`, `public/diff.js` and `public/history-view.js`; phases 2 to 4 are still plans. Approach chosen: **Git, with a history repository that Kaleidoscope owns** (option C of the options review).

## Goals

- Every Save of a workspace file becomes a version you can look at, compare and restore, without thinking about it.
- You can also make **named versions** ("Sent to Mary", "Submitted") and see which versions **compiled**.
- Versions can be copied to **other disks** (an external drive, a cloud-synced folder) and pushed to a **remote** (a private GitHub, GitLab or Gitea repository).
- History is stored compactly (Git stores identical files once and keeps compressed differences between versions) and shown as word-level diffs.
- Nothing about it can run code, write outside the workspace, or send files anywhere that the server's configuration does not name.

## Non-goals (for now)

- Syncing between machines (pull, merge, conflicts). Remotes are push-only backups.
- Branches, or working with your own Git repositories. Kaleidoscope's history is separate from any `.git` you have.
- History for scratch files that live only in the browser.
- Diffs of images and PDFs (they are versioned, but shown only as "changed").

## Concepts

| Term | Meaning |
|---|---|
| **History repository** | a bare Git repository owned by Kaleidoscope, by default `<workspace>/.kaleidoscope/history.git`. Its work tree is the workspace; it never touches any `.git` of yours |
| **Version** | one Git commit: a snapshot of every included file in the workspace at that moment |
| **Named version** | a version with a name you gave it; never thinned |
| **Compiled marker** | a note on a version saying a file in it compiled, with which engine |
| **Destination** | somewhere versions are copied: a disk (a mirror repository), a bundle folder (single-file backups), or a remote (HTTPS) |

## How history is stored

### One repository for the whole workspace

Each version is a snapshot of the whole workspace. Views are filtered: "this file" is `git log -- <file>`, "this folder" is `git log -- <folder>`. This avoids having to guess where a project begins (a folder of chapters, a `.tex` at the root), captures changes made in other editors, and gives each destination a single repository to copy.

### Which files are included

The same rule as the compile copy (`PROJECT_EXTS` in `server.js`): text, styles, bibliographies, images, fonts, Lua and data files. Hidden files and folders, `node_modules`, and symbolic links are skipped. There is a per-file limit of 25 MB (`maxFileMB`). Office files, archives and everything else are left out, so slide decks, Word files and zips kept beside your documents do not end up in history.

### Building a snapshot (low-level Git commands, not `git add`)

`git add -A` is not usable here. It was tested in the container and failed on a folder with its own `.git` ("does not have a commit checked out"). It would also have added the history repository itself, and it obeys any `.gitignore` in your folders. Instead Kaleidoscope picks the files and tells Git exactly what to record. Git is **never given a work tree**: Git's own stat cache (`update-index --refresh`, `diff-files`) would read `.gitattributes` in the workspace and could run a clean filter named in the repository's config, so Kaleidoscope keeps its own cache instead.

1. Take the history lock (one recording at a time, in process; saves made meanwhile are merged into the next one).
2. Walk the workspace with the inclusion rule above → map **W** of relative path → size and modification time.
3. For each file whose size or time differs from the cache (`kaleidoscope-cache.json` in the history repository, valid only while `main` is where it was written), `git hash-object -w --no-filters --stdin-paths` with absolute paths → blob ids. Files changed in the last 3 s are not cached, so a change within the same tick is still seen next time.
4. `git ls-tree -r -z --full-tree main` (kept in memory between versions) → what the latest version holds; compare the blob ids → changed paths.
5. If nothing changed: no version. If the saved paths and other paths changed, first record the other changes as an `external` version.
6. Write the version's file list into a private index (`GIT_INDEX_FILE`, `update-index -z --index-info`), `git write-tree` → tree **T**.
7. `git commit-tree T -p main` with the message and trailers (below) on stdin → commit **C**.
8. `git update-ref refs/heads/main C <old>` (compare-and-swap; the empty id when there is no version yet).
9. Save the cache and release the lock. A failure is retried once with the cache cleared (a file can vanish while it is read, or the cache can name an object the repository lacks).

The plumbing was tried in the container with git 2.39.5 and on macOS with 2.54. Files inside a folder with its own `.git` were recorded, and a `*.png` line in that folder's `.gitignore` did not hide the image.

The first snapshot reads every included file once. After that a snapshot only reads files whose size or time changed.

### What a version records

The commit message is human-readable, with machine-readable trailers:

```
Saved paper/main.tex

Kaleidoscope-Reason: save
Kaleidoscope-Path: paper/main.tex
Kaleidoscope-Assistant: yes
```

| Reason | When | Subject |
|---|---|---|
| `first` | the first version of a workspace | `Files when history started` |
| `save` | after a Save | `Saved <path>` (or `Saved <a> and <b>`, `Saved <n> files`) |
| `named` | Save version | `<the name you gave>` |
| `external` | at startup, or before another version, when files changed outside Kaleidoscope | `Changes made outside Kaleidoscope` |
| `before-restore` | just before a folder restore writes files | `Before restoring <folder>` |
| `restore` | after a folder restore | `Restored <folder> to <date>` |

`Kaleidoscope-Assistant: yes` is set when assistant edits were accepted since the file was last saved, so the list can mark AI-assisted versions.

**Compiled markers** use Git notes (`refs/notes/kaleidoscope`), a JSON object per commit such as `{"compiled":[{"path":"paper/main.tex","engine":"lualatex","at":"2026-11-03T10:42:00Z"}]}`. Notes add information to a version without changing it, and they are copied with it.

The author and committer are `Kaleidoscope <kaleidoscope@localhost>` unless `author` is set in `history.json`.

## When versions are made

1. **Save.** After `PUT /api/fs/file` writes the file, the server records a snapshot in the background. Save returns immediately; a history failure never fails a Save, and the page shows it instead.
2. **Save version…** (button beside Save, or Ctrl/Cmd+Shift+S): saves any unsaved open files in the workspace, asks for a name, and records a `named` version.
3. **Successful compile.** If the compiled file and every other file of its folder are saved (no unsaved edits), the browser asks the server to attach a compiled marker to the latest version, after recording any outside changes. With unsaved edits there is no marker, because the PDF was not made from a saved version.
4. **Startup.** If the workspace differs from the last version, an `external` version is recorded.
5. **Restore** of a whole folder records `before-restore` and `restore` versions (below).

Accepting an assistant edit changes only the editor's text, so it is versioned by the next Save, marked with the `Kaleidoscope-Assistant` trailer.

## Looking at history (the page)

- **A History tab** in the right pane, beside Preview. The scope menu offers *This file*, *This folder* or *Everything*. Versions are grouped by day: time, subject, number of files changed, and badges for **named**, **compiled** (with the engine), **AI-assisted**, **restored** and **outside changes**. There is a *Named only* filter.
- **Selecting a version** shows the diff for the open file: that version against the editor's current text (default), or against the version before it. Words that changed are highlighted, and long runs of unchanged lines are collapsed with a few lines of context. Images and PDFs show "changed" with their sizes.
- **Restore this file** puts that version's text into the editor through the same path as accepting an assistant edit. Ctrl/Cmd+Z undoes it, and it reaches disk only on Save, which then records a new version.
- **Restore folder…** lists the files that will change and asks for confirmation. It records a `before-restore` version, writes the files of that version into the folder (through the same workspace checks as Save), and records a `restore` version. Files that did not exist in that version are left alone. It is refused while files in that folder have unsaved edits.
- **Destinations** are shown at the foot of the tab, for example "Saved 10:42 · Backup disk ✓ 10:42 · GitHub: token missing", with a **Back up now** button.

The word diff is a small new module, `public/diff.js` (a Myers diff over words and LaTeX commands, used in the browser and tested in Node). That avoids a dependency: the npm `diff` package had a denial-of-service flaw this year (CVE-2026-24001).

## Destinations

All destinations are defined on the server (`history.json`). The browser can trigger a backup but cannot add or change a path or URL; otherwise a web page could make the server copy your files anywhere.

| Kind | What is written | Good for | Notes |
|---|---|---|---|
| `disk` | a bare mirror repository, updated by push | an external drive, a second internal disk, a network share | quick, adds only what is new; can be opened with ordinary Git |
| `bundle` | one file per backup, `history-<time>.bundle`, written to a temporary name and renamed; the last *N* kept | iCloud, Dropbox, OneDrive folders, USB sticks | no Git repository on the destination, so a sync service cannot corrupt one; each file is a whole copy of history |
| `remote` | push over HTTPS to a repository you created | a **private** GitHub, GitLab or Gitea repository | sends every versioned file to that service; the page says so, as it does for hosted models |

### Pushing to a disk safely

A push to a mirror runs Git's `receive-pack` **inside the mirror repository**, and Git starts it with a cleaned environment. In a test in the container, a `post-receive` hook planted in a mirror ran on push, even though hooks were turned off through Kaleidoscope's environment settings. Every push to a disk therefore names its own receive-pack:

```
git push --receive-pack='git -c core.hooksPath=/dev/null receive-pack' <mirror> <refspecs>
```

With that, the planted hook did not run, even after the mirror's own config had been changed to point back at its hooks. That is the design's rule for disk pushes.

### When a disk is not attached

- A disk destination is set up only by an explicit action (**Set up** in the History tab, or the launcher). The server creates the mirror and a marker file `kaleidoscope-history.json` holding the history repository's id.
- A destination is **available** only when that marker exists with the right id. The server never creates a missing parent folder: under `/Volumes`, that would write onto the internal disk, and macOS would then mount the real drive as `Backup 1`.
- Backups to a missing destination are skipped and shown as "not attached". The next version or **Back up now** catches up, since Git sends only what is missing.

### Remotes

- HTTPS only at first. The token comes from an environment variable named by `keyEnv`, as with model providers, and is passed to Git as an `http.extraHeader` setting through the environment, so it is not on any command line and is not written to disk. Messages are cleaned of it before they reach the page.
- Use a dedicated private repository (for example `kaleidoscope-history`), never your code repository: the history contains your documents.
- SSH (through Docker Desktop's forwarded agent) comes later.

### What is copied

`refs/heads/main`, and `refs/notes/kaleidoscope`, with `+` refspecs (forced), because thinning (below) can rewrite older history. Backups run 30 s after the last version (one at a time), on **Back up now**, and at startup. `"auto": false` on a destination makes it manual only.

## Configuration

History is on by default with no configuration. `HISTORY=off` turns it off, and `HISTORY_DIR` moves the history repository (an absolute path, or one relative to the workspace). Destinations, author and limits go in `history.json` (or `HISTORY_FILE`), next to `providers.json`:

```json
{
  "dir": ".kaleidoscope/history.git",
  "author": { "name": "Simon Thompson", "email": "simon@example.com" },
  "maxFileMB": 25,
  "destinations": [
    { "id": "t7", "label": "Backup disk", "kind": "disk", "path": "/Volumes/T7/Kaleidoscope/history.git" },
    { "id": "icloud", "label": "iCloud", "kind": "bundle", "path": "~/Library/Mobile Documents/com~apple~CloudDocs/Kaleidoscope", "keep": 10 },
    { "id": "github", "label": "GitHub", "kind": "remote", "url": "https://github.com/sgt101/kaleidoscope-history.git",
      "user": "sgt101", "keyEnv": "HISTORY_GITHUB_TOKEN", "auto": false }
  ],
  "retention": { "keepAllDays": 14, "thenDaily": true }
}
```

Kaleidoscope writes `.kaleidoscope/.gitignore` containing `*`, so if your workspace is itself a Git repository, its history folder does not show up in your `git status`.

## In the container

- Git is already in the image (git 2.39.5, from the `node:20-bookworm` base). The Dockerfile should install it explicitly anyway, so that a change of base image cannot drop it.
- The history repository lives in the workspace mount, so it needs nothing extra. Using a separate `--git-dir` also avoids Git's "dubious ownership" error, which `git status` hit on the mounted workspace in testing.
- `run_contained.sh` reads `history.json` and mounts it read-only, and passes each `keyEnv` by name. For each `disk` or `bundle` destination whose location is present, it adds `--mount type=bind,src=<folder>,dst=/history/<id>` and tells the server the mapping (`HISTORY_PATHS=t7=/history/t7,...`). `--mount` fails when the source is missing (unlike `-v`, which creates it), and the launcher skips and reports destinations that are not attached.
- Docker Desktop shares `/Users` and `/Volumes` by default, so external drives and cloud folders under your home folder can be mounted. A drive attached after the container started needs a restart; the History tab says "not mounted in the container".
- Without Docker, `git` must be on `PATH` (macOS: the Xcode command line tools), or set `GIT_PATH`. If Git is missing, history is turned off and the startup report and the History tab say why.

## Security

- **Git is run like TeX:** `spawn` with an argument array (no shell), a timeout, capped output and a minimal environment:
  - `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, so no system or user Git settings apply;
  - `GIT_TERMINAL_PROMPT=0` and `GIT_LITERAL_PATHSPECS=1`;
  - through `GIT_CONFIG_COUNT`: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `safe.bareRepository=explicit`, `protocol.allow=never` with only `file` and `https` allowed, `commit.gpgSign=false`, `gc.auto=0`.
- **Only Kaleidoscope's own repositories are operated on.** It never runs Git in a `.git` of yours. A repository's config can name commands to run (`core.fsmonitor`, filter drivers and more than fifteen similar settings), which is how flaws in other Git-wrapping tools arose (TruffleHog, GitHub Copilot CLI). So the history repository is treated as data: it is bare, Git is never given a work tree (so `.gitattributes` in the workspace are never read), contents are hashed with `--no-filters`, and at every start its `config` is replaced with a fixed one, `HEAD` is reset, `objects/info/alternates` and `info/attributes` are removed, and a `commondir` link is refused. `test/history.test.js` plants a filter, a textconv, an `fsmonitor` command and hooks (including `reference-transaction`, which `update-ref` would otherwise run) and checks that none runs.
- **Disk pushes** use the `--receive-pack` override above.
- **No user text is passed as a Git option.** Paths come from the workspace jail (`resolveInWorkspace`) and go after `--` as literal pathspecs. Version ids must be 40 hex characters and are checked with `git rev-parse --verify --end-of-options <id>^{commit}`. Names become commit messages through stdin. This is the class of flaw that hit `simple-git` (CVE-2026-6951, CVE-2026-28292), which is why the plan calls the `git` program directly instead of using that library.
- **Destinations exist only in server configuration.** Restores write only inside the workspace, through the same checks as Save.
- **The history folder is hidden,** so the browser's file API and the compile copy cannot reach it.
- **A remote receives every versioned file.** The page labels it, and the token never leaves the server.

## Thinning old versions (phase 4)

Text history is small, so thinning is about keeping the list readable as much as saving space. Every version is kept for `keepAllDays`. After that, only the last version of each day is kept, plus every named, compiled, restore and before-restore version. Kaleidoscope rebuilds the older part of `main` with `git commit-tree`, reusing the same trees so nothing is re-stored. It then moves the notes to the new commit ids, force-pushes to the mirrors, and runs `git gc --prune` in the history repository and the mirrors (with the same hardened settings). Bundle destinations thin themselves as old files are deleted.

## Server API

| Method and path | Purpose |
|---|---|
| `GET /api/history/status` | enabled or why not, latest version, destinations with availability, last backup and last error |
| `GET /api/history/log?path=&limit=&before=` | versions touching a file or folder (empty path: everything), newest first: `{ id, time, subject, reason, path, assistant, files, compiled }` |
| `GET /api/history/file?path=&version=` | text of a file at a version (2 MB limit; for images, the size only) |
| `POST /api/history/versions` | `{ name }` → a named version |
| `POST /api/history/restore` | `{ version, folder }` → writes the folder's files from that version; returns the files written and the before-restore id |
| `POST /api/history/compiled` | `{ path, engine }` → compiled marker on the latest version |
| `POST /api/history/backup` | `{ destination? }` → back up now, to one destination or all |
| `POST /api/history/destinations/:id/setup` | create the mirror or bundle folder on an attached disk |

Single-file restore needs no endpoint: the browser fetches the text with `/api/history/file` and puts it in the editor.

## Code changes

| File | Change |
|---|---|
| `history.js` (new, server) | the Git runner (hardened `spawn`, lock, timeouts), workspace walker, snapshot, log parsing, file at version, folder restore, notes, destinations (disk push, bundle, remote), thinning |
| `server.js` | load history settings at startup, record a version after `PUT /api/fs/file`, the `/api/history/*` routes, startup report line |
| `public/diff.js` (new, browser and Node) | word-level diff |
| `public/history-view.js` (new, browser) | the History tab: list, diff view, restore, destinations status |
| `public/app.js` | Save version, compiled marker after a clean compile, assistant-edited flag on Save, restore-into-editor helper (shared with `applyEdit`) |
| `public/index.html`, `public/styles.css` | Preview and History tabs, Save version button, dialogs |
| `history.example.json` (new), `.env.example` | configuration templates |
| `Dockerfile` | install `git` explicitly; copy `history.js` |
| `run_contained.sh` | mount `history.json` and attached destinations, pass `HISTORY_PATHS` and tokens, report skipped disks |
| `README.md` | a History section, configuration and troubleshooting |
| `test/history.test.js`, `test/diff.test.js` (new) | below |

## Testing

- **`test/history.test.js`** (runs real `git` in temporary folders; skipped if Git is missing):
  - snapshot on save, no version when nothing changed, outside changes, deletions;
  - inclusion rules: Office files, hidden files, oversized files and symbolic links are left out; files in a folder with its own `.git` are included, and folder `.gitignore` files are not obeyed;
  - log filtered by file and folder, trailers and notes parsed, file at a version;
  - folder restore with its before and after versions;
  - path and id validation (`..`, hidden, `--upload-pack=x`, short or invalid ids);
  - a planted hook in the work tree, the history repository and a mirror never runs;
  - disk push, bundle with *keep N*, unavailable destinations, lock under concurrent saves, thinning keeping named and compiled versions.
- **`test/diff.test.js`:** word diffs of LaTeX, long lines, identical and empty texts, size limits.
- **In the container:** a temporary folder as a `disk` destination through `run_contained.sh`, save and back up, then check the mirror with `git log`.
- **In the browser:** the History tab, diff against unsaved text, restore and undo, Save version, compiled badge.

## Phases

| Phase | Delivers | Size (rough) |
|---|---|---|
| 1. Local history | snapshot on Save and at startup, History tab with list, word diff and restore of a file, hardened Git runner | ~900 lines incl. tests |
| 2. Named and compiled | Save version, compiled markers, assistant flag, folder restore | ~350 lines |
| 3. Disks and bundles | `history.json`, disk and bundle destinations, setup, availability, launcher mounts, status | ~450 lines |
| 4. Remote and thinning | HTTPS remote with token, thinning and `gc` | ~350 lines |

Each phase is usable on its own, and phase 1 needs no configuration.

## Decisions (confirmed 3 November 2026)

1. A version on **every Save**, with named versions from Save version.
2. History stored **inside the workspace** (`.kaleidoscope/`), so it travels with the documents.
3. **Images and PDFs included**, up to **25 MB** each.
4. Remote backups **manual** by default (`"auto": false`), disks and bundles **automatic**.
5. Folder restore **leaves files that are not in the old version alone**.
6. **No destinations for now.** Phases 3 and 4 still build disk, bundle and remote support, but nothing is configured; the `history.json` above is an example only. Destinations can be added later without changing the history repository.

## Checked while writing this

- git 2.39.5 is in the image; trailers, notes, `--end-of-options`, `safe.bareRepository` and bundles all work with it.
- `git status` on the bind-mounted workspace fails with "dubious ownership"; a separate `--git-dir` does not.
- `git add -A` fails on a folder with its own `.git` and would add the history repository; the plumbing route works and ignores folder `.gitignore` files.
- A hook planted in a mirror ran on a plain push and did not run with the `--receive-pack` override, even with the mirror's config changed.
- (Phase 1) In a bare repository with no work tree, `hash-object --no-filters --stdin-paths`, `update-index -z --index-info` and `write-tree` build versions without reading `.gitattributes`; a planted clean filter and textconv did not run. `write-tree` refuses an index naming a missing object ("invalid object"), which is why a failed recording is retried with the cache cleared. A `reference-transaction` hook in the repository runs on `update-ref` unless `core.hooksPath` is overridden.
- (Phase 1) `git log --name-status -z` with a pathspec lists only the files under that path; `--full-diff` lists every file a version changed.
- (Phase 1) In the container (read-only root, no capabilities, workspace bind-mounted) the history repository is created and written without the "dubious ownership" error, and host Git reads it.

## References

- isomorphic-git credential leak, fixed in 1.42.0: https://www.tenable.com/cve/CVE-2026-89011
- simple-git remote code execution: https://advisories.gitlab.com/npm/simple-git/CVE-2026-6951/ and https://research.averlon.ai/vulnerability-intelligence/cve/CVE-2026-28292
- Nested bare repositories run commands (GitHub Copilot CLI): https://osv.dev/vulnerability/CVE-2026-45033
- Git settings that name commands (Debian tracker): https://security-tracker.debian.org/tracker/CVE-2026-45033
- `core.fsmonitor` in a copied repository (TruffleHog): https://access.redhat.com/security/cve/CVE-2025-41390
- jsdiff denial of service: https://nvd.nist.gov/vuln/detail/CVE-2026-24001
- Docker Desktop shared folders: https://docs.docker.com/desktop/settings/mac/
- VS Code Local History, for comparison: https://code.visualstudio.com/updates/v1_66
