import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator } from '../src/animation.js';
import { samplePartyDance } from '../src/dances-party.js';
import { solveLimbIK, resetLimbIK } from '../src/limb-ik.js';

const PARTY = [['Fresh', 4], ['Dance Moves', 8], ['Dab', 4], ['Hype', 4], ['Groove Jam', 8]];
const STYLES = ['original', 'dreamcast', 'ps1', 'ps2'];
const LIMBS = {
  hand_l: ['UpperArm_L', 'Forearm_L', 'Hand_L'], hand_r: ['UpperArm_R', 'Forearm_R', 'Hand_R'],
  foot_l: ['Thigh_L', 'Shin_L', 'Foot_L'], foot_r: ['Thigh_R', 'Shin_R', 'Foot_R'],
};
const vector = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

function sourceSampler(cat) {
  const original = cat.userData.rig;
  const rig = { ...original, root: original.bones.Root };
  let targets;
  const solve = (rig, limb, target, pole, endRotation = null) => {
    const result = solveLimbIK(rig, LIMBS[limb], target, pole, {
      stableRoll: limb.startsWith('hand'), levelEnd: limb.startsWith('foot'), endRotation,
    });
    const direction = target.clone().sub(result.start).normalize();
    const projected = pole.clone().addScaledVector(direction, -pole.dot(direction));
    targets.set(limb, { target: target.clone(), poleRatio: projected.length() / pole.length() });
  };
  const helpers = {
    FOOT_HEIGHT: .133,
    solveTwoBone: solve,
    plantFeet(rig, spread = .37, forward = .07) {
      solve(rig, 'foot_l', vector(-spread, .133, forward), vector(0, 0, 1));
      solve(rig, 'foot_r', vector(spread, .133, forward), vector(0, 0, 1));
    },
    rotate(bone, x = 0, y = 0, z = 0) { bone.quaternion.setFromEuler(new THREE.Euler(x, y, z)); },
  };
  return (name, time, duration) => {
    original.resetPose();
    resetLimbIK(rig);
    targets = new Map();
    assert.equal(samplePartyDance(rig, name, time, duration, helpers), true);
    cat.updateMatrixWorld(true);
    const inverseSpine = rig.bones.Spine.matrixWorld.clone().invert();
    const arms = {};
    for (const [side, limb] of [['L', 'hand_l'], ['R', 'hand_r']]) {
      const shoulder = rig.bones[`UpperArm_${side}`].getWorldPosition(vector());
      const elbow = rig.bones[`Forearm_${side}`].getWorldPosition(vector());
      const hand = rig.bones[`Hand_${side}`].getWorldPosition(vector());
      arms[side] = {
        shoulder, elbow, hand, localElbow: elbow.clone().applyMatrix4(inverseSpine),
        requested: targets.get(limb).target, poleRatio: targets.get(limb).poleRatio,
        upperRotation: rig.bones[`UpperArm_${side}`].getWorldQuaternion(new THREE.Quaternion()).normalize(),
        lowerRotation: rig.bones[`Forearm_${side}`].getWorldQuaternion(new THREE.Quaternion()).normalize(),
      };
    }
    return { arms, targets };
  };
}

test('both party elbows use continuous corridors while retaining reachable hand targets', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const sample = sourceSampler(cat);
  for (const [name, duration] of PARTY) {
    for (let frame = 0; frame <= duration * 120; frame++) {
      const pose = sample(name, frame / 120, duration);
      for (const side of ['L', 'R']) {
        const arm = pose.arms[side];
        const where = `${name}/${side} ${(frame / 120).toFixed(3)}s`;
        assert.ok(arm.poleRatio > .50, `${where} approaches an ambiguous elbow plane`);
        assert.ok(arm.hand.distanceTo(arm.requested) < .00001, `${where} changes the authored hand target`);
        assert.ok(Math.abs(arm.upperRotation.length() - 1) < 1e-7);
        assert.ok(Math.abs(arm.lowerRotation.length() - 1) < 1e-7);
      }
    }
  }
});

