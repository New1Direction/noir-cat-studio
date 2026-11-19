/** A browser-readable failure that the studio can display next to the record button. */
export class ReadableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ReadableError';
  }
}

const MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
];

function aborted() {
  return new DOMException('Recording cancelled.', 'AbortError');
}

/**
 * Record one motion cycle, without HTML controls or audio.
 * frameRect is { x, y, width, height } in source-canvas CSS pixels. A source
 * duration of four seconds at speed 2 creates a two-second video.
 * setTime and render are synchronous, so every copied frame uses its sought pose.
 */
export async function recordMotionClip({
  sourceCanvas, frameRect, pixelRatio = 1, width, height, duration, speed = 1,
  background = '#eeece6', setTime, render, onProgress, signal,
}) {
  if (signal?.aborted) throw aborted();
  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined'
    || typeof HTMLCanvasElement === 'undefined'
    || !HTMLCanvasElement.prototype.captureStream) {
    throw new ReadableError('Video export is unavailable in this browser. Try a current Chrome, Edge, or Safari.');
  }
  const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
    ? MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type)) : undefined;
  if (!mimeType) throw new ReadableError('This browser cannot encode a supported video format.');
  if (!sourceCanvas?.width || !sourceCanvas?.height || !frameRect
    || typeof setTime !== 'function' || typeof render !== 'function') {
    throw new ReadableError('The 3D view is not ready to record.');
  }
  if (![duration, speed, pixelRatio].every(value => Number.isFinite(value) && value > 0)) {
    throw new ReadableError('Choose a motion and a valid playback speed before recording.');
  }
  const crop = {
    x: (frameRect.x ?? frameRect.left ?? 0) * pixelRatio,
    y: (frameRect.y ?? frameRect.top ?? 0) * pixelRatio,
    width: frameRect.width * pixelRatio,
    height: frameRect.height * pixelRatio,
  };
  if (!Object.values(crop).every(Number.isFinite) || crop.x < 0 || crop.y < 0
    || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > sourceCanvas.width + 1
    || crop.y + crop.height > sourceCanvas.height + 1) {
    throw new ReadableError('The selected camera frame is outside the 3D view.');
  }
  const outputWidth = width ?? frameRect.width;
  const outputHeight = height ?? frameRect.height;
  if (![outputWidth, outputHeight].every(value => Number.isFinite(value) && value >= 2 && value <= 4096)) {
    throw new ReadableError('Choose a video size between 2 and 4096 pixels.');
  }
  const canvas = document.createElement('canvas');
  // Even dimensions also work with the MP4/H.264 fallback.
  canvas.width = Math.max(2, Math.round(outputWidth / 2) * 2);
  canvas.height = Math.max(2, Math.round(outputHeight / 2) * 2);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new ReadableError('The browser could not prepare the video canvas.');
  const wallDuration = duration / speed;
  const finalTime = Math.max(0, duration - 0.00001);
  const paint = seconds => {
    setTime(Math.min(seconds, finalTime));
    render();
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height,
      0, 0, canvas.width, canvas.height);
  };

  let stream;
  let recorder;
  try {
    paint(0);
    stream = canvas.captureStream(30);
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: Math.min(20_000_000, Math.max(3_000_000, canvas.width * canvas.height * 6)),
    });
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    throw new ReadableError('The browser could not start recording this view.', { cause: error });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    const track = stream.getVideoTracks()[0];
    let raf = 0;
    let deadline = 0;
    let startDeadline = 0;
    let stopDeadline = 0;
    let started = 0;
    let finishing = false;
    let settled = false;
    const cleanup = () => {
      cancelAnimationFrame(raf);
      clearTimeout(deadline);
      clearTimeout(startDeadline);
      clearTimeout(stopDeadline);
      signal?.removeEventListener('abort', cancel);
      recorder.onstart = recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* Already stopped by the browser. */ }
      }
      stream.getTracks().forEach(item => item.stop());
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => fail(aborted());
    const stop = () => {
      if (finishing || settled) return;
      finishing = true;
      cancelAnimationFrame(raf);
      clearTimeout(deadline);
      try {
        paint(finalTime);
        track?.requestFrame?.();
        onProgress?.(1);
        if (settled) return;
        if (recorder.state === 'inactive') {
          fail(new ReadableError('The browser stopped recording before the clip was complete.'));
        } else {
          stopDeadline = setTimeout(() => fail(new ReadableError('The video encoder did not finish. Please try again.')), 5000);
          recorder.stop();
        }
      } catch (error) {
        fail(new ReadableError('The video could not be completed.', { cause: error }));
      }
    };
    const tick = now => {
      if (settled || finishing) return;
      const elapsed = Math.max(0, (now - started) / 1000);
      if (elapsed >= wallDuration) { stop(); return; }
      try {
        paint(elapsed * speed);
        onProgress?.(Math.min(1, elapsed / wallDuration));
        if (settled) return;
        raf = requestAnimationFrame(tick);
      } catch (error) {
        fail(new ReadableError('The 3D view could not be recorded.', { cause: error }));
      }
    };
    recorder.ondataavailable = event => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.onerror = event => fail(new ReadableError('The browser could not encode the video.', { cause: event.error }));
    recorder.onstop = async () => {
      if (settled) return;
      clearTimeout(stopDeadline);
      if (!finishing) {
        fail(new ReadableError('The browser stopped recording before the clip was complete.'));
        return;
      }
      try {
        let blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        if (!blob.size) throw new ReadableError('The browser recorded an empty video. Please try again.');
        // Streaming WebM normally omits duration. Add it before handing the file
        // to an editor, so the saved clip has a finite, seekable duration.
        if (blob.type.includes('webm')) blob = await finalizeWebMDuration(blob, wallDuration);
        if (signal?.aborted) { fail(aborted()); return; }
        if (settled) return;
        settled = true;
        cleanup();
        resolve(blob);
      } catch (error) {
        fail(error instanceof ReadableError ? error
          : new ReadableError('The video file could not be finalized.', { cause: error }));
      }
    };
    recorder.onstart = () => {
      clearTimeout(startDeadline);
      if (settled) return;
      started = performance.now();
      try {
        onProgress?.(0);
        if (settled) return;
        raf = requestAnimationFrame(tick);
        // Stop even if the browser throttles requestAnimationFrame in a hidden tab.
        deadline = setTimeout(stop, wallDuration * 1000 + 50);
      } catch (error) {
        fail(new ReadableError('The recording could not begin.', { cause: error }));
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    try {
      startDeadline = setTimeout(() => fail(new ReadableError('The video encoder did not start. Please try again.')), 5000);
      recorder.start(200);
    } catch (error) {
      fail(new ReadableError('The video encoder could not start.', { cause: error }));
    }
  });
}

