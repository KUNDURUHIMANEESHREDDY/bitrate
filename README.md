# Bitrate

Self-hosted video and audio downloader with a local web UI. Binds to
`127.0.0.1` only, so nothing on your network can reach it.

Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp), which covers YouTube, X,
TikTok, Instagram, Reddit, SoundCloud, Vimeo, and roughly a thousand other
sites.

## Why it is fast

Speed here is mostly about *not doing work*, plus using the bandwidth you have.

| Lever | What it does |
| --- | --- |
| Passthrough by default | Grabs the stream the origin already serves. Re-encoding a 10 minute video can take longer than downloading it. |
| 16 concurrent fragments | DASH and HLS streams are fetched in parallel segments. Works everywhere, no extra tools. |
| aria2c when installed | Hands the transfer to a multi-connection downloader. Most CDNs throttle a single connection well below the link rate, so this is usually the largest single win. Optional. |
| 3 concurrent jobs | A queue so several downloads share bandwidth instead of fighting for it. |
| Merge is a stream copy | Combining video and audio rewrites the container over bytes already downloaded. It does not re-encode. |
| Conversion is opt-in | MP3 and forced-MP4 are explicit choices, and the UI says they cost CPU time. |
| IDM-style direct downloads | When yt-dlp has no extractor for a page but the page carries direct file links, they download with parallel `Range` segments (8 connections), like Internet Download Manager. No re-encode, straight to disk. |

Install aria2c and the same link gets meaningfully faster:

```bash
winget install aria2.aria2      # Windows
brew install aria2               # macOS
sudo apt install aria2           # Debian/Ubuntu
```

## Requirements

- Node.js 20 or newer
- Python 3.9 or newer (used only to install yt-dlp into a local venv)
- ffmpeg on `PATH` (for merging separate video and audio streams, and for MP3)

## Setup

```bash
npm install
npm run setup      # creates .venv, installs yt-dlp, makes the download folder
npm run build      # builds the web UI
npm start          # http://127.0.0.1:4820
```

For UI development with hot reload, run the API and Vite separately:

```bash
npm run dev                  # API on :4820
npm --prefix web run dev     # UI on :5180, proxying /api to :4820
```

A standalone IDM-style download without the UI:

```bash
npm run idm -- "https://example.com/video-page" "My Title" --connections 8
```

If the argument is a video page, the script scrapes it for the freshest
direct file link first (site tokens expire, so they are never reused). If it
is already a file URL, it downloads it directly.

Check your environment at any time:

```bash
npm run doctor
```

## Desktop app

The same product as a tray-resident desktop app. The API, the job queue, and
the window all live in one Electron process, so there is no separate server to
start and no port to remember.

```bash
npm install
npm run desktop      # builds the UI, then launches the app
```

Build an installer:

```bash
npm run dist         # NSIS installer in release/
npm run pack         # unpacked build in release/, no installer
```

The Windows build ships with `signAndEditExecutable: false`. Embedding the
icon and version info into `Bitrate.exe` needs the `winCodeSign` toolchain,
whose archive contains symlinks that only a Developer Mode or elevated shell
can create, so leaving it on makes the build fail on a stock account. The tray
and taskbar icons come from `desktop/icon.png` at runtime and are correct
either way. Enable Developer Mode, then flip that flag to `true` in
`electron-builder.yml` to get the icon inside the `.exe`.

What the desktop shell adds over the browser:

- **Tray as home.** Closing the window hides it. Downloads keep running, the
  tray shows the active count next to the icon, and the menu carries the live
  queue with a cancel action.
- **Global hotkey.** `Ctrl+Shift+B` brings the window forward from anywhere.
- **Grab from clipboard.** A tray item queues whatever link is on the
  clipboard, then shows the window.
- **First-run tool install.** If yt-dlp or ffmpeg is missing, the tray says so
  and can run the setup script in the background, logging to `setup.log` in the
  app's user-data directory.
- **Quit is deliberate.** Quitting with work in flight asks first, and
  "keep running" means exactly that.
- **Sensible locations in a packaged build.** The venv goes to the user-data
  directory (a packaged install directory is not writable) and videos land in
  `Videos/Bitrate` instead of next to the app.

Regenerate the app icon after editing its geometry in `desktop/make-icon.js`:

```bash
npm run icon
```

```bash
npm test             # tray menu policy, and that shutdown stays prompt
```

## Testing

Two layers, because they answer different questions.