test('party source loops close with matching elbow and hand velocities before endpoint copying', () => {
  const sample = sourceSampler(rigCat(createCat({ style: 'ps2' })));
  const epsilon = .0005;
  for (const [name, duration] of PARTY) {
    const start = sample(name, 0, duration), end = sample(name, duration, duration);
    const after = sample(name, epsilon, duration), before = sample(name, duration - epsilon, duration);
    for (const side of ['L', 'R']) {
      for (const joint of ['elbow', 'hand']) {
        assert.ok(start.arms[side][joint].distanceTo(end.arms[side][joint]) < 1e-10, `${name}/${side}/${joint} has a source seam`);
        const outgoing = after.arms[side][joint].clone().sub(start.arms[side][joint]).divideScalar(epsilon);
        const incoming = end.arms[side][joint].clone().sub(before.arms[side][joint]).divideScalar(epsilon);
        assert.ok(outgoing.distanceTo(incoming) < .06, `${name}/${side}/${joint} reverses abruptly at the loop`);
      }
      assert.ok(start.arms[side].upperRotation.angleTo(end.arms[side].upperRotation) < 1e-7);
      assert.ok(start.arms[side].lowerRotation.angleTo(end.arms[side].lowerRotation) < 1e-7);
    }
  }
});

test('low pumps, chest sweeps, and raised dabs retain different intentional elbow directions', () => {
  const sample = sourceSampler(rigCat(createCat({ style: 'ps2' })));
  for (let frame = 0; frame < 240; frame++) {
    const time = 4 * frame / 240;
    for (const [name, duration] of [['Fresh', 4], ['Hype', 4]]) {
      const { arms } = sample(name, time, duration);
      for (const [side, sign] of [['L', -1], ['R', 1]]) {
        const arm = arms[side];
        assert.ok(sign * arm.localElbow.x > .70, `${name}/${side} elbow enters the torso's central corridor`);
        if (name === 'Fresh') assert.ok(arm.hand.z - arm.elbow.z > .60, `${side} chest-sweep forearm turns backwards`);
        if (name === 'Hype' && arm.hand.y < 2.35) {
          assert.ok(arm.hand.z - arm.elbow.z > .25, `${side} low pump folds behind its elbow`);
          assert.ok(arm.shoulder.y - arm.elbow.y > .35, `${side} low pump hikes the shoulder`);
        }
      }
    }
  }
  for (const [time, raised, folded] of [[1, 'R', 'L'], [3, 'L', 'R']]) {
    const { arms } = sample('Dab', time, 4);
    assert.ok(arms[raised].elbow.y < arms[raised].hand.y - .25, 'raised dab needs its elbow below the pointing paw');
    assert.ok(arms[raised].elbow.z > arms[raised].shoulder.z + .05, 'raised dab must keep its forward head-safe corridor');
    assert.ok(arms[folded].elbow.z > .45, 'crossed dab needs the elbow in front of the torso');
    assert.ok((folded === 'L' ? -1 : 1) * arms[folded].elbow.x > .10, 'crossed paw must not drag the opposite elbow through the belly');
  }
});

test('baked party hand curves and arm frames stay smooth between keys on both sides', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const animator = createAnimator(cat);
  const source = sourceSampler(rigCat(createCat({ style: 'ps2' })));
  try {
    for (const [name, duration] of PARTY) {
      animator.play(name, 0);
      for (let frame = 0; frame < duration * 120; frame++) {
        const time = frame / 120;
        animator.seek(time);
        const expected = source(name, time, duration);
        for (const side of ['L', 'R']) {
          const actual = cat.userData.rig.bones[`Hand_${side}`].getWorldPosition(vector());
          assert.ok(actual.distanceTo(expected.arms[side].hand) < (name === 'Dab' ? .010 : .004), `${name}/${side} baked interpolation leaves the authored hand curve`);
        }
      }
      const previous = new Map();
      for (let frame = 0; frame <= duration * 30; frame++) {
        animator.seek(frame / 30);
        for (const boneName of ['UpperArm_L', 'Forearm_L', 'UpperArm_R', 'Forearm_R']) {
          const q = cat.userData.rig.bones[boneName].getWorldQuaternion(new THREE.Quaternion()).normalize();
          if (previous.has(boneName)) {
            assert.ok(previous.get(boneName).angleTo(q) < (name === 'Dab' ? 24 : 9) * Math.PI / 180, `${name}/${boneName} flips its arm frame between keys`);
          }
          previous.set(boneName, q);
        }
      }
    }
  } finally { animator.dispose(); }
});

