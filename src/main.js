import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createCat } from './cat.js';
import { rigCat } from './rig.js';
import { createAnimator } from './animation.js';
import { DANCES } from './dances.js';
import { ACTIONS } from './actions.js';
import { exportAnimatedGLB } from './export.js';
import { createRetroRenderer } from './retro-renderer.js';
import { recordMotionClip } from './video-export.js';
import { createMotionTransferUI } from './capture-controls.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const viewport = $('#viewport');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const editions = {
  original: { title: 'ORIGINAL STUDIO', years: 'FIRST EDITION', description: 'Soft shapes. Matte finish. The original Noir.', resolution: 'NATIVE RESOLUTION', eyebrow: 'SMALL CAT. BIG PERSONALITY.', subtitle: 'A familiar face, in a new dimension.', signal: 'NATIVE', stage: '#eeece6' },
  dreamcast: { title: 'DREAMCAST INSPIRED', years: '1999–2001', description: 'Sunshine, glossy plastic, arcade energy.', resolution: '640 × 480 · SOFT VGA', eyebrow: 'DREAMCAST INSPIRED / ARCADE EDITION', subtitle: 'A sunny little throwback to 1999.', signal: '640 × 480 · VGA', stage: '#b4e9f6' },
  ps1: { title: 'PS1 INSPIRED', years: '1994–2000', description: 'Chunky polygons. Dithered color. Pure nostalgia.', resolution: '320 × 240 · RGB5', eyebrow: 'PS1 INSPIRED / LOW POLY EDITION', subtitle: 'Same little smile. A few fewer polygons.', signal: '320 × 240 · RGB5', stage: '#bed5f4' },
  ps2: { title: 'PS2 INSPIRED', years: '2001–2004', description: 'Satin shapes, vertex lighting, a softer TV glow.', resolution: '640 × 480 · SOFT CRT', eyebrow: 'PS2 INSPIRED / CHARACTER SELECT', subtitle: 'A familiar face. A new memory card.', signal: '640 × 480 · CRT', stage: '#dce8f4' },
};
let currentStyle = 'ps2';
let ps2Mood = 'character-select';
try { const saved = localStorage.getItem('noir.renderStyle.v1'); if (editions[saved]) currentStyle = saved; } catch { /* Storage is optional. */ }
try { if (localStorage.getItem('noir.ps2Mood.v1') === 'foggy-town') ps2Mood = 'foggy-town'; } catch { /* Storage is optional. */ }
const requestedEdition = new URLSearchParams(location.search).get('edition');
if (editions[requestedEdition]) currentStyle = requestedEdition;
let currentClip = 'Idle';
let animationPaused = reducedMotion;
let animationSpeed = 1;
let studioPanel = 'animation';
let poseSettings = { headYaw: 0, headPitch: 0, armRaise: 0, tailSway: 0, blink: 0, smile: 0 };
let selectedIK = 'none';
let lastMotionUIUpdate = 0;
let videoRecording = null;
let motionTransferUI = null;
let capturedMotionClip = null;
let capturedMotionLoop = false;
let capturePriorState = null;
let captureInstalled = false;
let captureReferenceRig = null;
const ikTargets = new Map();
const animators = new WeakMap();
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
} catch (error) {
  $('#loading').textContent = 'This scene needs WebGL. Please open it in a browser with hardware acceleration enabled.';
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, .1, 100);
camera.position.set(.35, 3.75, 14);
const controls = new OrbitControls(camera, viewport);
controls.target.set(0, 2.5, 0);
controls.enableDamping = true;
controls.dampingFactor = .075;
controls.enablePan = false;
controls.minZoom = .65;
controls.maxZoom = 2.4;
controls.maxPolarAngle = Math.PI * .52;
controls.minPolarAngle = Math.PI * .19;
controls.autoRotateSpeed = 1.8;
controls.update();

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = pmrem.fromScene(room, .04);
scene.environment = environment.texture;
scene.environmentIntensity = .45;
room.dispose();
pmrem.dispose();
const hemisphere = new THREE.HemisphereLight(0xffffff, 0xc2bbae, 1.5);
scene.add(hemisphere);
const key = new THREE.DirectionalLight(0xfff9ee, 1.5);
key.position.set(-4, 10, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -9;
key.shadow.camera.right = 9;
key.shadow.camera.top = 9;
key.shadow.camera.bottom = -6;
key.shadow.camera.near = .5;
key.shadow.camera.far = 25;
key.shadow.bias = -.0003;
key.shadow.normalBias = .035;
key.shadow.radius = 5;
key.target.position.set(0, 2.5, 0);
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0xe8eefc, .45);
fill.position.set(5, 4, 3);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 1.5);
rim.position.set(1, 7, -5);
scene.add(rim);

