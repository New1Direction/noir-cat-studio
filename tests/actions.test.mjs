import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator, createAnimationClips } from '../src/animation.js';
import { ACTIONS, ONE_SHOT_CLIPS } from '../src/actions.js';
import { attachActionProps } from '../src/action-props.js';

const STYLES = ['original', 'dreamcast', 'ps1', 'ps2'];
const PROP_NAMES = ['NoirBlaster', 'NoirSmokeProp'];
const point = new THREE.Vector3();

function skinPoint(mesh, index, target = new THREE.Vector3()) {
  target.fromBufferAttribute(mesh.geometry.attributes.position, index);
  return mesh.applyBoneTransform(index, target);
}

function headSurfaceMetric(p) {
  if (p.y <= 3.28 || p.y >= 5.42) return Infinity;
  const t = p.y >= 4.17 ? (p.y - 4.17) / 1.25 : (p.y - 4.17) / 1.07;
  const exponent = t < 0 ? 2.85 : 2.05;
  const radius = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), exponent)), 1 / exponent);
  return Math.pow(Math.abs(p.x) / (1.58 * radius), 2.2) + Math.pow(Math.abs(p.z) / (.94 * radius), 2.2);
}

test('action clips carry finite skeleton and prop tracks with correct loop policy', () => {
  assert.deepEqual(ACTIONS.map(action => [action.name, action.duration, action.loop]), [
    ['Shoot', 1.6, false], ['Dive', 2.4, false], ['Smoke', 5, true],
  ]);
  assert.ok(ONE_SHOT_CLIPS.has('Sit') && ONE_SHOT_CLIPS.has('Shoot') && ONE_SHOT_CLIPS.has('Dive'));
  const cat = rigCat(createCat({ style: 'ps2' }));
  const clips = createAnimationClips(cat.userData.rig);
  for (const action of ACTIONS) {
    const clip = clips.find(clip => clip.name === action.name);
    assert.ok(clip);
    assert.equal(clip.duration, action.duration);
    assert.equal(clip.tracks.length, 26 * 3 + 4);
    for (const track of clip.tracks) {
      for (const value of track.values) assert.ok(Number.isFinite(value));
      if (track.name.endsWith('.quaternion')) {
        for (let i = 0; i < track.values.length; i += 4) {
          assert.ok(Math.abs(new THREE.Quaternion().fromArray(track.values, i).length() - 1) < 1e-6);
        }
      }
    }
    for (const name of PROP_NAMES) {
      assert.ok(clip.tracks.some(track => track.name === `${name}.scale`));
      assert.ok(clip.tracks.some(track => track.name === `${name}.quaternion`));
    }
  }
});

test('props stay attached to the existing wrist and disappear in unrelated clips', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const rig = cat.userData.rig;
  const props = attachActionProps(cat);
  const again = attachActionProps(cat);
  assert.equal(rig.skeleton.bones.length, 26);
  assert.equal(rig.meshes.length, 19);
  for (const name of PROP_NAMES) {
    assert.equal(props[name], again[name]);
    assert.equal(props[name].parent, rig.bones.Hand_R);
    assert.equal(props[name].visible, true);
    assert.equal(props[name].scale.length(), 0);
  }
  const animator = createAnimator(cat);
  animator.play('Shoot', 0).seek(.47);
  assert.ok(props.NoirBlaster.scale.x > .99);
  assert.equal(props.NoirSmokeProp.scale.length(), 0);
  animator.play('Smoke', 0).seek(1.5);
  assert.equal(props.NoirBlaster.scale.length(), 0);
  assert.ok(props.NoirSmokeProp.scale.x > .99);
  animator.play('Idle', 0).seek(.3);
  for (const prop of Object.values(props)) assert.equal(prop.scale.length(), 0);
  animator.dispose();
});

