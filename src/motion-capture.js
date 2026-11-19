/** Local-video decoding and ordered pose inference; video bytes never leave this page. */
export const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
export const MAX_CAPTURE_SECONDS = 20;
export const MAX_SAMPLE_RATE = 30;

export class MotionCaptureError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MotionCaptureError';
  }
}

function abortError() {
  return new DOMException('Motion capture cancelled.', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

/** Validate size/type before creating a local video URL. Browser decoding is the codec check. */
export function validateMotionVideoFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size)) {
    throw new MotionCaptureError('Choose a video file to capture a motion.');
  }
  if (file.size <= 0) throw new MotionCaptureError('This video file is empty. Choose another file.');
  if (file.size > MAX_VIDEO_BYTES) throw new MotionCaptureError('Choose a video smaller than 250 MB.');
  const extension = /\.(mp4|m4v|mov|webm|ogv|ogg|avi|mkv|mpeg|mpg)$/i.test(file.name ?? '');
  if (!file.type?.startsWith('video/') && !extension) {
    throw new MotionCaptureError('Choose a video file, such as MP4, MOV, or WebM.');
  }
  return file;
}

function videoError() {
  return new MotionCaptureError('This browser could not decode the video. Try an MP4 with H.264 video or a WebM file.');
}

/**
 * Load metadata without initializing MediaPipe. The caller owns the returned
 * local URL until dispose(); the source may be longer than the 20-second trim.
 */
export async function loadMotionVideo(file, { signal } = {}) {
  checkAbort(signal);
  validateMotionVideoFile(file);
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new MotionCaptureError('Local video capture is unavailable in this browser.');
  }
  const objectURL = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } finally {
      URL.revokeObjectURL(objectURL);
    }
  };
  try {
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', loaded);
        video.removeEventListener('error', failed);
        signal?.removeEventListener('abort', cancelled);
      };
      const loaded = () => {
        if (video.readyState < 1) return;
        cleanup();
        resolve();
      };
      const failed = () => { cleanup(); reject(videoError()); };
      const cancelled = () => { cleanup(); reject(abortError()); };
      video.addEventListener('loadedmetadata', loaded);
      video.addEventListener('error', failed);
      signal?.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new MotionCaptureError('The video metadata took too long to load. Try a smaller MP4 file.'));
      }, 15_000);
      if (signal?.aborted) { cancelled(); return; }
      video.src = objectURL;
      video.load();
      loaded();
    });
    checkAbort(signal);
    const { videoWidth: width, videoHeight: height, duration } = video;
    if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
      throw new MotionCaptureError('The video has no readable duration or picture. Try a different MP4 file.');
    }
    return { video, objectURL, width, height, duration, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Fixed, ordered times including both trim endpoints; useful for stable clip baking. */
export function buildMotionSampleTimes(duration, sampleRate = 15) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_CAPTURE_SECONDS + 1e-6) {
    throw new MotionCaptureError('Choose a motion segment between 0 and 20 seconds.');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 1 || sampleRate > MAX_SAMPLE_RATE) {
    throw new MotionCaptureError('Choose a sample rate between 1 and 30 frames per second.');
  }
  const count = Math.floor(duration * sampleRate + 1e-8);
  const times = Array.from({ length: count + 1 }, (_, index) => Math.min(duration, index / sampleRate));
  if (times.length === 1 || duration - times.at(-1) > 1e-7) times.push(duration);
  else times[times.length - 1] = duration;
  return times;
}

function trimRange(sourceDuration, start, end) {
  const finish = end ?? Math.min(sourceDuration, start + MAX_CAPTURE_SECONDS);
  if (![start, finish].every(Number.isFinite) || start < 0 || start >= sourceDuration
    || finish <= start || finish > sourceDuration + 1e-6) {
    throw new MotionCaptureError('Choose a start and end inside the video, with the end after the start.');
  }
  const duration = Math.min(finish, sourceDuration) - start;
  if (duration > MAX_CAPTURE_SECONDS + 1e-6) {
    throw new MotionCaptureError('Trim the motion to 20 seconds or less.');
  }
  return { start, end: Math.min(finish, sourceDuration), duration };
}

function seekVideo(video, time, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', decoded);
      video.removeEventListener('loadeddata', decoded);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', cancelled);
    };
    const decoded = () => {
      if (video.seeking || video.readyState < 2 || Math.abs(video.currentTime - time) > .025) return;
      cleanup();
      resolve();
    };
    const failed = () => { cleanup(); reject(videoError()); };
    const cancelled = () => { cleanup(); reject(abortError()); };
    video.addEventListener('seeked', decoded);
    video.addEventListener('loadeddata', decoded);
    video.addEventListener('error', failed);
    signal?.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new MotionCaptureError('A video frame could not be decoded. Try a different video or a shorter segment.'));
    }, 10_000);
    if (signal?.aborted) { cancelled(); return; }
    try {
      video.currentTime = time;
      decoded();
    } catch (error) {
      cleanup();
      reject(new MotionCaptureError('The browser could not seek through this video.', { cause: error }));
    }
  });
}