function makeModelSet(style) {
  const models = Array.from({ length: 3 }, () => {
    const cat = rigCat(createCat({ style }));
    const animator = createAnimator(cat);
    if (capturedMotionClip) animator.addClip(capturedMotionClip, { loop: capturedMotionLoop });
    animator.play(currentClip, 0);
    animator.setPaused(animationPaused);
    animator.setSpeed(animationSpeed);
    animator.setPose(poseSettings);
    animators.set(cat, animator);
    return cat;
  });
  if (style === 'ps1') {
    const materials = new Set();
    models.forEach(cat => cat.traverse(object => { if (object.isMesh) materials.add(object.material); }));
    materials.forEach(material => {
      // Quantize projected vertices to the PS1 frame's pixel grid. This is
      // visible during orbiting and works with the same original pose.
      material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
          vec2 pixelGrid = vec2(160.0, 120.0);
          gl_Position.xy = floor(gl_Position.xy / gl_Position.w * pixelGrid + 0.5) / pixelGrid * gl_Position.w;`);
      };
      material.customProgramCacheKey = () => 'noir-ps1-snap-v1';
    });
  }
  return models;
}
const modelCache = new Map();
let cats = makeModelSet(currentStyle);
modelCache.set(currentStyle, cats);
const modelGroup = new THREE.Group();
cats.forEach((cat, index) => { cat.visible = index === 0; modelGroup.add(cat); });
scene.add(modelGroup);
let furMaterials = cats.map(cat => cat.userData.materials.fur);
const retro = createRetroRenderer({ renderer, scene, camera });
retro.setStyle(currentStyle);
retro.setMood(ps2Mood);

const ikSurface = document.createElement('div');
ikSurface.className = 'ik-interaction-surface';
Object.assign(ikSurface.style, { position: 'absolute', pointerEvents: 'none', touchAction: 'none' });
viewport.appendChild(ikSurface);
const ikHandle = new THREE.Object3D();
ikHandle.name = 'IK pose handle';
scene.add(ikHandle);
const transformControls = new TransformControls(camera, ikSurface);
transformControls.setMode('translate');
transformControls.setSize(.65);
const transformHelper = transformControls.getHelper();
transformHelper.visible = false;
scene.add(transformHelper);
let skeletonHelper = null;
transformControls.addEventListener('dragging-changed', event => { controls.enabled = !event.value; });
transformControls.addEventListener('objectChange', () => {
  if (selectedIK === 'none') return;
  const localTarget = cats[0].worldToLocal(ikHandle.position.clone());
  ikTargets.set(selectedIK, localTarget);
  cats.forEach(cat => animators.get(cat).setIKTarget(selectedIK, localTarget));
});

// A small, softly painted contact shadow complements the real cast shadow.
// It is generated in the browser; the character has no texture dependencies.
const shadowCanvas = document.createElement('canvas');
shadowCanvas.width = shadowCanvas.height = 128;
const context = shadowCanvas.getContext('2d');
const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
gradient.addColorStop(0, 'rgba(44,41,33,.26)');
gradient.addColorStop(.3, 'rgba(44,41,33,.16)');
gradient.addColorStop(.65, 'rgba(44,41,33,.045)');
gradient.addColorStop(1, 'rgba(44,41,33,0)');
context.fillStyle = gradient;
context.fillRect(0, 0, 128, 128);
const contactTexture = new THREE.CanvasTexture(shadowCanvas);
const shadowGroup = new THREE.Group();
const contactShadows = cats.map((_, index) => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 6), new THREE.MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false, opacity: .85 }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = .012;
  mesh.visible = index === 0;
  shadowGroup.add(mesh);
  return mesh;
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ color: 0x5b554b, opacity: .11 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
ground.visible = false;
shadowGroup.add(ground);
scene.add(shadowGroup);

let currentView = 'front';
let cameraMove = null;
let toastTimer;
let dimensions = { width: 0, height: 0 };
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3000);
}
function fitCamera() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  dimensions = { width, height };
  renderer.setSize(width, height);
  retro.setSize(width, height);
  const frame = retro.getFrameRect();
  $('.stage').classList.toggle('compact-console-heading', currentStyle !== 'original' && frame.y < 70);
  const aspect = frame.width / frame.height;
  // Reserve room around the ears and feet, including the controls beneath.
  const fullAspect = width / height;
  const originalHeight = currentView === 'all' ? Math.max(9.6, 12.6 / fullAspect) : Math.max(9.1, 4.9 / fullAspect);
  const viewHeight = currentStyle === 'original' ? originalHeight : Math.max(currentView === 'all' ? 9.1 : 8.2, originalHeight * frame.height / height);
  camera.left = -viewHeight * aspect / 2;
  camera.right = viewHeight * aspect / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();
  const hud = $('#arcade-hud');
  Object.assign(hud.style, { left: `${frame.x}px`, top: `${frame.y}px`, width: `${frame.width}px`, height: `${frame.height}px` });
  Object.assign(ikSurface.style, { left: `${frame.x}px`, top: `${frame.y}px`, width: `${frame.width}px`, height: `${frame.height}px` });
}
new ResizeObserver(fitCamera).observe(viewport);

function goToView(view, instant = false) {
  currentView = view;
  $('.stage').dataset.view = view;
  const all = view === 'all';
  cats.forEach((cat, i) => {
    cat.visible = all || i === 0;
    cat.position.x = all ? (i - 1) * 3.7 : 0;
    cat.rotation.y = all ? [0, -Math.PI / 2, Math.PI][i] : 0;
    contactShadows[i].visible = cat.visible;
    contactShadows[i].position.x = cat.position.x;
  });
  $('#view-labels').hidden = !all;
  const positions = { front: [0, 3.35, 14], side: [14, 3.35, 0], back: [0, 3.35, -14], all: [0, 3.35, 14] };
  const target = new THREE.Vector3(...positions[view]);
  if (instant || reducedMotion) {
    camera.position.copy(target);
    camera.zoom = 1;
    controls.update();
  } else {
    cameraMove = { from: camera.position.clone(), to: target, zoom: camera.zoom, start: performance.now() };
  }
  document.querySelectorAll('button[data-view]').forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('#scene-status').textContent = { front: 'Front / Studio view', side: 'Side / Studio view', back: 'Back / Studio view', all: 'Character / All views' }[view];
  fitCamera();
  refreshIKHandle();
}
document.querySelectorAll('button[data-view]').forEach(button => button.addEventListener('click', () => goToView(button.dataset.view)));
$('#reset-camera').addEventListener('click', () => goToView(currentView));
controls.addEventListener('start', () => {
  cameraMove = null;
  $('#scene-status').textContent = 'Camera / Free orbit';
});

function selectColor(button) {
  furMaterials.forEach(material => material.color.set(button.dataset.color));
  document.querySelectorAll('[data-color]').forEach(swatch => {
    const selected = swatch === button;
    swatch.classList.toggle('selected', selected);
    swatch.setAttribute('aria-pressed', String(selected));
    if (selected && !swatch.querySelector('svg')) swatch.innerHTML = '<svg viewBox="0 0 16 16"><path d="m4 8 3 3 5-6"/></svg>';
  });
  $('#material-name').textContent = button.dataset.name;
}
document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => selectColor(button)));
$('#roughness').addEventListener('input', event => {
  const value = Number(event.target.value);
  furMaterials.forEach(material => { material.roughness = value; if (material.isMeshPhysicalMaterial) material.clearcoatRoughness = value * .6; });
  $('#roughness-value').textContent = value.toFixed(2);
  event.target.style.setProperty('--fill', `${(value - .25) / .75 * 100}%`);
});
function selectBackdrop(button) {
  if (currentStyle === 'original') document.documentElement.style.setProperty('--stage', button.dataset.bg);
  $('#backdrop-name').textContent = button.dataset.name;
  document.querySelectorAll('[data-bg]').forEach(swatch => {
    swatch.classList.toggle('selected', swatch === button);
    swatch.setAttribute('aria-pressed', String(swatch === button));
  });
}
document.querySelectorAll('[data-bg]').forEach(button => button.addEventListener('click', () => selectBackdrop(button)));
$('#auto-rotate').addEventListener('change', event => { cameraMove = null; controls.autoRotate = event.target.checked; });
$('#shadows').addEventListener('change', event => { shadowGroup.visible = event.target.checked; });
$('#wireframe').addEventListener('change', event => furMaterials.forEach(material => material.wireframe = event.target.checked));
function updateHud() { $('#arcade-hud').hidden = currentStyle === 'original' || !$('#arcade-overlay').checked; }
$('#arcade-overlay').addEventListener('change', updateHud);

function selectMood(mood, persist = true) {
  if (!['character-select', 'foggy-town'].includes(mood)) return;
  ps2Mood = mood;
  retro.setMood(mood);
  document.body.dataset.mood = mood;
  document.querySelectorAll('[data-mood]').forEach(button => {
    const selected = button.dataset.mood === mood;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('#ps2-mood-description').textContent = mood === 'foggy-town' ? 'Misty streets, distant silhouettes, a cool green tint.' : 'A quiet blue menu, with soft CRT output.';
  if (currentStyle === 'ps2') {
    const foggy = mood === 'foggy-town';
    document.documentElement.style.setProperty('--stage', foggy ? '#e1e9e5' : editions.ps2.stage);
    $('.eyebrow').textContent = foggy ? 'PS2 INSPIRED / FOGGY TOWN' : editions.ps2.eyebrow;
    $('#hud-subtitle').textContent = foggy ? 'FOGGY TOWN' : 'CHARACTER SELECT';
    $('#edition-description').textContent = foggy ? 'A quiet town, soft fog, and a familiar little face.' : editions.ps2.description;
    hemisphere.color.set(foggy ? 0xd0dfd8 : 0xd5e3ff);
    hemisphere.groundColor.set(foggy ? 0xaab8ae : 0xa9b7df);
    hemisphere.intensity = foggy ? 2.1 : 2.5;
    key.color.set(foggy ? 0xd8e7e0 : 0xe2eaff); key.intensity = foggy ? .65 : .85;
    fill.color.set(foggy ? 0xb0c4c4 : 0x9ebcfa); fill.intensity = .4;
    rim.color.set(foggy ? 0xd5e7df : 0xbbd9ff); rim.intensity = .7;
    scene.environmentIntensity = .12; renderer.toneMappingExposure = 1.15;
  }
  if (persist) { try { localStorage.setItem('noir.ps2Mood.v1', mood); } catch { /* Storage is optional. */ } }
}
document.querySelectorAll('[data-mood]').forEach(button => button.addEventListener('click', () => selectMood(button.dataset.mood)));

function selectEdition(style, persist = true) {
  if (!editions[style]) return;
  const previousMotion = animators.get(cats[0]).getState();
  currentStyle = style;
  const edition = editions[style];
  if (!modelCache.has(style)) modelCache.set(style, makeModelSet(style));
  cats = modelCache.get(style);
  modelGroup.clear();
  cats.forEach((cat, i) => {
    cat.visible = currentView === 'all' || i === 0;
    cat.position.x = currentView === 'all' ? (i - 1) * 3.7 : 0;
    cat.rotation.y = currentView === 'all' ? [0, -Math.PI / 2, Math.PI][i] : 0;
    modelGroup.add(cat);
  });
  furMaterials = cats.map(cat => cat.userData.materials.fur);
  cats.forEach(cat => {
    const animator = animators.get(cat);
    animator.play(currentClip, 0);
    animator.seek(previousMotion.time);
    animator.setPaused(animationPaused);
    animator.setSpeed(animationSpeed);
    animator.setPose(poseSettings);
    animator.clearIK();
    ikTargets.forEach((target, limb) => animator.setIKTarget(limb, target));
    animator.update(0);
  });
  refreshRigTools();
  selectColor($('[data-color].selected'));
  furMaterials.forEach(material => material.wireframe = $('#wireframe').checked);
  const roughness = furMaterials[0].roughness;
  $('#roughness').value = String(roughness);
  $('#roughness-value').textContent = roughness.toFixed(2);
  $('#roughness').style.setProperty('--fill', `${(roughness - .25) / .75 * 100}%`);
  document.body.dataset.style = style;
  document.querySelectorAll('[data-edition]').forEach(button => {
    const selected = button.dataset.edition === style;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('#edition-kicker').textContent = edition.title;
  $('#edition-chip').textContent = edition.years;
  $('#edition-description').textContent = edition.description;
  $('#edition-resolution').textContent = edition.resolution;
  $('#edition-detail').textContent = `${cats[0].userData.triangles.toLocaleString()} triangles`;
  $('.eyebrow').textContent = edition.eyebrow;
  $('.scene-heading p').textContent = edition.subtitle;
  $('#hud-edition').textContent = { original: '', dreamcast: 'DC / 1999', ps1: 'PS / 1996', ps2: 'PS2 / 2001' }[style];
  $('#hud-subtitle').textContent = { original: '', dreamcast: 'SUNSHINE ARCADE', ps1: 'LOW POLY CLUB', ps2: 'CHARACTER SELECT' }[style];
  $('.hud-player').innerHTML = style === 'ps2' ? '<i>04</i> CHARACTER DATA' : '<i>1P</i> CHARACTER SELECT';
  $('#hud-signal').textContent = edition.signal;
  $('#backdrop-settings').hidden = style !== 'original';
  $('#arcade-overlay-row').hidden = style === 'original';
  $('#ps2-mood-setting').hidden = style !== 'ps2';
  $('#hud-toggle-label').textContent = style === 'ps2' ? 'Menu HUD' : 'Arcade HUD';
  document.documentElement.style.setProperty('--stage', style === 'original' ? $('[data-bg].selected').dataset.bg : edition.stage);
  updateHud();
  if (style === 'original') {
    hemisphere.color.set(0xffffff); hemisphere.groundColor.set(0xc2bbae); hemisphere.intensity = 1.5;
    key.color.set(0xfff9ee); key.intensity = 1.5;
    fill.color.set(0xe8eefc); fill.intensity = .45;
    rim.color.set(0xffffff); rim.intensity = 1.5;
    scene.environmentIntensity = .45; renderer.toneMappingExposure = 1;
  } else if (style === 'dreamcast') {
    hemisphere.color.set(0xbcecff); hemisphere.groundColor.set(0xffdc9a); hemisphere.intensity = 2.8;
    key.color.set(0xfff1c6); key.intensity = 3.1;
    fill.color.set(0x7ac9ff); fill.intensity = 1.6;
    rim.color.set(0xd6f3ff); rim.intensity = 3.0;
    scene.environmentIntensity = .65; renderer.toneMappingExposure = 1.05;
  } else if (style === 'ps1') {
    hemisphere.color.set(0xc4e4ff); hemisphere.groundColor.set(0xfde6ac); hemisphere.intensity = 2.0;
    key.color.set(0xffe5b4); key.intensity = 2.6;
    fill.color.set(0x8caeff); fill.intensity = .8;
    rim.color.set(0xd2e8ff); rim.intensity = .6;
    scene.environmentIntensity = .15; renderer.toneMappingExposure = 1.15;
  }
  renderer.shadowMap.enabled = style === 'original';
  retro.setStyle(style);
  selectMood(ps2Mood, false);
  fitCamera();
  updateVideoOptions();
  if (persist) {
    try { localStorage.setItem('noir.renderStyle.v1', style); } catch { /* Storage is optional. */ }
    if (new URLSearchParams(location.search).has('edition')) {
      const url = new URL(location.href); url.searchParams.set('edition', style); history.replaceState(null, '', url);
    }
  }
}
document.querySelectorAll('[data-edition]').forEach(button => button.addEventListener('click', () => selectEdition(button.dataset.edition)));

const clipDescriptions = {
  Idle: 'Soft breathing, little ear flicks, and a relaxed tail.',
  Walk: 'An easy walk in place, with alternating steps and a gentle sway.',
  Run: 'A balanced run, with relaxed arm swings and a clear lift between steps.',
  Sprint: 'A faster stride, with a forward drive and a longer airborne phase.',
  Wave: 'A little hello, with a head tilt and a friendly paw wave.',
  Sit: 'Settle into a seated pose and stay for a while.',
  ...Object.fromEntries(DANCES.map(dance => [dance.name, dance.description])),
  ...Object.fromEntries(ACTIONS.map(action => [action.name, action.description])),
};
const poseFields = ['head-yaw', 'head-pitch', 'arm-raise', 'tail-sway', 'blink', 'smile'];
const ikBoneNames = { hand_l: 'Hand_L', hand_r: 'Hand_R', foot_l: 'Foot_L', foot_r: 'Foot_R' };

function refreshRigTools() {
  if (skeletonHelper) {
    scene.remove(skeletonHelper); skeletonHelper.geometry.dispose(); skeletonHelper.material.dispose();
  }
  skeletonHelper = new THREE.SkeletonHelper(cats[0]);
  skeletonHelper.material.depthTest = false;
  skeletonHelper.material.transparent = true;
  skeletonHelper.material.opacity = .8;
  skeletonHelper.visible = studioPanel === 'pose' && $('#show-rig').checked;
  scene.add(skeletonHelper);
  $('#rig-badge').textContent = 'Fully rigged';
  $('#rig-bones').textContent = `${cats[0].userData.rig.skeleton.bones.length} joints`;
  refreshIKHandle();
}

function refreshIKHandle() {
  if (selectedIK === 'none' || studioPanel !== 'pose') {
    transformControls.detach(); transformHelper.visible = false;
    ikSurface.style.pointerEvents = 'none'; controls.enabled = true;
    return;
  }
  cats[0].updateMatrixWorld(true);
  const target = ikTargets.get(selectedIK);
  if (target) ikHandle.position.copy(cats[0].localToWorld(target.clone()));
  else cats[0].userData.rig.bones[ikBoneNames[selectedIK]].getWorldPosition(ikHandle.position);
  transformControls.attach(ikHandle);
  transformHelper.visible = true;
  ikSurface.style.pointerEvents = 'auto';
}

function updateMotionUI() {
  const state = animators.get(cats[0]).getState();
  const fraction = state.duration > 0 ? Math.min(state.time / state.duration, 1) : 0;
  $('#timeline').value = String(fraction);
  $('#timeline').style.setProperty('--fill', `${fraction * 100}%`);
  $('#animation-time').textContent = `${state.time.toFixed(2)} / ${state.duration.toFixed(2)}s`;
  motionTransferUI?.syncPreview(state, currentClip);
  if ($('#play-pause').dataset.paused !== String(animationPaused)) {
    $('#play-pause').dataset.paused = String(animationPaused);
    $('#play-pause').setAttribute('aria-label', animationPaused ? 'Play animation' : 'Pause animation');
    $('#play-pause').innerHTML = animationPaused
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6Z" fill="currentColor" stroke="none"/></svg>'
      : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10m6-10v10" stroke="currentColor" stroke-width="2"/></svg>';
  }
}

function setPaused(paused) {
  animationPaused = paused;
  cats.forEach(cat => animators.get(cat).setPaused(paused));
  updateMotionUI();
}
function seekMotion(time) {
  cats.forEach(cat => { animators.get(cat).seek(time); animators.get(cat).update(0); });
  updateMotionUI();
}
function clearPose() {
  poseSettings = { headYaw: 0, headPitch: 0, armRaise: 0, tailSway: 0, blink: 0, smile: 0 };
  ikTargets.clear(); selectedIK = 'none'; $('#ik-target').value = 'none';
  poseFields.forEach(id => { $(`#${id}`).value = '0'; });
  cats.forEach(cat => { animators.get(cat).setPose(poseSettings); animators.get(cat).clearIK(); animators.get(cat).update(0); });
  updatePoseOutputs(); refreshIKHandle();
}
function setStudioPanel(panel) {
  studioPanel = panel;
  document.querySelectorAll('[data-panel]').forEach(button => {
    const selected = button.dataset.panel === panel;
    button.classList.toggle('selected', selected); button.setAttribute('aria-selected', String(selected));
  });
  $('#animation-panel').hidden = panel !== 'animation';
  $('#pose-panel').hidden = panel !== 'pose';
  $('#capture-panel').hidden = panel !== 'capture';
  if (panel === 'pose') setPaused(true);
  else { clearPose(); setPaused(reducedMotion); }
  if (skeletonHelper) skeletonHelper.visible = panel === 'pose' && $('#show-rig').checked;
  refreshIKHandle();
}
function updateDanceStatus(name) {
  const dance = DANCES.find(dance => dance.name === name);
  const danceButton = $('#dance-library');
  if (danceButton) {
    danceButton.classList.toggle('selected', Boolean(dance));
    danceButton.setAttribute('aria-label', dance ? `Dance library: ${name}` : 'Open dance library');
  }
  if ($('#dance-current')) $('#dance-current').textContent = dance ? name : '10 emotes';
}
function selectClip(name, { keepPanel = false } = {}) {
  if (!clipDescriptions[name]) return;
  if (!keepPanel && studioPanel !== 'animation' && !(studioPanel === 'capture' && name === capturedMotionClip?.name)) setStudioPanel('animation');
  currentClip = name;
  cats.forEach(cat => animators.get(cat).play(name, .25));
  document.querySelectorAll('[data-clip]').forEach(button => {
    const selected = button.dataset.clip === name;
    button.classList.toggle('selected', selected); button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
  });
  $('#clip-description').textContent = clipDescriptions[name];
  updateDanceStatus(name);
  setPaused(false);
}
document.querySelectorAll('[data-clip]').forEach(button => button.addEventListener('click', () => selectClip(button.dataset.clip)));
$('#dance-library')?.addEventListener('click', () => {
  if (studioPanel !== 'animation') setStudioPanel('animation');
  const library = $('#dance-collection');
  const firstDance = library?.querySelector('[aria-pressed="true"]') ?? library?.querySelector('[data-clip]');
  library?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'nearest' });
  firstDance?.focus({ preventScroll: true });
});
document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => setStudioPanel(button.dataset.panel)));
motionTransferUI = createMotionTransferUI({
  // The smooth model gives every edition the same conservative skin-clearance
  // reference, including when capture starts in a lower-detail console style.
  getRig: () => modelCache.get('original')?.[0].userData.rig
    ?? (captureReferenceRig ??= rigCat(createCat({ style: 'original' })).userData.rig),
  onProcessing(busy) {
    if (busy) {
      capturePriorState = { motion: animators.get(cats[0]).getState(), controls: controls.enabled };
      captureInstalled = false; setPaused(true); controls.enabled = false;
    } else {
      controls.enabled = capturePriorState?.controls ?? true;
      if (!captureInstalled && capturePriorState) setPaused(capturePriorState.motion.paused);
      capturePriorState = null; captureInstalled = false;
    }
  },
  installClip(clip, { loop, preserveTime }) {
    const prior = capturePriorState?.motion ?? animators.get(cats[0]).getState();
    capturedMotionClip = clip.clone(); capturedMotionLoop = loop;
    for (const models of modelCache.values()) for (const cat of models) animators.get(cat).addClip(capturedMotionClip, { loop });
    clipDescriptions[clip.name] = 'Your captured movement, adapted to Noir’s proportions.';
    setStudioPanel('capture'); selectClip(clip.name, { keepPanel: true });
    if (preserveTime && prior.name === clip.name) { seekMotion(Math.min(prior.time, clip.duration)); setPaused(prior.paused); }
    captureInstalled = true;
  },
  removeClip() {
    if (!capturedMotionClip) return;
    const name = capturedMotionClip.name;
    for (const models of modelCache.values()) for (const cat of models) animators.get(cat).removeClip(name);
    capturedMotionClip = null; capturedMotionLoop = false; delete clipDescriptions[name];
    if (currentClip === name) selectClip('Idle', { keepPanel: true });
  },
});
window.addEventListener('pagehide', () => motionTransferUI?.dispose());
$('#play-pause').addEventListener('click', () => {
  const wasPaused = animationPaused;
  if (studioPanel === 'pose') setStudioPanel('animation');
  const state = animators.get(cats[0]).getState();
  if (state.finished && animationPaused) {
    cats.forEach(cat => animators.get(cat).play(currentClip, 0)); seekMotion(0);
  }
  setPaused(!wasPaused);
});
$('#timeline').addEventListener('input', event => {
  const fraction = Number(event.target.value);
  setPaused(true);
  seekMotion(fraction * animators.get(cats[0]).getState().duration);
});
$('#playback-speed').addEventListener('change', event => {
  animationSpeed = Number(event.target.value);
  cats.forEach(cat => animators.get(cat).setSpeed(animationSpeed));
});
$('#reset-motion').addEventListener('click', () => { setPaused(true); seekMotion(0); });
$('#show-rig').addEventListener('change', event => { if (skeletonHelper) skeletonHelper.visible = studioPanel === 'pose' && event.target.checked; });
$('#ik-target').addEventListener('change', event => {
  selectedIK = event.target.value;
  setPaused(true);
  if (selectedIK !== 'none' && !ikTargets.has(selectedIK)) {
    const point = cats[0].userData.rig.bones[ikBoneNames[selectedIK]].getWorldPosition(new THREE.Vector3());
    ikTargets.set(selectedIK, cats[0].worldToLocal(point));
    cats.forEach(cat => animators.get(cat).setIKTarget(selectedIK, ikTargets.get(selectedIK)));
  }
  refreshIKHandle();
});
function updatePoseOutputs() {
  for (const id of poseFields) {
    const value = Number($(`#${id}`).value);
    $(`#${id}-value`).textContent = ['head-yaw', 'head-pitch', 'tail-sway'].includes(id) ? `${value}°` : `${Math.round(value * 100)}%`;
    const input = $(`#${id}`);
    input.style.setProperty('--fill', `${(value - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
  }
}
poseFields.forEach(id => $(`#${id}`).addEventListener('input', () => {
  poseSettings = {
    headYaw: THREE.MathUtils.degToRad(Number($('#head-yaw').value)),
    headPitch: THREE.MathUtils.degToRad(Number($('#head-pitch').value)),
    armRaise: Number($('#arm-raise').value),
    tailSway: THREE.MathUtils.degToRad(Number($('#tail-sway').value)),
    blink: Number($('#blink').value), smile: Number($('#smile').value),
  };
  cats.forEach(cat => { animators.get(cat).setPose(poseSettings); animators.get(cat).update(0); });
  updatePoseOutputs();
}));
$('#pose-reset').addEventListener('click', () => {
  clearPose(); currentClip = 'Idle';
  cats.forEach(cat => animators.get(cat).play('Idle', 0));
  document.querySelectorAll('[data-clip]').forEach(button => {
    const selected = button.dataset.clip === 'Idle';
    button.classList.toggle('selected', selected); button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
  });
  $('#clip-description').textContent = clipDescriptions.Idle;
  updateDanceStatus('Idle');
  seekMotion(0); setPaused(true);
});
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName)) {
    event.preventDefault(); $('#play-pause').click();
  }
});
$('#reset-settings').addEventListener('click', () => {
  selectColor($('[data-color]'));
  selectBackdrop($('[data-bg]'));
  $('#roughness').value = String({ original: .78, dreamcast: .30, ps1: .82, ps2: .62 }[currentStyle]);
  $('#roughness').dispatchEvent(new Event('input'));
  for (const [id, checked] of [['auto-rotate', false], ['shadows', true], ['wireframe', false], ['arcade-overlay', true]]) {
    $(`#${id}`).checked = checked;
    $(`#${id}`).dispatchEvent(new Event('change'));
  }
  goToView('front');
  if (currentStyle === 'ps2') selectMood('character-select');
  clearPose(); selectClip('Idle'); seekMotion(0);
  toast('Edition settings reset.');
});

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function updateVideoOptions() {
  const greenOption = $('#video-background option[value="green"]');
  if (!greenOption) return;
  greenOption.disabled = currentStyle !== 'original';
  if (currentStyle !== 'original' && $('#video-background').value === 'green') $('#video-background').value = 'studio';
}

