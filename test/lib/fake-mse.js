// Just enough Media Source Extensions for web/player.js under node. The
// fixtures' media bytes are pseudo-random, so nothing decodes them: the
// test's `describe(mime, bytes) → { label, start?, end? }` names each append
// and the time span it buffers. Appends and removals land one task later
// (updating → updateend), as in a browser.

// Node's EventTarget holds a `signal` removal weakly, one per target: when
// two listeners share a signal, a GC can drop the first removal and that
// listener outlives the abort. Hold removals strongly.
class Target extends EventTarget {
  addEventListener(type, listener, { signal, ...options } = {}) {
    if (signal?.aborted) return;
    super.addEventListener(type, listener, options);
    signal?.addEventListener('abort', () => this.removeEventListener(type, listener, options), { once: true });
  }
}

// Installs MediaSource and URL.create/revokeObjectURL until restore().
export function fakeMse(describe) {
  const log = []; // labels of what the player handed to appendBuffer, and 'end'
  const attached = new Map(); // object URL → MediaSource
  const revoked = [];
  const buffers = [];

  class SourceBuffer extends Target {
    updating = false;
    #spans = [];
    #landing = null;

    constructor(mime) { super(); this.mime = mime; }

    get buffered() {
      const ranges = [];
      for (const [start, end] of [...this.#spans].sort((a, b) => a[0] - b[0])) {
        const last = ranges.at(-1);
        if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
        else ranges.push([start, end]);
      }
      return { length: ranges.length, start: (i) => ranges[i][0], end: (i) => ranges[i][1] };
    }

    appendBuffer(bytes) {
      const { label, start, end } = describe(this.mime, bytes);
      this.#update(() => { if (start !== undefined) this.#spans.push([start, end]); });
      log.push(label);
    }

    remove(start, end) {
      this.#update(() => { this.#spans = this.#spans.filter(([s, e]) => s < start || e > end); });
    }

    abort() {
      if (!this.updating) return;
      clearImmediate(this.#landing);
      this.#landed();
    }

    #update(apply) {
      if (this.updating) throw new DOMException('still updating', 'InvalidStateError');
      this.updating = true;
      this.#landing = setImmediate(() => { apply(); this.#landed(); });
    }

    #landed() {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    }
  }

  class MediaSource extends Target {
    static isTypeSupported = () => true;
    readyState = 'closed';
    duration = NaN;

    addSourceBuffer(mime) {
      buffers.push(new SourceBuffer(mime));
      return buffers.at(-1);
    }

    endOfStream() {
      if (this.readyState !== 'open' || buffers.some((sb) => sb.updating)) {
        throw new DOMException('cannot end now', 'InvalidStateError');
      }
      this.readyState = 'ended';
      log.push('end');
    }
  }

  // attach: false is an element that never gets around to opening the source.
  class Video extends Target {
    currentTime = 0;
    loads = 0;
    #src = '';

    constructor({ attach = true } = {}) { super(); this.attach = attach; }

    get src() { return this.#src; }

    set src(url) {
      this.#src = url;
      const ms = attached.get(url);
      if (ms === undefined || !this.attach) return;
      setImmediate(() => {
        ms.readyState = 'open';
        ms.dispatchEvent(new Event('sourceopen'));
      });
    }

    removeAttribute(name) { if (name === 'src') this.#src = ''; }
    load() { this.loads += 1; }
  }

  const saved = { MediaSource: globalThis.MediaSource, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.MediaSource = MediaSource;
  URL.createObjectURL = (ms) => {
    const url = `blob:fake/${attached.size}`;
    attached.set(url, ms);
    return url;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  const restore = () => {
    globalThis.MediaSource = saved.MediaSource;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  };
  const updating = () => buffers.some((sb) => sb.updating);
  return { log, attached, revoked, buffers, updating, restore, video: (options) => new Video(options) };
}
