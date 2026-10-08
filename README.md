# Verified Video Demo

[View the live demo](https://guillaumemichel.github.io/veritiles-video-demo/).

This player streams Big Buck Bunny from a dumb static host over plain HTTP
range requests and cryptographically verifies every byte against a single
[veritiles](https://github.com/guillaumemichel/veritiles) anchor CID before
the decoder renders it. A second, deliberately tampered mirror is published
next to the honest one: route reads through it and watch the altered bytes
get caught, counted, and never rendered — playback fails over seamlessly.
The same page plays any file you pack yourself — see
[Play your own video](#play-your-own-video) — and the pristine video and
audio tracks YouTube serves for a video, pinned by anchors anyone can
re-derive from the YouTube URL — see
[YouTube as an untrusted source](#youtube-as-an-untrusted-source).

## How it works

- **Pack** — a fragmented MP4 is cut into 1 MiB leaves; their sha2-256
  digests are sharded into a tiny proof directory whose descriptor hashes to
  the anchor CID, the page's only trust input (`scripts/lib/pack-fixed.js`,
  the veritiles `fixed` profile).
- **Stream** — per track the player reads the first verified leaf, parses
  the file's global `sidx` (written by `ffmpeg -movflags +global_sidx`, and
  by YouTube's packager) and derives the MSE codecs string from its `moov`,
  then appends moof/mdat segments to its own SourceBuffer with ~30 s of
  buffer ahead; seeking jumps every read cursor to the covering segment
  (`web/player.js`, `web/mp4.js`).
- **Verify** — every read goes through the released `veritiles` client
  (`VerifiedFile`), which fetches only the proof pieces covering the read and
  verifies each leaf before use. A source whose bytes fail verification is
  banned for the session and the next source takes over.
- **Select** — a source is one or more tracks, each an anchor CID plus a
  URL whose proofs sit at `<url>.proofs/`: a muxed file is one track, a
  YouTube video is its video itag plus its audio itag. The page offers
  built-in presets and a custom form (one CID and one URL per track,
  whitespace-separated), and mirrors the active source in repeated
  `?cid=<anchor>&src=<url>` pairs so any source is a shareable link
  (`web/app.js`).

## Published layout

`dist/` is the entire deployment:

```text
bbb.mp4                           # fragmented MP4, H.264 + AAC, global sidx
bbb.mp4.proofs/                   # descriptor (`root`) and leaf-digest shard
evil/bbb.mp4                      # the malicious mirror: one flipped byte per leaf
yt/<videoId>/itag136.mp4          # a pristine YouTube track, exactly as served
yt/<videoId>/itag136.mp4.proofs/
yt/<videoId>/itag140.mp4          # …its audio track, and (smallest track only)
yt/<videoId>/evil/itag140.mp4     # its malicious mirror
vendor/veritiles.js               # the released client, unmodified
web/mp4.js                        # sidx and codecs reader
web/player.js                     # MSE player, one SourceBuffer per track
web/app.js                        # page controller: presets, ?cid&src, tamper toggle, YouTube panel
index.html
```

Only source is committed. CI downloads the video from the Blender mirror,
remuxes it (H.264 copied, stereo track re-encoded to AAC, AC-3 dropped),
fetches the YouTube tracks `yt-index.json` names from their mirrors and
checks them against the digests the index commits to, packs everything,
injects the freshly computed anchors into the page, and reads the site back
through the released client — honest reads for every track, tampered-first
failover for every track that has a malicious mirror — before deploying.

## Play your own video

1. Remux to a fragmented MP4, H.264 + AAC, with the global `sidx` up front —
   the flags `scripts/prepare-video.mjs` uses (`-c:v libx264` instead of
   `copy` if the source isn't H.264 already):

   ```sh
   ffmpeg -i source.mp4 -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 128k \
     -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx \
     -min_frag_duration 2000000 video.mp4
   ```

2. Pack it with the veritiles repository packer (a development tool, not on
   npm yet). It prints the anchor CID and writes `video.mp4.proofs/`:

   ```sh
   git clone https://github.com/guillaumemichel/veritiles && cd veritiles
   npm ci
   npm run pack -- /path/to/video.mp4 --profile fixed
   ```

3. Host `video.mp4` and `video.mp4.proofs/` side by side on any static host
   that answers single `Range` requests with 206 and sends
   `Access-Control-Allow-Origin: *` — GitHub Pages does both.

4. Open the demo with both values, or paste them into the form on the page:

   ```text
   https://guillaumemichel.github.io/veritiles-video-demo/?cid=<anchor>&src=<url>
   ```

Constraints: fragmented MP4 with the global `sidx` within the first 8 MiB;
H.264 + AAC only (`avc1`/`avc3` + `mp4a.40`); proofs beside the file at
`<url>.proofs/`; video URLs with a query string or fragment are unsupported.
Separate video-only and audio-only tracks work as one source: give the form
one CID and one URL per track.

## YouTube as an untrusted source

The identity of a YouTube video, pinned by CIDs anyone can re-derive from
the YouTube URL; the pristine bytes streamed verified from dumb hosting;
and YouTube itself spot-checked as an untrusted range server.
A proof of concept for clients like NewPipe that would rather have more
than one source for the same video — Creative Commons and own uploads only;
the licence is recorded per entry.

- **Pristine tracks.** `yt-dlp -f 136 --fixup never` saves exactly the
  bytes YouTube serves for an itag: a fragmented MP4 with a global `sidx`,
  MSE-ready, no ffmpeg anywhere in the pipeline. Any yt-dlp version is
  expected to reproduce the same file — the ingest refuses to record an
  anchor unless two downloads agree, and `--ignore-config` keeps an
  operator's own yt-dlp settings out of the bytes — so the anchor is
  tool-independent. A video is its video itag plus its audio itag — two
  tracks in the player.
- **Ingest** — `npm run yt-ingest -- <videoId> [--itags 136,140]` takes
  the tallest H.264 track and the AAC audio unless told otherwise,
  downloads each twice and stops unless both are identical, packs each
  beside its file in `data/yt/<id>/`, and records anchors, digests, codecs,
  the exact recipe and the tool version in `yt-index.json`. Without
  `--license`, YouTube's own licence field must say Creative Commons; with
  `--license <spdx>` you assert the licence yourself — only when the rights
  holder grants it elsewhere (Blender's upload states CC-BY in its
  description but left YouTube's licence option at the default) or it is
  your own upload. The index records both. Needs `yt-dlp`
  (`uv tool install yt-dlp` or pip; node serves as its JS runtime) and a
  residential connection — YouTube bot-checks datacenter egress,
  which is why CI never runs it. Behind such an egress,
  `YT_DLP_ARGS='--proxy socks5://…'` is added to every yt-dlp call; it
  never enters the recorded recipe. Cookie flags there are refused, by
  ingest and watchtower alike: a signed-in run would tie it to a Google
  account. The index records the day of the ingest, not the time.
- **The index** — `yt-index.json` is the trusted naming layer and is
  committed: a reader trusts the commit, and can check it by running the
  recipe the page shows. Mirrors listed per track are locations only —
  every byte from them is verified against the anchor.
- **Hosting** — tracks are too large for git. Publish them as a GitHub
  release (`gh release create yt-<id> data/yt/<id>/itag*.mp4`, the command
  ingest prints) and CI fetches them from there; `--mirror <url base>` at
  ingest records any other host instead. A re-encode on YouTube's side
  yields a new generation and release (`yt-<id>-g2`), never a rewrite of
  the old anchors.
- **The watchtower** — `npm run watchtower` resolves a fresh delivery URL
  per track through yt-dlp, reads three random mid-file leaves through the
  verified client with YouTube as the only source and the anchor as the only
  trust input, and prints what it saw. It records nothing: anyone can run it
  to check the index against what YouTube serves today. Run it from a
  residential connection; datacenter egress shows up as `unavailable`,
  never as a mismatch. A mismatch means YouTube now serves other bytes —
  re-ingest to record a new generation. Exit 0 when every probe matched or
  was unavailable, 2 on a mismatch, 1 when it could not run.
  `--source-base <url>` runs the same machinery against a served `dist/` as
  a mock YouTube.
- **Verified streaming from YouTube** — `npm run watchtower -- --stream
  <id>:<itag> | mpv -` reads the leaves in order instead of at random: a
  CLI that streams and byte-verifies a track from YouTube itself.

**In the browser.** A page cannot verify against YouTube directly:
googlevideo opens CORS to youtube.com only (a cross-origin preflight for
`Range` is answered 400), workers share the page's origin, `no-cors`
responses are opaque, and a googlevideo URL is signed for the resolving IP
anyway. A browser extension or a native client (NewPipe) has no such limit
and can run the watchtower's check with the same anchors.

## Local development

```sh
npm install
npm test                # unit tests (packer, mp4 reader, player, page, ingest, watchtower) and an IP-address
                        # scan of every publishable file — no video needed
npm run prepare-video   # downloads + remuxes into data/, fetches indexed YouTube tracks (ffmpeg, unzip)
npm run build           # packs and assembles dist/, then verifies it
npm run serve           # dumb host with single-Range 206 at :8080
npm run test:browser    # headless Chromium: playback, tamper failover, seek, a video+audio track pair
                        # (splits data/bbb.mp4 with ffmpeg into data/split/ on first run)
npm run yt-ingest -- <videoId>   # pristine tracks + anchors into yt-index.json
npm run watchtower      # spot-check YouTube against the index; --stream <id>:<itag> to play from it
```

Dry run of the whole YouTube path without YouTube, with a stand-in `yt-dlp`
that "downloads" the split Big Buck Bunny tracks and a served `dist/` as
YouTube — the browser check must have run once so `data/split/` exists:

```sh
YT_DLP=test/lib/yt-dlp-stub.mjs npm run yt-ingest -- splitfixtur
npm run build
npm run serve &
npm run test:browser    # now also exercises the YouTube preset and a tampered track
YT_DLP=test/lib/yt-dlp-stub.mjs npm run watchtower -- --video splitfixtur
git checkout -- yt-index.json && rm -rf data/yt/splitfixtur   # back to the committed index
```

## Licenses

Code is [MIT](./LICENSE). Big Buck Bunny is © 2008 Blender Foundation /
[bigbuckbunny.org](https://peach.blender.org/), licensed
[CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/); the deployment
redistributes a remux (container change, AC-3 track dropped), a
deliberately corrupted copy used to demonstrate tamper detection, and — once
ingested — the Blender Foundation's own YouTube upload of the film, served
byte for byte as YouTube serves it, with its licence recorded in
`yt-index.json`.
