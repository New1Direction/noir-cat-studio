import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { attachActionProps } from '../src/action-props.js';
import { retargetMotion } from '../src/motion-retarget.js';

function capture({ missing = true, translate = false } = {}) {
  const frames = Array.from({ length: 31 }, (_, index) => {
    const time = index / 15;
    const points = Array.from({ length: 33 }, () => ({ x: 0, y: -.60, z: 0, visibility: .99 }));
    const set = (id, x, y, z = 0) => { points[id] = { x, y, z, visibility: .99 }; };
    set(0, 0, -.72, -.10); set(7, -.08, -.70); set(8, .08, -.70);
    set(11, -.23, -.50); set(12, .23, -.50);
    set(23, -.15, 0); set(24, .15, 0);
    const angle = Math.PI * time / 2;
    set(13, -.23 - Math.sin(angle) * .32, -.50 + Math.cos(angle) * .32);
    set(15, -.23 - Math.sin(angle) * .62, -.50 + Math.cos(angle) * .62);
    set(14, .27, -.18); set(16, .30, .12, -.04);
    const step = time > .6 && time < 1.6 ? Math.sin((time - .6) * Math.PI) : 0;
    set(25, -.15, .45 - .15 * step, -.10 * step); set(26, .15, .45, -.02);
    set(27, -.16, .90 - .25 * step, -.18 * step); set(28, .16, .90);
    set(29, -.16, .94 - .25 * step, .05 - .18 * step); set(30, .16, .94, .05);
    set(31, -.16, .94 - .25 * step, -.15 - .18 * step); set(32, .16, .94, -.15);
    const landmarks = points.map(point => ({ x: .5 + point.x * .45 + (translate ? .08 * time / 2 : 0), y: .55 + point.y * .43, z: point.z, visibility: point.visibility }));
    return { time, landmarks, worldLandmarks: points, confidence: .98 };
  });
  if (missing) { frames[8] = null; frames[9] = null; }
  return { frames, duration: 2, sampleRate: 15 };
}
function actor(style = 'ps2') { const cat = rigCat(createCat({ style })); attachActionProps(cat); return cat; }
function playback(cat, clip) {
  const mixer = new THREE.AnimationMixer(cat);
  const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true; action.play();
  return { seek(time) { mixer.setTime(time); cat.updateMatrixWorld(true); }, dispose() { mixer.stopAllAction(); mixer.uncacheRoot(cat); } };
}
function assertFiniteClip(clip) {
  assert.equal(clip.name, 'Your motion'); assert.equal(clip.tracks.length, 82);
  for (const track of clip.tracks) {
    for (const value of track.values) assert.ok(Number.isFinite(value), `${track.name} contains a non-finite value`);
    if (track.name.endsWith('.quaternion')) for (let i = 0; i < track.values.length; i += 4) {
      assert.ok(Math.abs(new THREE.Quaternion().fromArray(track.values, i).length() - 1) < 1e-6);
    }
  }
}
function headMetric(point) {
  if (point.y <= 3.28 || point.y >= 5.42) return Infinity;
  const t = point.y >= 4.17 ? (point.y - 4.17) / 1.25 : (point.y - 4.17) / 1.07;
  const exponent = t < 0 ? 2.85 : 2.05;
  const r = (1 - Math.abs(t) ** exponent) ** (1 / exponent);
  return (Math.abs(point.x) / (1.58 * r)) ** 2.2 + (Math.abs(point.z) / (.94 * r)) ** 2.2;
}

test('retargeting validates capture coverage and malformed input with useful errors', () => {
  const rig = actor().userData.rig;
  assert.throws(() => retargetMotion(rig, { frames: [] }), /enough pose frames/i);
  const sparse = capture(); sparse.frames = sparse.frames.map((frame, index) => index < 2 ? frame : null);
  assert.throws(() => retargetMotion(rig, sparse), /too little.*body/i);
  const wrongSize = capture(); wrongSize.frames[0].worldLandmarks.pop();
  assert.throws(() => retargetMotion(rig, wrongSize), /33.*landmarks/i);
  const badTime = capture(); badTime.frames[4].time = -.2;
  assert.throws(() => retargetMotion(rig, badTime), /timestamps.*order/i);
  assert.throws(() => retargetMotion(rig, { ...capture(), duration: Infinity }), /duration.*finite/i);
});

