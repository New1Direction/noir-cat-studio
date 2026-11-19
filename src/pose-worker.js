/* Classic worker: deliberately no static imports. The SDK's WASM loader uses
 * importScripts, which browsers do not permit inside a module worker. */
let landmarker;
let initialize;

// Defense in depth: task assets stay on this origin and no SDK usage metrics or
// other requests can send the selected video's data to an external service.
const localOrigin = self.location.origin;
function localURL(value) {
  const url = new URL(typeof value === 'string' || value instanceof URL ? value : value.url, self.location.href);
  return url.protocol === 'data:' || url.origin === localOrigin;
}
const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => localURL(input)
  ? nativeFetch(input, init)
  : Promise.reject(new TypeError('External requests are disabled during local motion capture.'));
const nativeImportScripts = self.importScripts.bind(self);
self.importScripts = (...urls) => {
  if (!urls.every(localURL)) throw new TypeError('Pose tracker scripts must be hosted by this app.');
  nativeImportScripts(...urls);
};
if (self.XMLHttpRequest) {
  const nativeOpen = self.XMLHttpRequest.prototype.open;
  self.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (!localURL(url)) throw new TypeError('External requests are disabled during local motion capture.');
    return nativeOpen.call(this, method, url, ...rest);
  };
}
for (const name of ['WebSocket', 'EventSource']) {
  if (self[name]) {
    const Native = self[name];
    self[name] = new Proxy(Native, {
      construct(target, args) {
        if (!localURL(args[0])) throw new TypeError('External connections are disabled during local motion capture.');
        return Reflect.construct(target, args);
      },
    });
  }
}

function points(values) {
  if (values?.length !== 33) return null;
  const result = [];
  for (const point of values) {
    if (![point.x, point.y, point.z].every(Number.isFinite)) return null;
    result.push({
      x: point.x, y: point.y, z: point.z,
      visibility: Number.isFinite(point.visibility) ? Math.max(0, Math.min(1, point.visibility)) : point.visibility === undefined ? 1 : 0,
      presence: Number.isFinite(point.presence) ? Math.max(0, Math.min(1, point.presence)) : point.presence === undefined ? 1 : 0,
    });
  }
  return result;
}

function pose(result) {
  const landmarks = points(result.landmarks?.[0]);
  const worldLandmarks = points(result.worldLandmarks?.[0]);
  if (!landmarks || !worldLandmarks) return { landmarks: null, worldLandmarks: null, confidence: 0 };
  // Body joints matter more than the numerous facial landmarks for retargeting.
  const body = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  const confidence = body.reduce((sum, index) => sum
    + Math.min(landmarks[index].visibility, landmarks[index].presence), 0) / body.length;
  return { landmarks, worldLandmarks, confidence };
}

async function init(message) {
  for (const url of [message.bundleURL, message.wasmBase, message.modelURL]) {
    if (typeof url !== 'string' || !localURL(url)) throw new Error('Pose tracker assets must be served by this app.');
  }
  if (typeof OffscreenCanvas !== 'function') throw new Error('This browser needs OffscreenCanvas support for local tracking.');
  self.importScripts(message.bundleURL);
  const vision = self.Vision ?? self.vision;
  if (!vision?.FilesetResolver || !vision?.PoseLandmarker) throw new Error('The local pose tracker scripts are missing. Refresh the page and try again.');
  const files = await vision.FilesetResolver.forVisionTasks(message.wasmBase.replace(/\/$/, ''));
  landmarker = await vision.PoseLandmarker.createFromOptions(files, {
    canvas: new OffscreenCanvas(1, 1),
    baseOptions: { modelAssetPath: message.modelURL, delegate: 'CPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: .5,
    minPosePresenceConfidence: .5,
    minTrackingConfidence: .5,
    outputSegmentationMasks: false,
  });
}

self.onmessage = async event => {
  const message = event.data;
  const { id, type } = message ?? {};
  try {
    if (type === 'init') {
      initialize ??= init(message);
      await initialize;
      self.postMessage({ id, type: 'ready' });
    } else if (type === 'frame') {
      if (!landmarker) throw new Error('The local pose tracker is not ready.');
      if (!Number.isFinite(message.timestamp) || message.timestamp < 0) throw new Error('This video frame has an invalid timestamp.');
      const result = landmarker.detectForVideo(message.bitmap, message.timestamp);
      try { self.postMessage({ id, type: 'pose', ...pose(result) }); }
      finally { result.close?.(); }
    } else if (type === 'dispose') {
      landmarker?.close();
      landmarker = undefined;
      self.close();
    }
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error?.message || 'The local pose tracker could not process this video.' });
  } finally {
    message?.bitmap?.close();
  }
};
