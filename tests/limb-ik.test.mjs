import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimationClips } from '../src/animation.js';
import { sampleActionPose } from '../src/actions.js';
import { attachActionProps } from '../src/action-props.js';
import { solveLimbIK, resetLimbIK } from '../src/limb-ik.js';

const RIGHT_ARM = ['UpperArm_R', 'Forearm_R', 'Hand_R'];
const RIGHT_LEG = ['Thigh_R', 'Shin_R', 'Foot_R'];
const vector = (x, y, z) => new THREE.Vector3(x, y, z);

function fixture() {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const rig = { ...cat.userData.rig, root: cat.userData.rig.bones.Root };
  return { cat, rig };
}

function pointModel(cat, bone) {
  return cat.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
}

function axialTwist(quaternion, axis) {
  const projection = vector(quaternion.x, quaternion.y, quaternion.z).dot(axis);
  const angle = 2 * Math.atan2(projection, quaternion.w);
  return THREE.MathUtils.euclideanModulo(angle + Math.PI, 2 * Math.PI) - Math.PI;
}

test('arm IK preserves a reachable endpoint and uses a pure, fixed-axis elbow hinge', () => {
  const { cat, rig } = fixture();
  const axis = rig.rest.Hand_R.position.clone().normalize();
  for (const target of [vector(.7, 2.1, .7), vector(1.7, 3.3, .05), vector(.2, 3.75, 1.1), vector(.4, 2.6, 1)]) {
    const solved = solveLimbIK(rig, RIGHT_ARM, target, vector(.25, -1, .4));
    assert.ok(pointModel(cat, rig.bones.Hand_R).distanceTo(solved.target) < 1e-7);
    assert.ok(solved.target.distanceTo(target) < 1e-7, 'reachable targets must not be moved');
    assert.ok(Math.abs(axialTwist(rig.bones.Forearm_R.quaternion, axis)) < 1e-7, 'forearm flexion must not acquire axial twist');
    for (const name of RIGHT_ARM) assert.ok(Math.abs(rig.bones[name].quaternion.length() - 1) < 1e-10);
  }
});

test('local joint frames are invariant under model placement, rotation and nonuniform scale', () => {
  const { cat, rig } = fixture();
  const target = vector(.72, 2.55, .9);
  const pole = vector(.25, -1, .3);
  solveLimbIK(rig, RIGHT_ARM, target, pole);
  const expected = RIGHT_ARM.map(name => rig.bones[name].quaternion.clone());
  for (const scale of [vector(1.3, 1.3, 1.3), vector(1.7, .8, 1.2)]) {
    cat.position.set(2, .4, -3);
    cat.rotation.set(.1, 1.2, .07);
    cat.scale.copy(scale);
    solveLimbIK(rig, RIGHT_ARM, target, pole);
    RIGHT_ARM.forEach((name, index) => assert.ok(rig.bones[name].quaternion.angleTo(expected[index]) < 1e-7, `${name} changed with actor placement`));
    assert.ok(pointModel(cat, rig.bones.Hand_R).distanceTo(target) < 1e-7);
  }
});

test('rotating Root and its model-space target/pole preserves the local arm pose', () => {
  const { cat, rig } = fixture();
  const target = vector(.72, 2.55, .9), pole = vector(.25, -1, .3);
  solveLimbIK(rig, RIGHT_ARM, target, pole);
  const expected = RIGHT_ARM.map(name => rig.bones[name].quaternion.clone());
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, -.5, .3));
  rig.root.quaternion.copy(rotation);
  rig.root.position.set(.3, .2, -.4);
  const moved = target.clone().applyQuaternion(rotation).add(rig.root.position);
  solveLimbIK(rig, RIGHT_ARM, moved, pole.clone().applyQuaternion(rotation));
  RIGHT_ARM.forEach((name, index) => assert.ok(rig.bones[name].quaternion.angleTo(expected[index]) < 1e-7));
  assert.ok(pointModel(cat, rig.bones.Hand_R).distanceTo(moved) < 1e-7);
});

test('continuous bend-plane frames remain smooth through antipodal rest-axis directions', () => {
  const { rig } = fixture();
  const shoulder = rig.bones.UpperArm_R.getWorldPosition(new THREE.Vector3());
  let previous;
  let firstForearm;
  for (let index = 0; index <= 360; index++) {
    const angle = index / 360 * Math.PI * 2;
    const target = shoulder.clone().add(vector(Math.cos(angle), Math.sin(angle), 0).multiplyScalar(1.1));
    solveLimbIK(rig, RIGHT_ARM, target, vector(0, 0, 1));
    const rotation = rig.bones.UpperArm_R.quaternion.clone();
    if (previous) assert.ok(previous.angleTo(rotation) < .018, 'a one-degree target step must not cause a roll flip');
    if (!firstForearm) firstForearm = rig.bones.Forearm_R.quaternion.clone();
    assert.ok(firstForearm.angleTo(rig.bones.Forearm_R.quaternion) < 1e-7, 'elbow flexion must be independent of the arm’s overall pointing direction');
    previous = rotation;
  }
});