test('recorded arm raises and steps survive missing frames without mutating source data or the rig', () => {
  const cat = actor(); const input = capture(); const unchanged = JSON.stringify(input);
  const before = cat.userData.rig.skeleton.bones.map(bone => [...bone.position, ...bone.quaternion, ...bone.scale]);
  const result = retargetMotion(cat.userData.rig, input);
  assertFiniteClip(result.clip);
  assert.equal(result.stats.missingFrames, 2);
  assert.ok(result.stats.coverage > .9);
  assert.ok(result.stats.armAdaptations > 0, 'overhead reaches must adapt to the oversized head');
  assert.equal(JSON.stringify(input), unchanged);
  cat.userData.rig.skeleton.bones.forEach((bone, i) => assert.deepEqual([...bone.position, ...bone.quaternion, ...bone.scale], before[i]));
  const player = playback(cat, result.clip); const p = new THREE.Vector3();
  player.seek(0);
  cat.userData.rig.bones.Hand_L.getWorldPosition(p);
  assert.ok(p.y < 2 && Math.abs(p.x) < 1, 'neutral frames must stand naturally, not start in a T-pose');
  let armLow = Infinity, armHigh = -Infinity, footHigh = 0;
  for (let i = 0; i <= 60; i++) {
    player.seek(i / 30);
    cat.userData.rig.bones.Hand_L.getWorldPosition(p); armLow = Math.min(armLow, p.y); armHigh = Math.max(armHigh, p.y);
    cat.userData.rig.bones.Foot_L.getWorldPosition(p); footHigh = Math.max(footHigh, p.y);
  }
  assert.ok(armHigh - armLow > 1.1, 'the recorded arm raise must not become a preset idle');
  assert.ok(footHigh > .35, 'the recorded step must lift the correct foot');
  player.dispose();
});

test('mirror swaps the raised arm, and in-place movement removes camera-relative travel', () => {
  const a = actor(), b = actor();
  const input = capture({ translate: true });
  const normal = retargetMotion(a.userData.rig, input, { smoothing: 0 });
  const mirrored = retargetMotion(b.userData.rig, input, { smoothing: 0, mirror: true });
  const pa = playback(a, normal.clip), pb = playback(b, mirrored.clip);
  pa.seek(1.85); pb.seek(1.85);
  const normalL = a.userData.rig.bones.Hand_L.getWorldPosition(new THREE.Vector3());
  const normalR = a.userData.rig.bones.Hand_R.getWorldPosition(new THREE.Vector3());
  const mirrorL = b.userData.rig.bones.Hand_L.getWorldPosition(new THREE.Vector3());
  const mirrorR = b.userData.rig.bones.Hand_R.getWorldPosition(new THREE.Vector3());
  assert.ok(normalL.y > normalR.y + .7);
  assert.ok(mirrorR.y > mirrorL.y + .7);
  assert.ok(Math.abs(a.userData.rig.bones.Root.position.x) < 1e-7);
  const moving = retargetMotion(a.userData.rig, input, { inPlace: false });
  assert.ok(moving.stats.rootTravel > .20);
  pa.dispose(); pb.dispose();
});

test('long occlusions hold reliable poses and low-confidence/bad coordinates cannot introduce NaNs', () => {
  const input = capture({ missing: false });
  for (let i = 8; i <= 22; i++) input.frames[i] = null;
  input.frames[2].worldLandmarks[15].x = NaN;
  input.frames[4].confidence = .1;
  const result = retargetMotion(actor().userData.rig, input);
  assertFiniteClip(result.clip);
  assert.ok(result.warnings.some(message => /hidden.*hold/i.test(message)));
  assert.ok(result.stats.longestGap > .75);
});

