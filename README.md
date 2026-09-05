# Verified Video Demo

[View the live demo](https://guillaumemichel.github.io/veritiles-video-demo/).

This player streams Big Buck Bunny from a dumb static host over plain HTTP
range requests and cryptographically verifies every byte against a single
[veritiles](https://github.com/guillaumemichel/veritiles) anchor CID before
the decoder renders it. A second, deliberately tampered mirror is published
next to the honest one: route reads through it and watch the altered bytes
get caught, counted, and never rendered — playback fails over seamlessly.
The same page plays any file you pack yourself — see
[Play your own video](#play-your-own-video).

## How it works

- **Pack** — the fragmented MP4 is cut into 1 MiB leaves; their sha2-256
  digests are sharded into a tiny proof directory whose descriptor hashes to
  the anchor CID, the page's only trust input (`scripts/lib/pack-fixed.js`,
  the veritiles `fixed` profile).
- **Stream** — the player reads the first verified leaf, parses the file's
  global `sidx` (written by `ffmpeg -movflags +global_sidx`) and derives the
  MSE codecs string from its `moov`, then appends moof/mdat segments to Media
  Source Extensions with ~30 s of buffer ahead; seeking jumps the read cursor
  to the covering segment (`web/player.js`, `web/mp4.js`).
- **Verify** — every read goes through the released `veritiles` client
  (`VerifiedFile`), which fetches only the proof pieces covering the read and
  verifies each leaf before use. A source whose bytes fail verification is
  banned for the session and the next source takes over.
- **Select** — a source is an anchor CID plus a video URL; its proofs are
  read from `<url>.proofs/`. The page offers built-in presets and a custom
  form, and mirrors the active source in `?cid=<anchor>&src=<url>` so any
  source is a shareable link (`web/app.js`).

## Published layout

`dist/` is the entire deployment:

```text
bbb.mp4                  # fragmented MP4, H.264 + AAC, global sidx
bbb.mp4.proofs/          # descriptor (`root`) and leaf-digest shard
evil/bbb.mp4             # the malicious mirror: one flipped byte per leaf
vendor/veritiles.js      # the released client, unmodified
web/mp4.js               # sidx and codecs reader
web/player.js            # MSE player
web/app.js               # page controller: presets, ?cid&src, tamper toggle
index.html
```

Only source is committed. CI downloads the video from the Blender mirror,
remuxes it (H.264 copied, stereo track re-encoded to AAC, AC-3 dropped),
packs it, injects the freshly computed anchor into the page, and reads the
site back through the released client — honest path and tampered-first
failover both — before deploying.

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

## Local development

```sh
npm install
npm test                # packer + mp4 reader unit tests, no video needed
npm run prepare-video   # downloads + remuxes into data/ (needs ffmpeg, unzip)
npm run build           # packs and assembles dist/, then verifies it
npm run serve           # dumb host with single-Range 206 at :8080
npm run test:browser    # headless Chromium: playback, tamper failover, seek
```

## Licenses

Code is [MIT](./LICENSE). Big Buck Bunny is © 2008 Blender Foundation /
[bigbuckbunny.org](https://peach.blender.org/), licensed
[CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/); the deployment
redistributes a remux (container change, AC-3 track dropped) and a
deliberately corrupted copy used to demonstrate tamper detection.