test('shoot recoils, smoke reaches the mouth, and dive holds its final horizontal pose', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const animator = createAnimator(cat);
  const b = cat.userData.rig.bones;
  animator.play('Shoot', 0).seek(.39);
  const aiming = b.Hand_R.getWorldPosition(new THREE.Vector3());
  animator.seek(.47);
  const recoil = b.Hand_R.getWorldPosition(new THREE.Vector3());
  assert.ok(aiming.z - recoil.z > .025, 'the muzzle needs a visible recoil beat');
  animator.seek(1.7);
  assert.equal(animator.getState().finished, true);
  assert.equal(cat.getObjectByName('NoirBlaster').scale.length(), 0);

  animator.play('Smoke', 0).seek(0);
  const lowered = b.Hand_R.getWorldPosition(new THREE.Vector3());
  animator.seek(1.5);
  const raised = b.Hand_R.getWorldPosition(new THREE.Vector3());
  assert.ok(raised.y - lowered.y > 1.7 && raised.z > 1.1);
  animator.seek(5.2);
  assert.equal(animator.getState().finished, false);
  assert.ok(animator.getState().time < .21);

  animator.play('Dive', 0).seek(2.5);
  assert.equal(animator.getState().finished, true);
  assert.ok(Math.abs(b.Root.quaternion.z + Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(b.Root.quaternion.w - Math.SQRT1_2) < 1e-6);
  assert.ok(b.Root.position.x < -2.4 && b.Root.position.y > 1.5);
  animator.dispose();
});

test('action props follow model front under a three-view model placement', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const animator = createAnimator(cat);
  cat.position.set(3.7, 0, 0);
  cat.rotation.y = Math.PI / 2;
  for (const [name, time, propName] of [['Shoot', .47, 'NoirBlaster'], ['Smoke', 1.5, 'NoirSmokeProp']]) {
    animator.play(name, 0).seek(time);
    cat.updateMatrixWorld(true);
    const expected = new THREE.Vector3(0, 0, 1).applyQuaternion(cat.getWorldQuaternion(new THREE.Quaternion()));
    const actual = new THREE.Vector3(0, 0, 1).applyQuaternion(cat.getObjectByName(propName).getWorldQuaternion(new THREE.Quaternion()));
    assert.ok(expected.dot(actual) > .99, `${name} prop must point with the model's front`);
  }
  animator.dispose();
});

for (const style of STYLES) {
  test(`${style}: action skins stay above ground and paws stay outside the head`, () => {
    const cat = rigCat(createCat({ style }));
    const animator = createAnimator(cat);
    const rig = cat.userData.rig;
    const headIndex = rig.skeleton.bones.indexOf(rig.bones.Head);
    const inverseHead = new THREE.Matrix4();
    for (const action of ACTIONS) {
      animator.play(action.name, 0);
      for (let frame = 0; frame <= 48; frame++) {
        animator.seek(action.duration * frame / 48);
        inverseHead.multiplyMatrices(rig.bones.Head.matrixWorld, rig.skeleton.boneInverses[headIndex]).invert();
        for (const mesh of rig.meshes) {
          for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
            skinPoint(mesh, i, point);
            assert.ok(point.y >= -.0001, `${action.name}/${mesh.name} crosses the floor at ${frame}`);
          }
        }
        for (const part of ['leftArm', 'rightArm']) {
          const arm = cat.userData.parts[part].children[0];
          for (let i = 0; i < arm.geometry.attributes.position.count; i++) {
            skinPoint(arm, i, point).applyMatrix4(inverseHead);
            assert.ok(headSurfaceMetric(point) >= .9999, `${action.name}/${part} enters the head at ${frame}`);
          }
        }
      }
    }
    animator.dispose();
  });
}

