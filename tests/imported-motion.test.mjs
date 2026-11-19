import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator } from '../src/animation.js';
import { exportAnimatedGLB } from '../src/export.js';

function fixture() {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const animator = createAnimator(cat);
  return { cat, animator };
}

function importedClip(animator, { name = 'Your motion', duration = 1, endYaw = .60 } = {}) {
  const clip = animator.clips.find(clip => clip.name === 'Idle').clone();
  const previousDuration = clip.duration;
  clip.name = name;
  clip.duration = duration;
  for (const track of clip.tracks) {
    for (let i = 0; i < track.times.length; i++) track.times[i] *= duration / previousDuration;
    if (track.name === 'Head.quaternion') {
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i] / duration;
        const smooth = t * t * (3 - 2 * t);
        const yaw = endYaw * smooth + .28 * Math.sin(Math.PI * t);
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).toArray(track.values, i * 4);
      }
    }
  }
  return clip;
}

function expectedHead(clip, time) {
  return new THREE.Quaternion().fromArray(clip.tracks.find(track => track.name === 'Head.quaternion').createInterpolant().evaluate(time)).normalize();
}

test('imported motion is cloned into the clip library and animates the actual head', () => {
  const { cat, animator } = fixture();
  try {
    assert.equal(animator.clips.length, 19);
    assert.equal(animator.hasClip('Your motion'), false);
    const clip = importedClip(animator);
    const expected = expectedHead(clip, .5);
    assert.equal(animator.addClip(clip), animator);
    assert.equal(animator.clips.length, 20);
    assert.equal(animator.hasClip('Your motion'), true);
    const stored = animator.clips.find(clip => clip.name === 'Your motion');
    assert.notEqual(stored, clip);
    clip.duration = 9;
    clip.tracks.find(track => track.name === 'Head.quaternion').values.fill(0);
    animator.play('Your motion', 0).seek(.5);
    assert.equal(animator.getState().duration, 1);
    assert.ok(cat.userData.rig.bones.Head.quaternion.angleTo(expected) < 1e-5);
    assert.equal(cat.getObjectByName('NoirBlaster').scale.length(), 0);
    assert.equal(cat.getObjectByName('NoirSmokeProp').scale.length(), 0);
  } finally { animator.dispose(); }
});

test('imported clips default to one-shot playback, hold the end, replay, and clamp seeking', () => {
  const { cat, animator } = fixture();
  try {
    const clip = importedClip(animator, { duration: 1.25, endYaw: .55 });
    animator.addClip(clip).play('Your motion', 0).seek(1.20).update(.10);
    assert.equal(animator.getState().duration, 1.25);
    assert.equal(animator.getState().finished, true);
    assert.equal(animator.getState().time, 1.25);
    const held = cat.userData.rig.bones.Head.quaternion.clone();
    for (let i = 0; i < 20; i++) animator.update(.1);
    assert.equal(animator.getState().time, 1.25);
    assert.ok(cat.userData.rig.bones.Head.quaternion.angleTo(held) < 1e-7);
    animator.play('Your motion', 0);
    assert.equal(animator.getState().time, 0);
    assert.equal(animator.getState().finished, false);
    animator.seek(100);
    assert.equal(animator.getState().time, 1.25);
    assert.equal(animator.getState().finished, true);
    animator.seek(-10);
    assert.equal(animator.getState().time, 0);
    assert.equal(animator.getState().finished, false);
  } finally { animator.dispose(); }
});

test('explicit looping imported motion wraps at its own duration', () => {
  const { cat, animator } = fixture();
  try {
    const clip = importedClip(animator, { duration: .8, endYaw: 0 });
    animator.addClip(clip, { loop: true }).play('Your motion', 0).seek(2.6);
    assert.ok(Math.abs(animator.getState().time - .2) < 1e-9);
    assert.equal(animator.getState().duration, .8);
    assert.equal(animator.getState().finished, false);
    assert.ok(cat.userData.rig.bones.Head.quaternion.angleTo(expectedHead(clip, .2)) < 1e-5);
    animator.seek(.78).update(.1);
    assert.ok(Math.abs(animator.getState().time - .08) < 1e-7);
    assert.equal(animator.getState().finished, false);
  } finally { animator.dispose(); }
});

test('replacement does not accumulate actions and active removal falls back to Idle', () => {
  const { cat, animator } = fixture();
  try {
    const originalActions = animator.mixer.stats.actions.total;
    for (let i = 0; i < 6; i++) {
      const clip = importedClip(animator, { duration: .7 + i * .1, endYaw: -.3 - i * .05 });
      animator.addClip(clip).play('Your motion', 0).seek(clip.duration / 2);
      assert.equal(animator.clips.filter(clip => clip.name === 'Your motion').length, 1);
      assert.equal(animator.clips.length, 20);
      assert.equal(animator.mixer.stats.actions.total, originalActions + 1);
      assert.equal(animator.getState().duration, clip.duration);
      assert.ok(cat.userData.rig.bones.Head.quaternion.angleTo(expectedHead(clip, clip.duration / 2)) < 1e-5);
    }
    assert.equal(animator.removeClip('Your motion'), true);
    assert.equal(animator.hasClip('Your motion'), false);
    assert.equal(animator.clips.length, 19);
    assert.equal(animator.mixer.stats.actions.total, originalActions);
    assert.equal(animator.getState().name, 'Idle');
    assert.equal(animator.getState().time, 0);
    assert.equal(animator.removeClip('Your motion'), false);
    assert.equal(animator.removeClip('Not imported'), false);
  } finally { animator.dispose(); }
});