function videoBitmap(video, width, height, signal) {
  checkAbort(signal);
  // The model input is 256px. Bound transfers for large phone/4K source videos.
  const scale = Math.min(1, 960 / Math.max(width, height));
  const task = createImageBitmap(video, {
    resizeWidth: Math.max(1, Math.round(width * scale)),
    resizeHeight: Math.max(1, Math.round(height * scale)),
    resizeQuality: 'high',
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
    };
    const cancelled = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new MotionCaptureError('The browser could not prepare a video frame. Try a smaller video.'));
    }, 10_000);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    task.then(bitmap => {
      if (settled) { bitmap.close(); return; }
      settled = true;
      cleanup();
      resolve(bitmap);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new MotionCaptureError('This browser could not read a video frame for tracking.', { cause: error }));
    });
  });
}

function poseWorker(signal) {
  // Classic workers support the SDK's Emscripten importScripts loader. All task
  // code, WASM, and models are served by this app, including in a built preview.
  const worker = new Worker(new URL('./pose-worker.js', import.meta.url));
  const pending = new Map();
  let sequence = 0;
  let disposed = false;
  const dispose = (reason = abortError()) => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', cancelled);
    worker.terminate();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(reason); }
    pending.clear();
  };
  const cancelled = () => dispose(abortError());
  worker.onmessage = event => {
    const item = pending.get(event.data?.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(event.data.id);
    if (event.data.type === 'error') item.reject(new MotionCaptureError(event.data.message || 'The local pose tracker could not process this frame.'));
    else item.resolve(event.data);
  };
  worker.onerror = () => dispose(new MotionCaptureError('The local pose tracker could not start. Refresh the page and try again.'));
  worker.onmessageerror = () => dispose(new MotionCaptureError('The browser could not transfer video frames to the local pose tracker.'));
  signal?.addEventListener('abort', cancelled, { once: true });
  const request = (message, transfer = [], timeout = 15_000) => {
    checkAbort(signal);
    if (disposed) throw new MotionCaptureError('The local pose tracker is no longer available.');
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => dispose(new MotionCaptureError('The local pose tracker took too long to respond. Try a shorter video.')), timeout);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ ...message, id }, transfer); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new MotionCaptureError('The browser could not send a frame to the local pose tracker.', { cause: error }));
      }
    });
  };
  return { request, dispose };
}

/**
 * Analyze a local File. Frames include misses as {landmarks:null,
 * worldLandmarks:null,confidence:0}; times are seconds relative to the trim.
 * Progress: {phase:'loading'|'tracking',progress:0..1,frame,total}.
 */
export async function analyzeMotionVideo(file, {
  start = 0, end, sampleRate = 15, onProgress, signal,
} = {}) {
  checkAbort(signal);
  validateMotionVideoFile(file);
  if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
    throw new MotionCaptureError('Local motion tracking needs a current browser with video-frame and worker support.');
  }
  let loaded;
  let tracker;
  try {
    onProgress?.({ phase: 'loading', progress: 0, frame: 0, total: 0 });
    loaded = await loadMotionVideo(file, { signal });
    const trim = trimRange(loaded.duration, start, end);
    const times = buildMotionSampleTimes(trim.duration, sampleRate);
    onProgress?.({ phase: 'loading', progress: .1, frame: 0, total: times.length });
    checkAbort(signal);
    tracker = poseWorker(signal);
    const assetBase = new URL(`${import.meta.env?.BASE_URL ?? '/'}mediapipe/`, globalThis.location?.href ?? import.meta.url);
    await tracker.request({
      type: 'init',
      bundleURL: new URL('vision_bundle.js', assetBase).href,
      wasmBase: new URL('wasm/', assetBase).href,
      modelURL: new URL('pose_landmarker_lite.task', assetBase).href,
    }, [], 60_000);
    onProgress?.({ phase: 'loading', progress: 1, frame: 0, total: times.length });
    const frames = [];
    let trackedFrames = 0;
    for (let index = 0; index < times.length; index++) {
      checkAbort(signal);
      const time = times[index];
      // Seeking to exact media duration can produce an empty/end frame.
      await seekVideo(loaded.video, Math.min(trim.start + time, Math.max(0, loaded.duration - .001)), signal);
      const bitmap = await videoBitmap(loaded.video, loaded.width, loaded.height, signal);
      let result;
      try {
        result = await tracker.request({ type: 'frame', bitmap, timestamp: time * 1000 }, [bitmap]);
      } finally {
        // Transferred ImageBitmaps are detached here; close also covers a failed post.
        bitmap.close();
      }
      const valid = result.landmarks?.length === 33 && result.worldLandmarks?.length === 33;
      frames.push({
        time,
        landmarks: valid ? result.landmarks : null,
        worldLandmarks: valid ? result.worldLandmarks : null,
        confidence: valid && Number.isFinite(result.confidence)
          ? Math.max(0, Math.min(1, result.confidence)) : 0,
      });
      if (valid) trackedFrames++;
      onProgress?.({ phase: 'tracking', progress: (index + 1) / times.length, frame: index + 1, total: times.length });
    }
    checkAbort(signal);
    return {
      frames, duration: trim.duration, sampleRate, trackedFrames,
      totalFrames: frames.length, coverage: trackedFrames / frames.length,
      width: loaded.width, height: loaded.height,
    };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error?.name === 'AbortError' || error instanceof MotionCaptureError) throw error;
    throw new MotionCaptureError('The video could not be analyzed. Try a shorter, clearly lit full-body video.', { cause: error });
  } finally {
    tracker?.dispose();
    loaded?.dispose();
  }
}