test('singular-pole fallback and repeated paused solves stay finite and idempotent', () => {
  const { rig } = fixture();
  resetLimbIK(rig);
  const target = vector(.7, 2.2, .6);
  solveLimbIK(rig, RIGHT_ARM, target, vector(0, 0, 1));
  const direction = target.clone().sub(rig.bones.UpperArm_R.getWorldPosition(new THREE.Vector3())).normalize();
  solveLimbIK(rig, RIGHT_ARM, target, direction);
  const expected = RIGHT_ARM.map(name => rig.bones[name].quaternion.clone());
  for (let index = 0; index < 80; index++) {
    solveLimbIK(rig, RIGHT_ARM, target, direction);
    RIGHT_ARM.forEach((name, i) => assert.ok(rig.bones[name].quaternion.angleTo(expected[i]) < 1e-7));
  }
});

test('feet retain level/pitched model-space end rotations under actor placement', () => {
  const { cat, rig } = fixture();
  cat.position.set(2, .3, -1);
  cat.rotation.set(.1, .9, -.15);
  cat.scale.set(1.3, .9, 1.1);
  const pitch = new THREE.Quaternion().setFromAxisAngle(vector(1, 0, 0), .18);
  const target = vector(.37, .2, .35);
  solveLimbIK(rig, RIGHT_LEG, target, vector(0, 0, 1), { stableRoll: false, levelEnd: true, endRotation: pitch });
  assert.ok(pointModel(cat, rig.bones.Foot_R).distanceTo(target) < 1e-7);
  const relative = new THREE.Matrix4().multiplyMatrices(cat.matrixWorld.clone().invert(), rig.bones.Foot_R.matrixWorld);
  const actual = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(relative));
  assert.ok(actual.angleTo(pitch) < 1e-7);
});

test('all IK-driven built-in forearms bake without axial twist into ordinary quaternion tracks', () => {
  const { rig } = fixture();
  for (const clip of createAnimationClips(rig)) {
    if (clip.name === 'Idle') continue; // Idle deliberately adds a tiny direct forearm gesture.
    for (const side of ['L', 'R']) {
      if (clip.name === 'Wave' && side === 'L') continue;
      const track = clip.tracks.find(item => item.name === `Forearm_${side}.quaternion`);
      const axis = rig.rest[`Hand_${side}`].position.clone().normalize();
      for (let offset = 0; offset < track.values.length; offset += 4) {
        const quaternion = new THREE.Quaternion().fromArray(track.values, offset).normalize();
        assert.ok(Math.abs(axialTwist(quaternion, axis)) < 1e-6, `${clip.name}/${side} contains an unrequested elbow twist`);
      }
    }
  }
});

test('Shoot and Smoke subframe playback follows the authored hand path through reaches and recoil', () => {
  const { cat, rig } = fixture();
  attachActionProps(cat);
  const truth = fixture().rig;
  const clips = createAnimationClips(rig);
  const mixer = new THREE.AnimationMixer(cat);
  const targetAt = (name, time, duration) => {
    truth.resetPose();
    const targets = new Map();
    sampleActionPose(truth, name, time, duration, {
      solveTwoBone(_rig, limb, point) { targets.set(limb, point.clone()); },
      plantFeet() {}, blinkAt() { return 0; }, FOOT_HEIGHT: .133,
      rotate(bone, x = 0, y = 0, z = 0) { bone.quaternion.setFromEuler(new THREE.Euler(x, y, z)); },
    });
    return targets;
  };
  for (const name of ['Shoot', 'Smoke']) {
    const clip = clips.find(item => item.name === name);
    mixer.stopAllAction();
    const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1).play();
    action.clampWhenFinished = true;
    const intervals = Math.ceil(clip.duration * 240);
    let maxError = 0;
    for (let index = 0; index <= intervals; index++) {
      const time = index / intervals * clip.duration;
      mixer.setTime(time);
      cat.updateMatrixWorld(true);
      const targets = targetAt(name, time, clip.duration);
      for (const side of ['L', 'R']) {
        const actual = rig.bones[`Hand_${side}`].getWorldPosition(new THREE.Vector3());
        maxError = Math.max(maxError, actual.distanceTo(targets.get(`hand_${side.toLowerCase()}`)));
      }
    }
    assert.ok(maxError < (name === 'Shoot' ? .012 : .006), `${name} hand leaves its source path by ${maxError.toFixed(5)} model units`);
    // These were the former near-singular elbow-plane transition intervals.
    const critical = name === 'Shoot' ? .15 : 7 / 12;
    action.reset().play();
    mixer.setTime(critical); cat.updateMatrixWorld(true);
    const targets = targetAt(name, critical, clip.duration);
    for (const side of ['L', 'R']) {
      const actual = rig.bones[`Hand_${side}`].getWorldPosition(new THREE.Vector3());
      assert.ok(actual.distanceTo(targets.get(`hand_${side.toLowerCase()}`)) < .006, `${name}/${side} has a subframe reach excursion`);
    }
  }
  mixer.stopAllAction(); mixer.uncacheRoot(cat);
});
