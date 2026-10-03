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
| aria2c when installed | Hands the transfer to a multi-connection downloader, so a throttling origin gets several times the throughput of one connection. Measured at **5.8x** on a 48 MB file against an origin capping each connection at 6 MB/s (`npm run bench:aria2`). Optional. |
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

The figure above is a local measurement, not a promise about any one site. It
comes from `npm run bench:aria2`, which serves the file from a loopback origin
that caps each connection separately the way a CDN does. A loopback server with
no cap would show nothing, since there is no headroom for extra connections to
win. What the number shows is that extra connections buy real throughput against
an origin that throttles; how much depends on the origin, and against a host
that does not throttle you would see very little.

```
48 MB file, origin capped at 6 MB/s per connection, median of 3

  yt-dlp alone    11.17s   4.3 MB/s    2 connections
  with aria2c      1.94s  24.8 MB/s   16 connections
  speedup          5.76x
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
and wiring, the yt-dlp engine's pure decisions, that shutting the server down
stays prompt, that a dead link resumes rather than restarts, and — for the parts
where a bug produces plausible-looking output rather than an error — that the
download engine cannot be fooled into writing the wrong bytes:

| Suite | Covers |
| --- | --- |
| `security.test.mjs` | Address classification including the IPv6 spellings, redirect SSRF, scraped-media filtering, path traversal, symlinks, cookie validation, `206` integrity, body size ceilings, and the counters |
| `auth.test.mjs` | That a non-loopback bind without a token will not start, and that a configured token is enforced — each case in its own process, because that is the only way to test a startup check |
| `recovery.test.mjs` | Concurrent jobs cannot claim each other's files, interrupted jobs keep their bytes, promotion into the library |
| `stress.test.mjs` | That the concurrency gates, request budgets, queue ceiling and event-stream ceiling hold |
| `idm.test.mjs` | That the CLI wrapper downloads correctly, and inherits the same network policy |
| `egress.test.mjs` | That the proxy yt-dlp is bound to resolves and checks every hop, including `CONNECT`, and that nothing smuggles past it |
| `token.test.mjs`, `token-live.test.mjs` | That the UI's surfaces which cannot set a header still carry a token, and that none of them works without one |
| `leak.test.mjs` | That no cookie path or signed media URL reaches disk or a response |
| `manifest.test.mjs` | That a playlist is never offered to the byte-range engine, refused if one arrives anyway, and never saved |
| `cancel.test.mjs` | That a cancelled download keeps its bytes, that `recoverable` says so honestly in both directions, and that a failure still cleans up |

The 206 cases are the ones worth reading. Each fixture lies in a different way —
claims the wrong window, streams past the end of one, declares a length that is
not the window, or closes the body early — and each has to be refused, because a
file of exactly the right length containing the wrong bytes is the failure mode
nothing downstream can catch.

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
| `BITRATE_HOST` | `127.0.0.1` | Bind address. Changing this requires `BITRATE_AUTH_TOKEN`; see below. |
| `BITRATE_PORT` | `4820` | Port. |
| `BITRATE_AUTH_TOKEN` | *(none)* | Bearer token required on every `/api` request. |
| `BITRATE_NETWORK_POLICY` | `lan` | Which addresses outbound requests may reach. See below. |
| `BITRATE_DOWNLOAD_DIR` | `./downloads` | Where files land. Packaged desktop: `Videos/Bitrate`. |
| `BITRATE_DATA_DIR` | `./data` | Job history and per-job workspaces. Packaged desktop: user-data directory. |
| `BITRATE_VENV` | `./.venv` | Python environment holding yt-dlp. Read by the setup and doctor scripts. |
| `BITRATE_PYTHON` | `./.venv/.../python` | Explicit Python path. |
| `BITRATE_YTDLP` | `./.venv/.../yt-dlp` | Explicit yt-dlp path. |
| `BITRATE_CONCURRENCY` | `3` | Simultaneous downloads. |
| `BITRATE_FRAGMENTS` | `16` | Parallel segments per stream. |
| `BITRATE_FFMPEG` | `ffmpeg` | Path to ffmpeg. |
| `BITRATE_ARIA2C` | `aria2c` | Path to aria2c. |

### Resource budgets

Every one of these is a separate way a single request becomes a large amount of
work, so each has its own ceiling rather than sharing the download concurrency
limit. `npm run doctor` prints the values actually in force.

| Variable | Default | Bounds |
| --- | --- | --- |
| `BITRATE_MAX_QUEUE_SIZE` | `200` | Jobs running plus queued. |
| `BITRATE_MAX_PROBES` | `2` | Concurrent yt-dlp metadata extractions. |
| `BITRATE_MAX_SCRAPES` | `4` | Concurrent page scrapes. |
| `BITRATE_MAX_SCRAPE_BYTES` | `8 MB` | Page body read into memory. |
| `BITRATE_MAX_DOWNLOAD_BYTES` | `64 GB` | Size a direct download will accept. |
| `BITRATE_MAX_SSE_CLIENTS` | `8` | Open progress streams. |
| `BITRATE_PROBE_TIMEOUT_MS` | `90000` | Wall clock for one extraction. |
| `BITRATE_SCRAPE_TIMEOUT_MS` | `25000` | Wall clock for one scrape. |
| `BITRATE_STALL_MS` | `60000` | Time a transfer may make no progress. |
| `BITRATE_RATE_*` | see `config.js` | Requests per minute, per route class. |

The stall timeout is not a request timeout. A 4 GB file legitimately outlives any
whole-request budget, and a stalled socket is otherwise indistinguishable from a
slow one until the job has shown "downloading" at 0 bytes/s for an hour. It is
measured per chunk, so a transfer that is still moving is never touched.

## How output is named

`%(title).150B [%(id)s] [NN].%(ext)s`, with `NN` incrementing on repeat
downloads so a second copy does not overwrite the first.

Conversions (MP3, M4A, forced MP4) get an extra short token in the name.
That is deliberate: yt-dlp downloads an intermediate file, converts it, then
deletes the intermediate. Without the token, converting a video whose audio you
had already downloaded would delete that earlier file.

### Where a file is built

Each job gets its own directory under `data/jobs/<job-id>/`. The download is
built there and moved into the download directory only once it is verified
complete. Two things follow from that:

- A finished job's artifact is identified inside a directory nothing else is
  writing to, rather than guessed at by comparing timestamps in a directory
  several jobs share. Two downloads finishing in the same second used to be
  indistinguishable, and the loser could be reported as having produced the
  winner's file.
- An interrupted or cancelled job leaves its partial file behind, so a restart has
  something to resume from instead of nothing.
- `recoverable` is set from whether bytes were actually kept, not from whether a
  job happened to be running. A cancelled download that had moved megabytes keeps
  its `.part` and is resumable; one cancelled in its first moments has a
  preallocated-but-empty file, which is deleted rather than advertised as a resume
  opportunity that would re-download everything. A job that genuinely failed deletes
  its partial too, since a dead link is not worth resuming.

`data/jobs/` can be deleted at any time; the only thing lost is unfinished work.

## Sites that need cookies

Some sites block unauthenticated requests. Export cookies from a logged-in
browser session to a `cookies.txt` file, then pass the path as `cookies` to
`POST /api/downloads`. Treat that file as a credential: it grants whatever access
your browser session has. It is gitignored, and the path never appears in job
state, traces or logs.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Engine availability, tuning, network policy and every limit in force. |
| `GET` | `/api/metrics` | Counters for what has succeeded, failed or been refused. |
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
   a preallocated file, with per-segment retries. Cancel works mid-flight and keeps
   whatever had already been written.

Direct jobs appear in the same queue, progress stream, and library as
everything else. Their filenames carry a short token because conversions
never apply to them and the name must not collide with yt-dlp output.

#### HLS is not offered here, on purpose

A `.m3u8` or `.mpd` is a playlist — a text file listing other URLs — and a
byte-range downloader cannot fetch one. The direct engine probes for a length,
plans windows across the body and writes them to disk; none of that means
anything for a document whose content is a list of links to fetch next.

So a page offering only HLS gets a `422` explaining that, and a page offering both
offers only the file. The engine also refuses a manifest outright, as a backstop for
a URL arriving by some other route.

This matters because the alternative is worse than an error. A CDN serving a
playlist with an honest `Content-Length` makes the download *succeed*, and a few
kilobytes of playlist text land in the library under a video name, where nothing
downstream can tell them from a broken video.

These links are not useless, just not to this engine. Paste the page URL as a
normal download and yt-dlp resolves the manifest, fetches the segments and hands
them to ffmpeg.

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

### Where outbound requests are allowed to go

Every request the server makes on your behalf — the scraper, the size probe, each
range window, the media URLs pulled out of a page, and every request yt-dlp makes
— goes through one policy layer (`server/network-policy.js`) and one transport
(`server/http-client.js`). The order is the point:

```
parse → resolve DNS → refuse a blocked address → connect to that exact address
      → on a redirect, resolve and check again for the new hop → read the body