`npm test` is fast, offline and deterministic. It checks the tray menu's policy
and wiring, the yt-dlp engine's pure decisions, and that shutting the server
down stays prompt.

`npm run eval` is the direct engine's eval suite, and `npm run eval:ytdlp` is
the yt-dlp one. Each case is queued through the same HTTP API the UI uses, so
what is measured is the product's real path. A case passes only if the job
finishes *and* the file matches what was asked for.

```bash
npm run eval                 # direct engine, offline
npm run eval:ytdlp           # yt-dlp path, offline
npm run eval:all             # both
npm run eval -- --repeat=3   # three passes, to catch flakes
npm run eval -- --only=expired-token
npm run eval:live            # also hit real sites
```

The offline cases run against local fixtures, deliberately, because remote hosts
throttle and change their markup: a third-party outage should read as a skipped
case, not as a broken app.

**The direct-engine fixtures** cover the failures that actually happened during
development — a server that honours `Range`, one that ignores it and always
sends the whole body, and one that issues links which expire in a second and
reissue on every page read.

**The yt-dlp fixtures** are generated by ffmpeg and served over loopback as an
HLS master playlist with separate video and audio variants, because that path
does things byte fixtures cannot reach: choose among formats, fetch a video
stream and an audio stream separately, merge them, extract audio to MP3, and
remux into a different container. One case asserts a conversion cannot delete an
earlier download, which is a real hazard — yt-dlp deletes the intermediate it
converted, so a name collision would silently remove a file the user already had.

Both suites were checked against deliberately reintroduced bugs. Breaking the
range handling fails the range-blind cases, removing the token refresh fails the
expiring-link cases, and inverting the collision token makes the yt-dlp suite
report the deletion it is guarding against. A green run means something.

## Tracing