async function saveVideoClip() {
  if (videoRecording) return;
  const prior = animators.get(cats[0]).getState();
  const abort = new AbortController(); videoRecording = abort;
  const green = currentStyle === 'original' && $('#video-background').value === 'green';
  const disabled = new Map([...document.querySelectorAll('button, input, select')].map(element => [element, element.disabled]));
  const priorControls = { enabled: controls.enabled, autoRotate: controls.autoRotate, rig: skeletonHelper?.visible, transform: transformHelper.visible, shadow: shadowGroup.visible };
  disabled.forEach((_, element) => { element.disabled = true; });
  $('#cancel-record').disabled = false; $('#cancel-record').hidden = false;
  $('#record-clip').setAttribute('aria-busy', 'true');
  controls.enabled = false; controls.autoRotate = false;
  if (skeletonHelper) skeletonHelper.visible = false;
  transformHelper.visible = false;
  if (green) shadowGroup.visible = false;
  setPaused(true);
  try {
    const frame = retro.getFrameRect(); const signal = retro.getState();
    const width = signal.fixedResolution ? signal.width : 1080;
    const height = signal.fixedResolution ? signal.height : Math.round(width * frame.height / frame.width / 2) * 2;
    const blob = await recordMotionClip({
      sourceCanvas: renderer.domElement, frameRect: frame, pixelRatio: renderer.getPixelRatio(), width, height,
      duration: prior.duration, speed: prior.speed || 1,
      background: green ? '#00ff00' : getComputedStyle(document.body).getPropertyValue('--stage').trim() || '#eeece6',
      setTime: time => seekMotion(time), render: () => retro.render(), signal: abort.signal,
      onProgress: progress => { $('#record-status').textContent = `Recording ${Math.round(progress * 100)}%`; },
    });
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    download(blob, `noir-${currentStyle}-${currentClip.toLowerCase().replaceAll(' ', '-')}${green ? '-green-screen' : ''}.${extension}`);
    $('#record-status').textContent = 'Clip saved. Ready for your edit.';
    toast('Your clean video clip is saved.');
  } catch (error) {
    $('#record-status').textContent = error.name === 'AbortError' ? 'Recording cancelled.' : error.message;
    if (error.name !== 'AbortError') console.error('Video capture failed', error);
  } finally {
    cats.forEach(cat => { const animator = animators.get(cat); animator.play(prior.name, 0).seek(prior.time).setSpeed(prior.speed); });
    controls.enabled = priorControls.enabled; controls.autoRotate = priorControls.autoRotate;
    if (skeletonHelper) skeletonHelper.visible = priorControls.rig;
    transformHelper.visible = priorControls.transform; shadowGroup.visible = priorControls.shadow;
    disabled.forEach((wasDisabled, element) => { element.disabled = wasDisabled; });
    $('#cancel-record').hidden = true; $('#record-clip').removeAttribute('aria-busy');
    videoRecording = null; setPaused(prior.paused);
  }
}
$('#record-clip')?.addEventListener('click', saveVideoClip);
$('#cancel-record')?.addEventListener('click', () => videoRecording?.abort());
window.addEventListener('pagehide', () => videoRecording?.abort());
$('#snapshot').addEventListener('click', () => {
  // Console captures crop the 4:3 frame into its actual internal resolution.
  retro.render();
  const frame = retro.getFrameRect();
  const signal = retro.getState();
  const pixelRatio = renderer.getPixelRatio();
  const canvas = document.createElement('canvas');
  canvas.width = signal.width;
  canvas.height = signal.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = $('[data-bg].selected').dataset.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = currentStyle !== 'ps1';
  ctx.drawImage(renderer.domElement, frame.x * pixelRatio, frame.y * pixelRatio, frame.width * pixelRatio, frame.height * pixelRatio, 0, 0, canvas.width, canvas.height);
  if (currentView === 'all') {
    const ratio = canvas.width / frame.width;
    ctx.fillStyle = currentStyle === 'original' ? '#85897c' : currentStyle === 'ps2' ? '#7494c3' : '#173989';
    ctx.textAlign = 'center';
    ctx.font = `600 ${10 * ratio}px sans-serif`;
    cats.forEach((cat, i) => {
      const point = new THREE.Vector3(cat.position.x, -.37, 0).project(camera);
      ctx.fillText(['FRONT', 'SIDE', 'BACK'][i], (point.x * .5 + .5) * canvas.width, (-point.y * .5 + .5) * canvas.height);
    });
  }
  if (currentStyle !== 'original' && $('#arcade-overlay').checked) drawCaptureHud(ctx, canvas.width, canvas.height);
  const editionName = currentStyle === 'ps2' ? `ps2-${ps2Mood}` : currentStyle;
  canvas.toBlob(blob => { if (blob) { download(blob, `noir-${editionName}-${currentView}.png`); toast('Your edition image is saved.'); } }, 'image/png');
});