```

Checking the URL you pasted is not enough, for two reasons that are easy to miss.
A hostname can resolve to an address you did not intend, and a URL that looks
entirely innocent can answer `302` to somewhere that is not. So redirects are
followed one hop at a time and each hop is resolved and approved on its own terms.
A public page that lists `http://127.0.0.1/` among its media links is treated as
an attempt to aim the downloader, not as a page with an unusual link on it.

And the address that was approved is the address that is connected to. The
approved list is handed to the socket layer as its resolver, so no second lookup
ever happens: a name that answers public once and private a moment later cannot
get a different answer, because nothing asks it again. (`fetch` cannot be used
here — it resolves the hostname itself and offers no way to supply a resolver or
a pinned dispatcher, which is exactly the gap this closes. `node:http` does take
a `lookup`, and `Readable.toWeb` gives back a standard stream, so the bodies are
still read with `getReader()` as before.)

### yt-dlp is inside the policy, not merely checked against it

yt-dlp is a child process with its own HTTP client, its own DNS and its own
redirect handling. Checking a URL in the API handler before spawning it looks like
a policy and is not one: it describes the request the caller asked for, while the
requests yt-dlp actually makes include every redirect hop, every media segment and
every endpoint the site decides to call. An innocent-looking pasted URL that answers
`302` to `169.254.169.254` reaches the metadata service exactly as surely as asking
for it directly would, and validating the entry URL changes nothing about that.