Optional, and off unless you ask for it. Set the credentials and every download
becomes a trace in [Langfuse](https://langfuse.com):

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
npm start
```

For a self-hosted Langfuse, also set `LANGFUSE_BASE_URL`. Traces from the eval
runner are labelled with the `eval` environment so they cannot pollute a real
dashboard; set `LANGFUSE_ENVIRONMENT` to change the label for everything else.

Nothing else is required. With no credentials the OpenTelemetry packages are
never imported and no socket is opened, because a local-first tool that binds to
loopback and needs no account should not start phoning home just because
observability code was added to it.

One trace is one download, with the steps that actually vary underneath it:

```
download-media                    outcome, bytes, duration
├── resolve-size                  range support, size
├── refresh-link                  only when a link had expired
│   └── scrape-page               the page read that recovered it
└── fetch-bytes                   windows, bytes, throughput
```

Names are verb-first and stable, because Langfuse dashboards and evaluators
reference them as if they were an API. Run-specific values go in metadata
instead. Media URLs carry a signed token in the query string, and that token is a
credential while it is valid, so traces record the **host only** — sending whole
URLs would leak a live secret on every download. There is a test asserting no
token reaches the payload.

`npm test` covers the tracer itself, including that it stays inert when
unconfigured. `npm run test:trace` runs a real download against a local OTLP
receiver and checks the span tree, the recorded numbers and the token
redaction.

### Verifying against a real Langfuse

The receiver in those tests is a local stand-in that holds payloads to the
OpenTelemetry trace data model and answers `400` to anything malformed, so the
payload Langfuse would parse is known to be well formed. What that cannot prove
is that a real project accepted it, because a silently failing exporter looks
identical from the sender's side.

This is the step that closes that gap, and it is the only thing here that needs
an account:

```bash
npm run test:trace:verify
```

It runs a real download with tracing on, then reads the traces back out of the
Langfuse API and confirms the `download-media` trace and its child steps are
there. Point `LANGFUSE_BASE_URL` at a self-hosted instance and it works the
same way.

## Shutdown

The app is quit from the tray, so the server has to close promptly or quitting
looks broken. Two things make that true:

- `forceCloseConnections` is on. A graceful close otherwise waits for in-flight
  requests, and a request mid-probe stays open for as long as `yt-dlp` takes, so
  `close()` never returned and every quit with work in flight ended in a forced
  exit. With it, `close()` settles in a few milliseconds and aborts the
  in-flight request cleanly.
- The window close button hides the app rather than quitting it, so a download
  is never killed by a stray click. Quitting with work in flight asks first.

`test/close.test.mjs` holds a request open with a half-sent HTTP request over a
raw socket and asserts `close()` still settles. That case is worth choosing
deliberately: the obvious test, using progress-stream clients, passes with or
without the fix and so proves nothing.

## Configuration

All optional, all read at startup.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BITRATE_HOST` | `127.0.0.1` | Bind address. Leave alone unless you intend to expose it. |
| `BITRATE_PORT` | `4820` | Port. |
| `BITRATE_DOWNLOAD_DIR` | `./downloads` | Where files land. Packaged desktop: `Videos/Bitrate`. |
| `BITRATE_DATA_DIR` | `./data` | Job history. Packaged desktop: user-data directory. |
| `BITRATE_VENV` | `./.venv` | Python environment holding yt-dlp. Read by the setup and doctor scripts. |
| `BITRATE_PYTHON` | `./.venv/.../python` | Explicit Python path. |
| `BITRATE_YTDLP` | `./.venv/.../yt-dlp` | Explicit yt-dlp path. |
| `BITRATE_CONCURRENCY` | `3` | Simultaneous downloads. |
| `BITRATE_FRAGMENTS` | `16` | Parallel segments per stream. |
| `BITRATE_FFMPEG` | `ffmpeg` | Path to ffmpeg. |
| `BITRATE_ARIA2C` | `aria2c` | Path to aria2c. |

## How output is named

`%(title).150B [%(id)s] [NN].%(ext)s`, with `NN` incrementing on repeat
downloads so a second copy does not overwrite the first.

Conversions (MP3, M4A, forced MP4) get an extra short token in the name.
That is deliberate: yt-dlp downloads an intermediate file, converts it, then
deletes the intermediate. Without the token, converting a video whose audio you
had already downloaded would delete that earlier file.

## Sites that need cookies

Some sites block unauthenticated requests. Export cookies from a logged-in
browser session to a `cookies.txt` file, then pass the path as `cookieFile` to
`POST /api/downloads`. Treat that file as a credential: it grants whatever
access your browser session has. It is gitignored.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Engine availability and current tuning. |
| `POST` | `/api/probe` | Read metadata and available formats for a link. |
| `POST` | `/api/downloads` | Queue a download. |
| `GET` | `/api/jobs` | All jobs, newest first. |
| `POST` | `/api/jobs/:id/cancel` | Stop a running or queued job. |
| `GET` | `/api/library` | List finished files. |
| `DELETE` | `/api/library/:name` | Delete a file. |
| `POST` | `/api/library/reveal` | Open the folder in Explorer (Windows). |
| `GET` | `/api/events` | Server-sent progress stream. |
| `POST` | `/api/scrape` | Extract fresh direct media links from a page yt-dlp cannot read. |

## Sites yt-dlp does not cover

Some sites (for example KVS-based video CMSs) defeat the generic extractor.
The flow for those is:

1. `POST /api/probe` fails with the extractor's reason.
2. The UI automatically calls `POST /api/scrape`, which reads the page as a
   browser would and returns its direct file links, highest quality first.
3. Picking one queues a direct job: 8 parallel `Range` segments written into
   a preallocated file, with per-segment retries. Cancel works mid-flight.

Direct jobs appear in the same queue, progress stream, and library as
everything else. Their filenames carry a short token because conversions
never apply to them and the name must not collide with yt-dlp output.

### Expiring links

On sites like the one above, the media URL carries a signed token that is only
valid for roughly twenty seconds. That is shorter than the time it takes to read
a panel and press a button, so a link captured when the panel is rendered is
usually already dead by the time it is used. Two things keep this invisible:

- The downloader re-reads the page for a fresh link when the transfer reports a
  dead one, both before it starts and part-way through a long transfer. The
  retry lands on the same quality that was chosen, and because each byte window
  records how far it got, a part-way retry resumes instead of starting over.
- Range support is confirmed before a file is split. A server that ignores
  `Range` answers every window with the whole file, so such a download is fetched
  as one sequential window rather than silently corrupted.

## Security posture

- Binds loopback by default. Do not change `BITRATE_HOST` without putting
  authentication in front of it: there is no login, and anyone who can reach
  the port can queue downloads and read every downloaded file.
- Cross-origin API requests are rejected, so a page in your browser cannot
  drive the server.
- Only `http` and `https` links are accepted. `file://` is refused, so it
  cannot be used to read local files.
- Media paths are resolved and confirmed to sit inside the download directory.
- Job history is capped at 200 entries.

## Scope

Bitrate is for content you are allowed to download. It does not bypass
DRM, paywalls, or account restrictions. Respect the terms of the sites you use
it with and the rights of the people whose work you are downloading.

## License

MIT. See [LICENSE](LICENSE).
