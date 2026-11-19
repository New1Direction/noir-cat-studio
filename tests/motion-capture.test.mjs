import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  analyzeMotionVideo, loadMotionVideo, validateMotionVideoFile,
  buildMotionSampleTimes, MAX_VIDEO_BYTES, MotionCaptureError,
} from '../src/motion-capture.js';

const restore = new Map();
let videos;
let workers;
let revoked;
let bitmaps;
let sourceDuration;
let loadFailure;
let hangFrames;
const landmarks = Array.from({ length: 33 }, (_, index) => ({ x: index / 33, y: .5, z: 0, visibility: .9, presence: .8 }));

function replace(key, value) {
  if (!restore.has(key)) restore.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

class Video extends EventTarget {
  constructor() { super(); this.readyState = 0; this.duration = sourceDuration; this.videoWidth = 1920; this.videoHeight = 1080; this.listeners = new Set(); videos.push(this); }
  addEventListener(name, listener, options) { this.listeners.add(listener); super.addEventListener(name, listener, options); }
  removeEventListener(name, listener, options) { this.listeners.delete(listener); super.removeEventListener(name, listener, options); }
  load() {
    if (!this.src) return;
    queueMicrotask(() => {
      this.readyState = 4;
      this.dispatchEvent(new Event(loadFailure ? 'error' : 'loadedmetadata'));
      this.dispatchEvent(new Event('loadeddata'));
    });
  }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  set currentTime(value) {
    this.position = value;
    this.seeking = true;
    queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  get currentTime() { return this.position ?? 0; }
}

class Worker {
  constructor() { this.timestamps = []; workers.push(this); }
  postMessage(message) {
    if (message.type === 'init') {
      this.init = message;
      queueMicrotask(() => !this.terminated && this.onmessage?.({ data: { type: 'ready', id: message.id } }));
    } else {
      this.timestamps.push(message.timestamp);
      if (hangFrames) return;
      const missing = this.timestamps.length === 2;
      queueMicrotask(() => !this.terminated && this.onmessage?.({ data: {
        id: message.id, type: 'pose', landmarks: missing ? null : landmarks,
        worldLandmarks: missing ? null : landmarks, confidence: missing ? 0 : .8,
      } }));
    }
  }
  terminate() { this.terminated = true; }
}

function file() {
  const result = new Blob(['local video'], { type: 'video/mp4' });
  Object.defineProperty(result, 'name', { value: 'motion.mp4' });
  return result;
}

beforeEach(() => {
  videos = []; workers = []; revoked = []; bitmaps = [];
  sourceDuration = 4; loadFailure = false; hangFrames = false;
  replace('document', { createElement: name => { assert.equal(name, 'video'); return new Video(); } });
  replace('Worker', Worker);
  replace('location', { href: 'https://noir.test/studio/' });
  replace('createImageBitmap', async (video, options) => {
    assert.equal(options.resizeWidth, 960);
    assert.equal(options.resizeHeight, 540);
    const bitmap = { time: video.currentTime, close() { this.closed = true; } };
    bitmaps.push(bitmap);
    return bitmap;
  });
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:local-${videos.length}`;
  URL.revokeObjectURL = url => revoked.push(url);
  restore.set('urlMethods', { create, revoke });
});

afterEach(() => {
  for (const [key, descriptor] of restore) {
    if (key === 'urlMethods') {
      URL.createObjectURL = descriptor.create;
      URL.revokeObjectURL = descriptor.revoke;
    } else if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  restore.clear();
});

test('sample times include both endpoints, remain ordered, and enforce bounded work', () => {
  assert.deepEqual(buildMotionSampleTimes(.14, 15), [0, 1 / 15, 2 / 15, .14]);
  assert.equal(buildMotionSampleTimes(20, 30).length, 601);
  assert.equal(buildMotionSampleTimes(1, 15).at(-1), 1);
  assert.deepEqual(buildMotionSampleTimes(1e-8, 15), [0, 1e-8]);
  for (const duration of [0, -1, 20.1, Infinity, NaN]) assert.throws(() => buildMotionSampleTimes(duration));
  for (const rate of [0, 31, Infinity, NaN]) assert.throws(() => buildMotionSampleTimes(1, rate));
});

test('video validation rejects empty, oversized and non-video files', () => {
  assert.equal(validateMotionVideoFile(file()).name, 'motion.mp4');
  assert.throws(() => validateMotionVideoFile(new Blob([], { type: 'video/mp4' })), /empty/);
  assert.throws(() => validateMotionVideoFile({ size: MAX_VIDEO_BYTES + 1, arrayBuffer() {}, type: 'video/mp4' }), /250 MB/);
  assert.throws(() => validateMotionVideoFile(new Blob(['text'], { type: 'text/plain' })), /video file/);
});

test('metadata loading never initializes tracking and revokes its URL on dispose', async () => {
  const loaded = await loadMotionVideo(file());
  assert.equal(loaded.duration, 4);
  assert.equal(loaded.width, 1920);
  assert.equal(workers.length, 0);
  assert.equal(revoked.length, 0);
  assert.equal(videos[0].listeners.size, 0);
  loaded.dispose(); loaded.dispose();
  assert.equal(revoked.length, 1);
  assert.equal(videos[0].src, '');
});

test('analysis samples an ordered trim, retains misses, reports coverage, and cleans up', async () => {
  const progress = [];
  const result = await analyzeMotionVideo(file(), { start: 1, end: 2.1, sampleRate: 2, onProgress: event => progress.push(event) });
  assert.deepEqual(result.frames.map(frame => frame.time), [0, .5, 1, 1.1]);
  assert.deepEqual(workers[0].timestamps, [0, 500, 1000, 1100]);
  assert.equal(result.frames[1].landmarks, null);
  assert.equal(result.frames[1].worldLandmarks, null);
  assert.equal(result.frames[1].confidence, 0);
  assert.equal(result.trackedFrames, 3);
  assert.equal(result.totalFrames, 4);
  assert.equal(result.coverage, .75);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.equal(workers[0].init.bundleURL, 'https://noir.test/mediapipe/vision_bundle.js');
  assert.equal(workers[0].terminated, true);
  assert.equal(revoked.length, 1);
  assert.equal(videos[0].listeners.size, 0);
  assert.ok(bitmaps.every(bitmap => bitmap.closed));
  assert.equal(progress[0].phase, 'loading');
  assert.deepEqual(progress.at(-1), { phase: 'tracking', progress: 1, frame: 4, total: 4 });
});

test('long source videos can be trimmed, while processing stays limited to 20 seconds', async () => {
  sourceDuration = 90;
  const result = await analyzeMotionVideo(file(), { start: 30, sampleRate: 1 });
  assert.equal(result.duration, 20);
  assert.equal(result.frames.length, 21);
  assert.equal(result.frames.at(-1).time, 20);
  await assert.rejects(analyzeMotionVideo(file(), { start: 1, end: 22 }), /20 seconds/);
  assert.equal(workers.length, 1);
  assert.equal(revoked.length, 2);
});

test('aborting inference terminates the worker, closes its bitmap, and revokes the video URL', async () => {
  hangFrames = true;
  const controller = new AbortController();
  const task = analyzeMotionVideo(file(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(task, error => error.name === 'AbortError');
  assert.equal(workers[0].terminated, true);
  assert.ok(bitmaps.every(bitmap => bitmap.closed));
  assert.equal(videos[0].listeners.size, 0);
  assert.equal(revoked.length, 1);
});

test('decode failures and already-aborted requests allocate no tracking worker', async () => {
  loadFailure = true;
  await assert.rejects(analyzeMotionVideo(file()), /could not decode/);
  assert.equal(workers.length, 0);
  assert.equal(revoked.length, 1);
  assert.equal(videos[0].listeners.size, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeMotionVideo(file(), { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(videos.length, 1);
});

test('zero-duration videos fail before model loading and release resources', async () => {
  sourceDuration = 0;
  await assert.rejects(analyzeMotionVideo(file()), /no readable duration/);
  assert.equal(workers.length, 0);
  assert.equal(revoked.length, 1);
});

test('an unresponsive model initialization times out and releases both worker and video', async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  replace('setTimeout', (callback, delay, ...args) => nativeSetTimeout(callback, delay === 60_000 ? 0 : delay, ...args));
  replace('Worker', class extends Worker { postMessage() {} });
  await assert.rejects(analyzeMotionVideo(file()), /too long to respond/);
  assert.equal(workers[0].terminated, true);
  assert.equal(revoked.length, 1);
  assert.equal(videos[0].listeners.size, 0);
});

test('classic worker guards external requests before loading the SDK and sanitizes pose messages', async () => {
  const source = await readFile(new URL('../src/pose-worker.js', import.meta.url), 'utf8');
  const network = [];
  const messages = [];
  let taskOptions;
  const sandbox = {
    URL, console, location: { origin: 'https://noir.test', href: 'https://noir.test/pose-worker.js' },
    fetch: async input => { network.push(String(input)); return {}; },
    importScripts: url => {
      network.push(url);
      sandbox.Vision = {
        FilesetResolver: { forVisionTasks: async path => ({ path }) },
        PoseLandmarker: { createFromOptions: async (files, options) => {
          assert.equal(files.path, 'https://noir.test/mediapipe/wasm');
          taskOptions = options;
          return { detectForVideo: () => ({ landmarks: [landmarks], worldLandmarks: [landmarks], close() {} }) };
        } },
      };
    },
    OffscreenCanvas: class {},
    postMessage: message => messages.push(message),
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  await assert.rejects(sandbox.fetch('https://odml.pa.googleapis.com/v1/log'), /External requests/);
  assert.throws(() => sandbox.importScripts('https://example.com/tracker.js'), /hosted by this app/);
  assert.equal(network.length, 0);
  await sandbox.fetch('https://noir.test/mediapipe/model.task');
  await sandbox.onmessage({ data: { id: 1, type: 'init',
    bundleURL: 'https://noir.test/mediapipe/vision_bundle.js',
    wasmBase: 'https://noir.test/mediapipe/wasm/', modelURL: 'https://noir.test/mediapipe/pose_landmarker_lite.task',
  } });
  assert.equal(messages.at(-1).type, 'ready');
  assert.equal(taskOptions.baseOptions.delegate, 'CPU');
  assert.equal(taskOptions.runningMode, 'VIDEO');
  const bitmap = { close() { this.closed = true; } };
  await sandbox.onmessage({ data: { id: 2, type: 'frame', timestamp: 100, bitmap } });
  assert.equal(messages.at(-1).type, 'pose');
  assert.equal(messages.at(-1).landmarks.length, 33);
  assert.ok(Math.abs(messages.at(-1).confidence - .8) < 1e-9);
  assert.equal(bitmap.closed, true);
  assert.ok(network.every(url => new URL(url).origin === 'https://noir.test'));
});