function torsoMetric(point) {
  if (point.y <= 1.36 || point.y >= 3.20) return Infinity;
  const t = (point.y - 1.36) / 1.84;
  const lower = point.y < 1.49 ? Math.sqrt(Math.max(0, 1 - ((point.y - 1.49) / .13) ** 2)) : 1;
  const upper = point.y > 3.04 ? Math.sqrt(Math.max(0, 1 - ((point.y - 3.04) / .16) ** 2)) : 1;
  return (Math.abs(point.x) / ((.505 - .11 * t) * lower * upper)) ** 2.8
    + (Math.abs(point.z) / ((.35 - .065 * t) * lower * upper)) ** 2.8;
}

function headMetric(point, neckJoin) {
  if (point.y <= neckJoin || point.y >= 5.42) return Infinity;
  const t = point.y >= 4.17 ? (point.y - 4.17) / 1.25 : (point.y - 4.17) / 1.07;
  const exponent = t < 0 ? 2.85 : 2.05;
  const radius = (1 - Math.abs(t) ** exponent) ** (1 / exponent);
  return (Math.abs(point.x) / (1.58 * radius)) ** 2.2 + (Math.abs(point.z) / (.94 * radius)) ** 2.2;
}

for (const style of STYLES) {
  test(`${style}: both party elbow/forearm/paw surfaces clear torso, head, and floor through every phrase`, () => {
    const cat = rigCat(createCat({ style }));
    const rig = cat.userData.rig;
    const animator = createAnimator(cat);
    const index = name => rig.skeleton.bones.indexOf(rig.bones[name]);
    const hipsIndex = index('Hips'), spineIndex = index('Spine'), headIndex = index('Head');
    const point = vector(), unposed = vector(), blend = new THREE.Matrix4(), inverseBlend = new THREE.Matrix4();
    try {
      for (const [name, duration] of PARTY) {
        animator.play(name, 0);
        for (let frame = 0; frame <= 96; frame++) {
          const time = duration * frame / 96;
          animator.seek(time);
          const hips = new THREE.Matrix4().multiplyMatrices(rig.bones.Hips.matrixWorld, rig.skeleton.boneInverses[hipsIndex]);
          const spine = new THREE.Matrix4().multiplyMatrices(rig.bones.Spine.matrixWorld, rig.skeleton.boneInverses[spineIndex]);
          const inverseHips = hips.clone().invert();
          const inverseHead = new THREE.Matrix4().multiplyMatrices(rig.bones.Head.matrixWorld, rig.skeleton.boneInverses[headIndex]).invert();
          for (const [side, part] of [['L', 'leftArm'], ['R', 'rightArm']]) {
            const mesh = cat.userData.parts[part].children[0];
            const forearmStart = mesh.geometry.userData.armSections.forearm.start;
            const where = `${style}/${name}/${side} ${time.toFixed(3)}s`;
            for (let vertex = 0; vertex < mesh.geometry.attributes.position.count; vertex++) {
              mesh.getVertexPosition(vertex, point);
              assert.ok(point.y >= -.0001, `${where} arm surface crosses the floor`);
              unposed.copy(point).applyMatrix4(inverseHead);
              // Only the proximal shoulder is deliberately fused below 3.28.
              // Free elbow, forearm and paw surfaces get the full head test.
              assert.ok(headMetric(unposed, vertex < forearmStart ? 3.28 : 3.10) >= .9999, `${where} arm surface enters the head`);
              if (vertex < forearmStart) continue;
              unposed.copy(point).applyMatrix4(inverseHips);
              for (let iteration = 0; iteration < 5; iteration++) {
                let weight = THREE.MathUtils.clamp((unposed.y - 1.72) / 1.10, 0, 1);
                weight = weight * weight * (3 - 2 * weight);
                for (let component = 0; component < 16; component++) blend.elements[component] = hips.elements[component] * (1 - weight) + spine.elements[component] * weight;
                unposed.copy(point).applyMatrix4(inverseBlend.copy(blend).invert());
              }
              assert.ok(torsoMetric(unposed) >= .9999, `${where} elbow/forearm/paw surface enters the torso`);
            }
          }
        }
      }
    } finally { animator.dispose(); }
  });
}