function drawCaptureHud(ctx, width, height) {
  const scale = width / 640;
  ctx.save();
  ctx.scale(scale, scale);
  const h = height / scale;
  if (currentStyle === 'ps2') {
    ctx.fillStyle = ps2Mood === 'foggy-town' ? '#e1eee8' : '#d3e9ff';
    ctx.font = '8px monospace';
    ctx.fillText('04 / CHARACTER DATA', 20, 26);
    ctx.textAlign = 'right'; ctx.fillText('PS2 / 2001', 620, 26);
    ctx.fillText('640 × 480 / CRT', 620, h - 17); ctx.textAlign = 'left';
    if (currentView !== 'all') {
      ctx.font = '500 32px sans-serif';
      ctx.fillText('N O I R', 21, h - 48);
      ctx.font = '8px monospace';
      ctx.fillText(ps2Mood === 'foggy-town' ? 'FOGGY TOWN' : 'CHARACTER SELECT', 24, h - 31);
      ctx.fillStyle = 'rgba(20,45,87,.45)'; ctx.fillRect(503, h - 93, 117, 48);
      ctx.strokeStyle = 'rgba(168,210,255,.5)'; ctx.lineWidth = 1; ctx.strokeRect(503.5, h - 92.5, 116, 47);
      ctx.strokeRect(512.5, h - 83, 13, 27); ctx.strokeRect(515.5, h - 81, 7, 7);
      ctx.fillStyle = '#c3ddf3'; ctx.font = '7px monospace';
      ctx.fillText('MEMORY CARD', 534, h - 78); ctx.font = '5px monospace';
      ctx.fillText('NOIR / CHARACTER DATA', 534, h - 67); ctx.fillText('SLOT 04  ●', 534, h - 57);
    }
    ctx.restore(); return;
  }
  ctx.font = 'bold 10px monospace';
  ctx.fillStyle = '#164698';
  ctx.fillText('1P / CHARACTER SELECT', 20, 26);
  ctx.textAlign = 'right';
  ctx.fillText(currentStyle === 'dreamcast' ? 'DC / 1999' : 'PS / 1996', 620, 26);
  ctx.fillText(editions[currentStyle].signal, 620, h - 17);
  ctx.textAlign = 'left';
  if (currentView !== 'all') {
    const chrome = ctx.createLinearGradient(0, h - 94, 0, h - 45);
    chrome.addColorStop(0, '#fff'); chrome.addColorStop(.43, '#d9fbff'); chrome.addColorStop(.48, '#2081bf'); chrome.addColorStop(.65, '#fff'); chrome.addColorStop(1, '#9ac9ff');
    ctx.font = 'italic 900 44px sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = '#1c52b6';
    ctx.strokeText('NOIR', 21, h - 43); ctx.fillStyle = chrome; ctx.fillText('NOIR', 21, h - 43);
    ctx.font = 'bold 8px monospace'; ctx.fillStyle = '#1752a6';
    ctx.fillText(currentStyle === 'dreamcast' ? 'SUNSHINE ARCADE' : 'LOW POLY CLUB', 24, h - 29);
  }
  ctx.restore();
}

