import { analyzeMotionVideo, loadMotionVideo, validateMotionVideoFile } from './motion-capture.js';
import { retargetMotion } from './motion-retarget.js';

/** Local source-video lifecycle, capture controls, and repeatable motion cleanup. */
export function createMotionTransferUI({ getRig, installClip, removeClip, onProcessing }) {
  const $ = selector => document.querySelector(selector);
  let source = null;
  let file = null;
  let capture = null;
  let capturedRange = null;
  let operation = null;
  let sourceOperation = null;
  let generation = 0;
  let rebuildTimer = 0;
  let disposed = false;
  let capturedOptions = null;

  function setStatus(text, state) {
    $('#motion-capture-status').textContent = text;
    if (state) $('#capture-panel').dataset.state = state;
  }

  function range() {
    const start = Number($('#motion-start').value);
    const end = Number($('#motion-end').value);
    if (!source) throw new Error('Choose a video first.');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > source.duration + .00001 || end - start < .2) {
      throw new Error('Choose at least 0.2 seconds, with start and end inside the video.');
    }
    if (end - start > 20.00001) throw new Error('Trim the capture to 20 seconds or less.');
    return { start, end };
  }

  function options() {
    return {
      mirror: $('#motion-mirror').checked,
      smoothing: Number($('#motion-smoothing').value),
      footLock: $('#motion-foot-lock').checked,
      loop: $('#motion-loop').checked,
      inPlace: true,
    };
  }

  function updateTrim() {
    if (operation || sourceOperation) return;
    try {
      const selected = range();
      $('#analyze-motion').disabled = false;
      if (!capture) setStatus(`${(selected.end - selected.start).toFixed(1)}s selected. Ready to copy your moves.`, 'ready');
      else if (capturedRange?.start === selected.start && capturedRange?.end === selected.end) setStatus('Your motion is ready. Preview it, then export a video or animated GLB.', 'done');
      else setStatus('Trim changed. Click Copy my moves to capture this segment.', 'ready');
    } catch (error) {
      $('#analyze-motion').disabled = true;
      if (source) setStatus(error.message, 'error');
    }
  }

  function clearCaptured() {
    clearTimeout(rebuildTimer);
    removeClip(); capture = null; capturedRange = null; capturedOptions = null;
    $('#captured-motion').hidden = true;
    $('#play-captured-motion').disabled = true;
    $('#motion-capture-summary').textContent = '';
  }

  async function chooseFile(selectedFile) {
    if (!selectedFile || operation || disposed) return;
    const revision = ++generation;
    sourceOperation?.abort();
    const abort = new AbortController(); sourceOperation = abort;
    $('#analyze-motion').disabled = true;
    setStatus('Opening your video…', 'loading');
    let next;
    let opened = false;
    try {
      validateMotionVideoFile(selectedFile);
      next = await loadMotionVideo(selectedFile, { signal: abort.signal });
      if (revision !== generation || disposed) { next.dispose(); return; }
      clearCaptured();
      source?.dispose(); source = next; file = selectedFile;
      const previous = $('#motion-source-video');
      next.video.id = 'motion-source-video'; next.video.className = previous.className;
      next.video.controls = true; next.video.muted = true; next.video.hidden = false;
      next.video.setAttribute('aria-label', 'Source video for motion capture');
      previous.replaceWith(next.video);
      $('#motion-file-name').textContent = selectedFile.name;
      $('#motion-start').value = '0'; $('#motion-start').max = String(source.duration);
      $('#motion-end').max = String(source.duration);
      $('#motion-end').value = String(Math.floor(Math.min(20, source.duration) * 1000) / 1000);
      $('#motion-progress').hidden = true;
      opened = true;
    } catch (error) {
      if (next && next !== source) next.dispose();
      if (revision === generation && error.name !== 'AbortError') setStatus(error.message, 'error');
    } finally {
      if (revision === generation) {
        sourceOperation = null;
        if (opened) updateTrim();
        else $('#analyze-motion').disabled = !source;
      }
    }
  }

  async function run({ reuse = false } = {}) {
    if (operation || sourceOperation || !file || disposed) return;
    let selected;
    try { selected = range(); } catch (error) { setStatus(error.message, 'error'); return; }
    const abort = new AbortController(); operation = abort;
    const disabled = new Map([...document.querySelectorAll('button,input,select')].map(element => [element, element.disabled]));
    disabled.forEach((_, element) => { element.disabled = true; });
    $('#cancel-motion').hidden = false; $('#cancel-motion').disabled = false;
    $('#motion-progress').value = 0; $('#motion-progress').hidden = false;
    $('#analyze-motion').setAttribute('aria-busy', 'true');
    source.video.pause(); source.video.controls = false;
    onProcessing(true);
    try {
      let tracked = capture;
      const sameRange = capturedRange && selected.start === capturedRange.start && selected.end === capturedRange.end;
      if (!reuse || !tracked || !sameRange) {
        setStatus('Loading the local pose tracker…', 'processing');
        tracked = await analyzeMotionVideo(file, {
          ...selected, sampleRate: 15, signal: abort.signal,
          onProgress: ({ phase, progress, frame, total }) => {
            $('#motion-progress').value = phase === 'loading' ? .02 : .05 + .85 * progress;
            $('#motion-progress-label').textContent = phase === 'loading' ? 'Loading pose tracker' : `Tracking frame ${frame} of ${total}`;
            setStatus(phase === 'loading' ? 'Loading the local pose tracker…' : `Tracking your movement… ${Math.round(progress * 100)}%`, 'processing');
          },
        });
      }
      if (abort.signal.aborted) throw new DOMException('Motion capture cancelled.', 'AbortError');
      setStatus('Fitting the movement to Noir…', 'processing'); $('#motion-progress').value = .92;
      await new Promise(resolve => setTimeout(resolve, 0));
      if (abort.signal.aborted) throw new DOMException('Motion capture cancelled.', 'AbortError');
      const settings = options();
      const result = retargetMotion(getRig(), tracked, settings);
      if (abort.signal.aborted || disposed) throw new DOMException('Motion capture cancelled.', 'AbortError');
      installClip(result.clip, { loop: settings.loop, preserveTime: Boolean(reuse && capture) });
      capture = tracked; capturedRange = selected; capturedOptions = settings;
      $('#captured-motion').hidden = false;
      $('#play-captured-motion').disabled = false;
      const coverage = Math.round((result.stats?.coverage ?? tracked.coverage ?? tracked.trackedFrames / tracked.totalFrames) * 100);
      const warnings = (result.warnings ?? []).filter(message => typeof message === 'string');
      $('#motion-capture-summary').textContent = `${result.clip.duration.toFixed(1)}s · ${coverage}% tracked. ${warnings[0] ?? 'Ready to preview and export.'} Export before closing this tab.`;
      $('#motion-progress').value = 1;
      $('#motion-progress-label').textContent = 'Motion ready';
      setStatus('Your motion is ready. Preview it, then export a video or animated GLB.', 'done');
    } catch (error) {
      if (error.name === 'AbortError') setStatus(capture ? 'Capture cancelled. Your previous motion is still available.' : 'Capture cancelled. Click Copy my moves to try again.', capture ? 'done' : 'ready');
      else setStatus(error.message || 'The movement could not be captured. Try a clearer full-body video.', 'error');
    } finally {
      operation = null;
      source.video.controls = true;
      disabled.forEach((wasDisabled, element) => { element.disabled = wasDisabled; });
      $('#cancel-motion').hidden = true; $('#analyze-motion').removeAttribute('aria-busy');
      $('#play-captured-motion').disabled = !capture;
      onProcessing(false);
      try { range(); $('#analyze-motion').disabled = false; } catch { $('#analyze-motion').disabled = true; }
    }
  }

  $('#choose-motion-video').addEventListener('click', () => { $('#motion-video-input').value = ''; $('#motion-video-input').click(); });
  $('#motion-video-input').addEventListener('change', event => chooseFile(event.target.files?.[0]));
  $('#analyze-motion').addEventListener('click', () => run());
  $('#cancel-motion').addEventListener('click', () => operation?.abort());
  $('#remove-captured-motion').addEventListener('click', () => { clearCaptured(); updateTrim(); });
  for (const id of ['motion-start', 'motion-end']) $(`#${id}`).addEventListener('input', updateTrim);
  for (const id of ['motion-mirror', 'motion-foot-lock', 'motion-loop', 'motion-smoothing']) {
    $(`#${id}`).addEventListener('input', () => {
      $('#motion-smoothing-value').textContent = `${Math.round(Number($('#motion-smoothing').value) * 100)}%`;
      $('#motion-smoothing').style.setProperty('--fill', `${Number($('#motion-smoothing').value) * 100}%`);
      if (capture) { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(() => run({ reuse: true }), 250); }
    });
  }

  return {
    syncPreview(state, clipName) {
      if (!source || !capture || operation || clipName !== 'Your motion') return;
      const video = source.video;
      const desired = Math.min(source.duration - .0001, capturedRange.start + state.time);
      if (Math.abs(video.currentTime - desired) > (state.paused ? .035 : .15)) video.currentTime = desired;
      video.playbackRate = state.speed || 1;
      if (state.paused || state.finished) video.pause();
      else if (video.paused && !video.seeking) video.play().catch(() => {});
    },
    getState: () => ({ phase: $('#capture-panel').dataset.state, processing: Boolean(operation), hasVideo: Boolean(file), hasMotion: Boolean(capture), duration: capture?.duration ?? null, coverage: capture?.coverage ?? null, options: capturedOptions && { ...capturedOptions } }),
    dispose() {
      disposed = true; generation++; clearTimeout(rebuildTimer);
      operation?.abort(); sourceOperation?.abort(); source?.dispose();
    },
  };
}