// Minimal EBML processing for MediaRecorder WebM. Element payloads stay intact;
// only Segment/Info sizes, Duration and index positions can change.
const EBML = {
  SEGMENT: 0x18538067, INFO: 0x1549a966, TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489, SEEK_HEAD: 0x114d9b74, SEEK: 0x4dbb, SEEK_POSITION: 0x53ac,
  CUES: 0x1c53bb6b, CUE_POINT: 0xbb, CUE_TRACK_POSITIONS: 0xb7,
  CUE_CLUSTER_POSITION: 0xf1,
};

function readVint(bytes, start, keepMarker = false) {
  if (start >= bytes.length || bytes[start] === 0) throw new Error('Invalid WebM element.');
  let length = 1;
  let marker = 0x80;
  while (!(bytes[start] & marker)) { length++; marker >>= 1; }
  if (length > 8 || start + length > bytes.length) throw new Error('Incomplete WebM element.');
  let value = BigInt(keepMarker ? bytes[start] : bytes[start] & (marker - 1));
  for (let index = 1; index < length; index++) value = (value << 8n) | BigInt(bytes[start + index]);
  return { length, value, unknown: !keepMarker && value === (1n << BigInt(7 * length)) - 1n };
}

function elements(bytes, from, to) {
  const result = [];
  for (let start = from; start < to;) {
    const id = readVint(bytes, start, true);
    const size = readVint(bytes, start + id.length);
    const data = start + id.length + size.length;
    const end = size.unknown ? to : data + Number(size.value);
    if (end > to || end < data) throw new Error('Invalid WebM element size.');
    result.push({ id: Number(id.value), start, data, end, idLength: id.length, sizeLength: size.length, unknown: size.unknown });
    start = end;
  }
  return result;
}