for (const style of ['original', 'dreamcast', 'ps1', 'ps2']) {
  for (const loop of [false, true]) {
  test(`${style} ${loop ? 'looped' : 'one-shot'}: imported skin stays above ground and clear of the giant head without stretching limbs`, () => {
    const cat = actor(style); const rig = cat.userData.rig;
    const { clip } = retargetMotion(rig, capture(), { smoothing: .3, loop });
    assertFiniteClip(clip); const player = playback(cat, clip);
    const point = new THREE.Vector3(); const inverse = new THREE.Matrix4();
    const headIndex = rig.skeleton.bones.indexOf(rig.bones.Head);
    for (let frame = 0; frame < 90; frame++) {
      player.seek(2 * frame / 90);
      inverse.multiplyMatrices(rig.bones.Head.matrixWorld, rig.skeleton.boneInverses[headIndex]).invert();
      for (const side of ['leftLeg', 'rightLeg']) {
        const mesh = cat.userData.parts[side].children[0];
        for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
          mesh.getVertexPosition(i, point);
          assert.ok(point.y >= -.001, `${style}/${side} penetrates the floor at ${frame}`);
        }
      }
      for (const side of ['leftArm', 'rightArm']) {
        const mesh = cat.userData.parts[side].children[0];
        for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
          mesh.getVertexPosition(i, point).applyMatrix4(inverse);
          assert.ok(headMetric(point) >= 1 - .001, `${style}/${side} enters the head at ${frame}`);
        }
      }
      for (const [name, bone] of Object.entries(rig.bones)) {
        if (name === 'Root' || name === 'Hips') continue;
        assert.ok(bone.position.distanceTo(rig.rest[name].position) < 1e-6, `${name} stretches a fixed Noir bone`);
      }
    }
    player.dispose();
  });
}

}

test('optional looping blends before IK and closes actual tracks smoothly', () => {
  const cat = actor(); const { clip, stats } = retargetMotion(cat.userData.rig, capture(), { loop: true });
  assert.ok(stats.loop); assertFiniteClip(clip);
  for (const track of clip.tracks) {
    const size = track.getValueSize();
    for (let i = 0; i < size; i++) assert.ok(Math.abs(track.values[i] - track.values[track.values.length - size + i]) < .0001,
      `${track.name} does not close the requested loop`);
  }
  const player = playback(cat, clip);
  player.seek(0); const first = cat.userData.rig.bones.Hand_L.getWorldPosition(new THREE.Vector3());
  player.seek(clip.duration - .00001); const last = cat.userData.rig.bones.Hand_L.getWorldPosition(new THREE.Vector3());
  assert.ok(first.distanceTo(last) < .002);
  player.dispose();
});


test('intensity zero keeps a neutral pose and confidence-aware smoothing suppresses wrist jitter', () => {
  const cat = actor();
  const still = retargetMotion(cat.userData.rig, capture(), { intensity: 0 });
  const player = playback(cat, still.clip);
  player.seek(0); const start = cat.userData.rig.bones.Hand_L.getWorldPosition(new THREE.Vector3());
  player.seek(1.9); const end = cat.userData.rig.bones.Hand_L.getWorldPosition(new THREE.Vector3());
  assert.ok(start.distanceTo(end) < .0001);
  player.dispose();
  const noisy = capture({ missing: false });
  noisy.frames.forEach((frame, i) => {
    Object.assign(frame.worldLandmarks[13], { x: -.26, y: -.18, z: 0 });
    Object.assign(frame.worldLandmarks[15], { x: -.28, y: .12, z: i % 2 ? -.12 : .12 });
  });
  function jitter(smoothing) {
    const result = retargetMotion(cat.userData.rig, noisy, { smoothing });
    const playbackController = playback(cat, result.clip);
    const points = [];
    for (let i = 0; i <= 60; i++) {
      playbackController.seek(i / 30);
      points.push(cat.userData.rig.bones.Hand_L.getWorldPosition(new THREE.Vector3()));
    }
    let total = 0;
    for (let i = 1; i < points.length - 1; i++) total += points[i + 1].clone().add(points[i - 1]).addScaledVector(points[i], -2).lengthSq();
    playbackController.dispose();
    return total;
  }
  assert.ok(jitter(.85) < jitter(0) * .5, 'smoothing must reduce measured motion jitter');
});

test('capture duration is capped at twenty seconds', () => {
  const input = capture(); input.duration = 25;
  const result = retargetMotion(actor().userData.rig, input);
  assert.equal(result.clip.duration, 20);
  assert.ok(result.warnings.some(message => /20 seconds/.test(message)));
  assertFiniteClip(result.clip);
});


test('very short optional loops also close their blink tracks', () => {
  const input = capture(); input.duration = .2;
  const { clip } = retargetMotion(actor().userData.rig, input, { loop: true });
  for (const track of clip.tracks) {
    const size = track.getValueSize();
    for (let i = 0; i < size; i++) assert.ok(Math.abs(track.values[i] - track.values[track.values.length - size + i]) < .0001, `${track.name} has a short-loop seam`);
  }
});