async function exportModel() {
  const button = $('#export');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  const originalLabel = button.querySelector('span').textContent;
  button.querySelector('span').textContent = 'Preparing…';
  try {
    const result = await exportAnimatedGLB(cats[0], animators.get(cats[0]).clips, { includePose: studioPanel === 'pose' });
    download(new Blob([result.binary], { type: 'model/gltf-binary' }), `noir-${currentStyle}-rigged.glb`);
    toast(`Rig + ${result.animations.length} animations exported. Validation passed.`);
  } catch (error) {
    console.error('Model export failed', error);
    toast('Model export needs attention. Please try again.');
  } finally {
    button.disabled = false; button.removeAttribute('aria-busy');
    button.querySelector('span').textContent = originalLabel;
  }
}
$('#export').addEventListener('click', exportModel);
$('#open-reference').addEventListener('click', () => $('#reference-dialog').showModal());
$('#close-reference').addEventListener('click', () => $('#reference-dialog').close());
$('#reference-dialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
viewport.addEventListener('keydown', event => {
  if (event.key === '1') goToView('front');
  if (event.key === '2') goToView('side');
  if (event.key === '3') goToView('back');
  if (event.key === '4') goToView('all');
});

const labelElements = [...$('#view-labels').children];
const clock = new THREE.Clock();
function render(now) {
  const delta = Math.min(clock.getDelta(), .05);
  if (cameraMove) {
    const fraction = Math.min((now - cameraMove.start) / 650, 1);
    const ease = fraction < .5 ? 4 * fraction ** 3 : 1 - Math.pow(-2 * fraction + 2, 3) / 2;
    // Orbit interpolation stays outside the model when switching opposite views.
    const a = cameraMove.from.clone().sub(controls.target);
    const b = cameraMove.to.clone().sub(controls.target);
    const sphericalA = new THREE.Spherical().setFromVector3(a);
    const sphericalB = new THREE.Spherical().setFromVector3(b);
    let thetaDelta = sphericalB.theta - sphericalA.theta;
    thetaDelta = Math.atan2(Math.sin(thetaDelta), Math.cos(thetaDelta));
    const spherical = new THREE.Spherical(THREE.MathUtils.lerp(sphericalA.radius, sphericalB.radius, ease), THREE.MathUtils.lerp(sphericalA.phi, sphericalB.phi, ease), sphericalA.theta + thetaDelta * ease);
    camera.position.setFromSpherical(spherical).add(controls.target);
    camera.zoom = THREE.MathUtils.lerp(cameraMove.zoom, 1, ease);
    camera.updateProjectionMatrix();
    if (fraction === 1) cameraMove = null;
  }
  controls.update(delta);
  cats.forEach(cat => animators.get(cat).update(delta));
  const motion = animators.get(cats[0]).getState();
  if (motion.finished && !animationPaused) setPaused(true);
  if (skeletonHelper?.visible) skeletonHelper.updateMatrixWorld(true);
  if (now - lastMotionUIUpdate > 70) { updateMotionUI(); lastMotionUIUpdate = now; }
  if (currentView === 'all') {
    const frame = retro.getFrameRect();
    cats.forEach((cat, index) => {
      const labelPoint = new THREE.Vector3(cat.position.x, -.27, 0).project(camera);
      labelElements[index].style.left = `${frame.x + (labelPoint.x * .5 + .5) * frame.width}px`;
      labelElements[index].style.top = `${frame.y + (-labelPoint.y * .5 + .5) * frame.height}px`;
    });
  }
  retro.render();
}
goToView('front', true);
selectEdition(currentStyle, false);
updateVideoOptions();
updatePoseOutputs();
const requestedMotion = new URLSearchParams(location.search).get('motion') ?? new URLSearchParams(location.search).get('dance');
if (clipDescriptions[requestedMotion]) {
  selectClip(requestedMotion);
  if (reducedMotion) setPaused(true);
}
const requestedPanel = new URLSearchParams(location.search).get('panel');
if (['animation', 'pose', 'capture'].includes(requestedPanel)) setStudioPanel(requestedPanel);
renderer.setAnimationLoop(render);
requestAnimationFrame(() => { $('#loading').classList.add('done'); });
window.addEventListener('pagehide', () => { renderer.setAnimationLoop(null); });
window.addEventListener('pageshow', () => { renderer.setAnimationLoop(render); });
// A tiny read-only diagnostics surface makes scene verification repeatable.
window.noirStudio = { getState: () => ({ style: currentStyle, mood: ps2Mood, view: currentView, motion: animators.get(cats[0]).getState(), rig: { bones: cats[0].userData.rig.skeleton.bones.length, skinnedMeshes: cats[0].userData.rig.meshes.length }, panel: studioPanel, selectedIK, transitioning: !!cameraMove, color: furMaterials[0].color.getHexString(), roughness: furMaterials[0].roughness, autoRotate: controls.autoRotate, shadows: shadowGroup.visible, wireframe: furMaterials[0].wireframe, hud: !$('#arcade-hud').hidden, triangles: cats.filter(cat => cat.visible).reduce((sum, cat) => sum + cat.userData.triangles, 0), camera: { position: camera.position.toArray(), zoom: camera.zoom }, signal: retro.getState(), size: dimensions, webgl: renderer.capabilities.isWebGL2 }) };