function sizeVint(value, minimum = 1) {
  const number = BigInt(value);
  let length = minimum;
  while (number >= (1n << BigInt(length * 7)) - 1n && length < 8) length++;
  let encoded = number | (1n << BigInt(length * 7));
  const bytes = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index--) { bytes[index] = Number(encoded & 255n); encoded >>= 8n; }
  return bytes;
}

function join(...parts) {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function uint(bytes, from, to) {
  let value = 0;
  for (let offset = from; offset < to; offset++) value = value * 256 + bytes[offset];
  return value;
}

function writeUint(bytes, element, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 256 ** (element.end - element.data)) {
    throw new Error('WebM index is too large.');
  }
  for (let offset = element.end - 1; offset >= element.data; offset--) {
    bytes[offset] = value % 256;
    value = Math.floor(value / 256);
  }
}

async function finalizeWebMDuration(blob, seconds) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const segment = elements(bytes, 0, bytes.length).find(item => item.id === EBML.SEGMENT);
  if (!segment) throw new Error('The recorder returned a WebM without a Segment.');
  const children = elements(bytes, segment.data, segment.end);
  const info = children.find(item => item.id === EBML.INFO);
  if (!info) throw new Error('The recorder returned a WebM without video metadata.');
  const metadata = elements(bytes, info.data, info.end);
  const scaleElement = metadata.find(item => item.id === EBML.TIMECODE_SCALE);
  const timecodeScale = scaleElement ? uint(bytes, scaleElement.data, scaleElement.end) : 1_000_000;
  const duration = seconds * 1_000_000_000 / timecodeScale;
  const current = metadata.find(item => item.id === EBML.DURATION);
  if (current && [4, 8].includes(current.end - current.data)) {
    const view = new DataView(bytes.buffer);
    if (current.end - current.data === 8) view.setFloat64(current.data, duration);
    else view.setFloat32(current.data, duration);
    return new Blob([bytes], { type: blob.type });
  }
  const durationTag = new Uint8Array(11);
  durationTag.set([0x44, 0x89, 0x88]);
  new DataView(durationTag.buffer).setFloat64(3, duration);
  const infoPayload = join(bytes.subarray(info.data, info.end), durationTag);
  const replacement = join(bytes.subarray(info.start, info.start + info.idLength), sizeVint(infoPayload.length, info.sizeLength), infoPayload);
  const delta = replacement.length - (info.end - info.start);
  // MediaRecorder usually has no indices, but preserve them when supplied.
  const indexMasters = new Set([EBML.SEEK_HEAD, EBML.SEEK, EBML.CUES, EBML.CUE_POINT, EBML.CUE_TRACK_POSITIONS]);
  const updateIndices = (from, to) => {
    for (const element of elements(bytes, from, to)) {
      if (element.id === EBML.SEEK_POSITION || element.id === EBML.CUE_CLUSTER_POSITION) {
        const value = uint(bytes, element.data, element.end);
        if (value >= info.end - segment.data) writeUint(bytes, element, value + delta);
      } else if (indexMasters.has(element.id)) {
        updateIndices(element.data, element.end);
      }
    }
  };
  for (const element of children) {
    if (indexMasters.has(element.id)) updateIndices(element.data, element.end);
  }
  const segmentPayload = join(bytes.subarray(segment.data, info.start), replacement, bytes.subarray(info.end, segment.end));
  const segmentSize = segment.unknown
    ? bytes.subarray(segment.start + segment.idLength, segment.data)
    : sizeVint(segmentPayload.length, segment.sizeLength);
  return new Blob([
    bytes.subarray(0, segment.start + segment.idLength), segmentSize, segmentPayload,
    bytes.subarray(segment.end),
  ], { type: blob.type });
}