test('import validation protects built-ins and rejects malformed or non-finite track data', () => {
  const { animator } = fixture();
  try {
    assert.throws(() => animator.addClip({ name: 'Your motion' }));
    assert.throws(() => animator.addClip(importedClip(animator, { name: 'Idle' })));
    assert.throws(() => animator.removeClip('Idle'));
    assert.equal(animator.hasClip('Idle'), true);
    for (const duration of [0, -1, NaN, Infinity, 21]) {
      const clip = importedClip(animator);
      clip.duration = duration;
      assert.throws(() => animator.addClip(clip), `duration ${duration} must be rejected`);
    }
    const cases = [
      clip => { clip.tracks = []; },
      clip => { clip.name = ''; },
      clip => { clip.tracks[0].name = 'UnknownBone.position'; },
      clip => { clip.tracks[0].name = 'Root.visible'; },
      clip => { clip.tracks[0].values[0] = NaN; },
      clip => { clip.tracks[0].times[0] = NaN; },
      clip => { clip.tracks[0].times[0] = -.01; },
      clip => { clip.tracks[0].times[2] = clip.tracks[0].times[1]; },
      clip => { clip.tracks[0].times[2] = clip.tracks[0].times[1] / 2; },
      clip => { clip.tracks[0].times[clip.tracks[0].times.length - 1] = 1.1; },
      clip => { const track = clip.tracks.find(track => track.name === 'Head.quaternion'); track.values = track.values.slice(0, -1); },
      clip => { const track = clip.tracks.find(track => track.name === 'Root.position'); track.values = track.values.slice(0, -1); },
      clip => { clip.tracks.push(clip.tracks.find(track => track.name === 'Head.quaternion').clone()); },
    ];
    for (const [index, mutate] of cases.entries()) {
      const clip = importedClip(animator);
      mutate(clip);
      assert.throws(() => animator.addClip(clip), `invalid clip case ${index} must be rejected`);
      assert.equal(animator.clips.length, 19);
      assert.equal(animator.hasClip('Your motion'), false);
    }
  } finally { animator.dispose(); }
});

class NodeFileReader {
  readAsArrayBuffer(blob) { this.read(blob, array => array); }
  readAsDataURL(blob) { this.read(blob, array => `data:${blob.type};base64,${Buffer.from(array).toString('base64')}`); }
  read(blob, convert) {
    blob.arrayBuffer().then(array => {
      this.result = convert(array);
      this.onload?.({ target: this });
      this.onloadend?.({ target: this });
    }, error => { this.error = error; this.onerror?.({ target: this }); });
  }
}

test('an imported motion exports and reloads with twenty clips, valid skins, and hidden props', async () => {
  const previousFileReader = globalThis.FileReader;
  globalThis.FileReader = NodeFileReader;
  const { cat, animator } = fixture();
  try {
    const clip = importedClip(animator);
    animator.addClip(clip).play('Your motion', 0).seek(.5);
    const expected = expectedHead(clip, .5);
    const exported = await exportAnimatedGLB(cat, animator.clips);
    assert.equal(exported.report.issues.numErrors, 0);
    assert.equal(exported.report.issues.numWarnings, 0);
    assert.equal(exported.animations.length, 20);
    assert.equal(exported.animations.filter(name => name === 'Your motion').length, 1);
    const binary = exported.binary;
    const buffer = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
    const loaded = await new GLTFLoader().parseAsync(buffer, '');
    assert.equal(loaded.animations.length, 20);
    const skins = [];
    loaded.scene.traverse(object => { if (object.isSkinnedMesh) skins.push(object); });
    assert.equal(skins.length, 19);
    for (const mesh of skins) {
      assert.equal(mesh.skeleton.bones.length, 26);
      assert.equal(mesh.geometry.attributes.skinIndex.count, mesh.geometry.attributes.position.count);
      assert.equal(mesh.geometry.attributes.skinWeight.count, mesh.geometry.attributes.position.count);
    }
    const mixer = new THREE.AnimationMixer(loaded.scene);
    const imported = loaded.animations.find(clip => clip.name === 'Your motion');
    mixer.clipAction(imported).play();
    mixer.setTime(.5);
    loaded.scene.updateMatrixWorld(true);
    assert.ok(loaded.scene.getObjectByName('Head').quaternion.angleTo(expected) < .003);
    for (const name of ['NoirBlaster', 'NoirSmokeProp']) assert.equal(loaded.scene.getObjectByName(name).scale.length(), 0);
    mixer.stopAllAction();
    mixer.uncacheRoot(loaded.scene);
  } finally {
    animator.dispose();
    if (previousFileReader === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = previousFileReader;
  }
});