function relaxedArmTorsoMetric(p) {
  if (p.y <= 1.36 || p.y >= 3.20) return Infinity;
  const height = (p.y - 1.36) / 1.84;
  const lower = p.y < 1.49 ? Math.sqrt(Math.max(0, 1 - ((p.y - 1.49) / .13) ** 2)) : 1;
  const upper = p.y > 3.04 ? Math.sqrt(Math.max(0, 1 - ((p.y - 3.04) / .16) ** 2)) : 1;
  return (Math.abs(p.x) / ((.505 - .11 * height) * lower * upper)) ** 2.8
    + (Math.abs(p.z) / ((.35 - .065 * height) * lower * upper)) ** 2.8;
}

for (const style of STYLES) {
  test(`${style}: Smoke's free arm bends behind the torso and relaxes forward without clipping`, () => {
    const cat = rigCat(createCat({ style }));
    const animator = createAnimator(cat);
    const rig = cat.userData.rig;
    const mesh = cat.userData.parts.leftArm.children[0];
    const forearmStart = mesh.geometry.userData.armSections.forearm.start;
    const hipsIndex = rig.skeleton.bones.indexOf(rig.bones.Hips);
    const spineIndex = rig.skeleton.bones.indexOf(rig.bones.Spine);
    const position = new THREE.Vector3(), unposed = new THREE.Vector3();
    const blend = new THREE.Matrix4(), inverseBlend = new THREE.Matrix4();
    animator.play('Smoke', 0);
    const duration = animator.getState().duration;
    for (let frame = 0; frame <= 64; frame++) {
      animator.seek(duration * frame / 64);
      const context = `${style} Smoke free arm frame ${frame}`;
      const inverseSpine = rig.bones.Spine.matrixWorld.clone().invert();
      const shoulder = rig.bones.UpperArm_L.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseSpine);
      const elbow = rig.bones.Forearm_L.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseSpine);
      const paw = rig.bones.Hand_L.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseSpine);
      assert.ok(elbow.z - shoulder.z < -.20 && elbow.z - shoulder.z > -.55,
        `${context} elbow points forward instead of resting behind the body`);
      assert.ok(shoulder.y - elbow.y > .55, `${context} upper arm does not hang down naturally`);
      assert.ok(Math.abs(elbow.x - shoulder.x) < .38, `${context} elbow flares out from the body`);
      assert.ok(paw.z - elbow.z > .35, `${context} forearm bends backwards`);
      assert.ok(Math.abs(paw.x - elbow.x) < .22, `${context} forearm folds sideways`);
      const bend = elbow.clone().sub(shoulder).angleTo(paw.clone().sub(elbow));
      assert.ok(bend > .60 && bend < 1.80, `${context} elbow hyperextends or folds too tightly`);

      const hips = new THREE.Matrix4().multiplyMatrices(rig.bones.Hips.matrixWorld, rig.skeleton.boneInverses[hipsIndex]);
      const inverseHips = hips.clone().invert();
      const spine = new THREE.Matrix4().multiplyMatrices(rig.bones.Spine.matrixWorld, rig.skeleton.boneInverses[spineIndex]);
      // The upper shoulder attachment is intentionally fused. Check the entire
      // free forearm, elbow ball and paw surface against the deformed torso.
      for (let i = forearmStart; i < mesh.geometry.attributes.position.count; i++) {
        skinPoint(mesh, i, position);
        unposed.copy(position).applyMatrix4(inverseHips);
        for (let iteration = 0; iteration < 5; iteration++) {
          let weight = THREE.MathUtils.clamp((unposed.y - 1.72) / 1.10, 0, 1);
          weight = weight * weight * (3 - 2 * weight);
          for (let component = 0; component < 16; component++) {
            blend.elements[component] = hips.elements[component] * (1 - weight) + spine.elements[component] * weight;
          }
          unposed.copy(position).applyMatrix4(inverseBlend.copy(blend).invert());
        }
        assert.ok(relaxedArmTorsoMetric(unposed) >= .9999, `${context} forearm/elbow/paw surface enters the torso`);
      }
    }
    animator.dispose();
  });
}