So yt-dlp is given `--proxy` pointing at a local filtering proxy
(`server/egress-proxy.js`), and that proxy is the only route out. Each request it
forwards has its destination resolved, classified, and pinned to the very addresses
the policy approved — including `CONNECT`, so a TLS destination is approved before
its tunnel exists. A hop to a refused address fails there and then, mid-chain, which
is the only place a redirect-aware check can act. aria2c gets the same flag, since it
opens its own connections.

A refusal is returned to the child as a `403` with the reason in the body, so a
blocked destination reads as "that address is not allowed" rather than as a
connection failure. Set `BITRATE_NETWORK_POLICY=open` to disable the filtering; the
proxy still runs.

Blocked in every mode: link-local and `169.254.169.254` (cloud instance
metadata), carrier-grade NAT, multicast, reserved and unspecified addresses, and
their IPv4-mapped IPv6 spellings — `::ffff:127.0.0.1` is a loopback address
wearing a hat. A name resolving to both a public and a blocked address is
refused, because none of its answers may be blocked.

| `BITRATE_NETWORK_POLICY` | Loopback | RFC1918 | Everything above |
| --- | --- | --- | --- |
| `lan` *(default)* | allowed | allowed | link-local and friends refused |
| `strict` | refused | refused | public only |
| `open` | allowed | allowed | nothing refused |

`lan` is the default because a downloader legitimately targets those ranges: a
NAS, a local media server, a dev server on your own machine. Use `strict` if you
only ever download from the public internet. `open` disables the filter entirely
and `npm run doctor` will warn about it.

The current policy is reported by `GET /api/health`, so a deployment never has to
be asked which one it is running.

### Exposing it beyond this machine

Binding to anything other than loopback **without** `BITRATE_AUTH_TOKEN` is a
startup error, not a warning:

```
$ BITRATE_HOST=0.0.0.0 npm start
Refusing to bind 0.0.0.0: that is reachable from the network and this API has no
authentication. Set BITRATE_AUTH_TOKEN to a long random string, or bind to
127.0.0.1 to keep it local.
```

The insecure configuration is not reachable by accident; you have to ask for it
by name. With a token set, every `/api` request needs
`Authorization: Bearer <token>`. `?access_token=` is also accepted, because
EventSource and `<video>` cannot set headers — which means the query form will
end up in logs and history, so put TLS in front of it if the port is reachable
beyond your own machine.

#### The UI carries the token too

A configured token that the bundled UI does not send turns the app into something
that looks like a disconnected server rather than an authentication failure, and
that is a confusing way to discover a security feature. So the client sends it:

- Ordinary requests use the `X-Bitrate-Token` header. A header beats a query
  parameter because a query string lands in proxy logs and browser history, and this
  one is a full-control credential.
- The three surfaces that cannot set a header — the SSE progress stream, the media
  preview and a download link — append `?access_token=`, which the server accepts
  for exactly that reason.

In the desktop app the shell hands the token to the page through a preload bridge
(`desktop/preload.cjs`). That bridge is deliberately tiny: it reads one value from
the environment, exposes it, and opens no IPC channel, because a preload with a
message channel invites more messages later. It is `.cjs` rather than `.js` because
a sandboxed preload runs without Node's module loader.

Serving the UI from a browser rather than the shell works too: open
`http://127.0.0.1:4820/#token=<token>`. A fragment rather than a query parameter,
because a fragment is never sent to the server and never appears in a `Referer`
header.

### Everything else

- Cross-origin API requests are rejected, so a page in your browser cannot drive
  the server. This is the check that actually stops the realistic attack: a
  drive-by page arriving as ordinary same-machine traffic is indistinguishable
  from the app itself by address alone.
- Only `http` and `https` links are accepted, and a URL carrying `user:pass@` is
  refused because those credentials end up in process arguments.
- Media paths are resolved twice — lexically, then through `realpath` — so
  neither `../` nor a symlink planted in the download directory can read or delete
  a file outside it. Symlinks are not listed, streamed or revealed.
- Cookie files are validated as regular non-symlink files, refused inside the
  download or data directory, and never written into job state, traces, events or
  log lines. A job record says *whether* cookies were used, never where from.
- Nothing is persisted because it happened to be on the job object. `jobs.json` is
  written from an explicit allowlist, so a field added later is not persisted by
  default and cannot be forgotten into a file that outlives the process.
- A signed media URL is not returned by the API. For a direct download the query
  string is a credential that authorises a download while it is valid, and the job
  list has no use for it: `GET /api/jobs` reports the **host** instead, which is
  enough to show which site a job came from and useless to anyone replaying it. The
  same shape goes to `POST /api/downloads` and to the event stream, since all three
  are `publicJob`.
- A `206` is a claim, not a guarantee. The requested start offset, the declared
  window and the actual byte count are all verified, because a CDN that answers
  the wrong window produces a file of exactly the right length containing the
  wrong bytes, which nothing downstream can detect.
- `ETag`/`Last-Modified` are sent as `If-Range` on a resumed window, so an origin
  that swaps the file mid-transfer causes a clean restart instead of two versions
  spliced together.
- `spawn()` is used with argument arrays throughout, yt-dlp runs with
  `--ignore-config`, and an output path is only trusted after being confirmed to
  sit inside the job's own workspace.

### When something does go wrong

`GET /api/metrics` reports counters, each carrying its own description, so
"why did that fail?" is a lookup rather than a log-reading exercise:

```
download_started / completed / failed / cancelled / refreshed / restarted
bytes_transferred · probe_failed · scrape_failed · request_refused
ssrf_blocked · range_rejected
```

A blocked address is counted separately from a failed probe, because a policy
decision and a broken website are different problems and should not look the
same in a graph. Counters are in memory and reset on restart.

## Scope

Bitrate is for content you are allowed to download. It does not bypass
DRM, paywalls, or account restrictions. Respect the terms of the sites you use
it with and the rights of the people whose work you are downloading.

## License

MIT. See [LICENSE](LICENSE).
