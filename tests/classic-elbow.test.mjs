import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator } from '../src/animation.js';
import { sampleClassicDance } from '../src/dances-classic.js';
import { solveLimbIK, resetLimbIK } from '../src/limb-ik.js';

const CLIPS = [['Floss', 4], ['Orange Justice', 4], ['Best Mates', 4], ['Take the L', 4], ['Electro Shuffle', 6]];
const LIMBS = { hand_l: ['UpperArm_L', 'Forearm_L', 'Hand_L'], hand_r: ['UpperArm_R', 'Forearm_R', 'Hand_R'], foot_l: ['Thigh_L', 'Shin_L', 'Foot_L'], foot_r: ['Thigh_R', 'Shin_R', 'Foot_R'] };
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

function fixture(style = 'ps2') {
  const cat = rigCat(createCat({ style }));
  const rig = { ...cat.userData.rig, root: cat.userData.rig.bones.Root };
  const targets = new Map();
  const helpers = {
    FOOT_HEIGHT: .133,
    solveTwoBone(actor, limb, target, pole, endRotation = null) {
      targets.set(limb, { target: target.clone(), pole: pole.clone() });
      solveLimbIK(actor, LIMBS[limb], target, pole, { stableRoll: limb.startsWith('hand'), levelEnd: limb.startsWith('foot'), endRotation });
    },
    plantFeet(actor, spread = .37, forward = .07) {
      this.solveTwoBone(actor, 'foot_l', V(-spread, .133, forward), V(0, 0, 1));
      this.solveTwoBone(actor, 'foot_r', V(spread, .133, forward), V(0, 0, 1));
    },
    rotate(bone, x = 0, y = 0, z = 0) { bone.quaternion.setFromEuler(new THREE.Euler(x, y, z)); },
    smooth(value) { const t = THREE.MathUtils.clamp(value, 0, 1); return t * t * (3 - 2 * t); },
    blinkAt() { return 0; },
  };
  return { cat, rig, targets, sample(name, time, duration) {
    rig.resetPose(); targets.clear();
    assert.equal(sampleClassicDance(rig, name, time, duration, helpers), true);
    cat.updateMatrixWorld(true);
  } };
}

function torsoPoints(rig, side) {
  const inverse = rig.bones.Spine.matrixWorld.clone().invert();
  return ['UpperArm', 'Forearm', 'Hand'].map(name => rig.bones[`${name}_${side}`].getWorldPosition(V()).applyMatrix4(inverse));
}

test('both classic elbows follow their gesture rather than a universal world-front rule', () => {
  const actor = fixture();
  for (const [name, duration] of CLIPS) {
    resetLimbIK(actor.rig);
    for (let frame = 0; frame <= duration * 120; frame++) {
      const time = frame / 120;
      actor.sample(name, time, duration);
      for (const [side, sign] of [['L', -1], ['R', 1]]) {
        const [shoulder, elbow, hand] = torsoPoints(actor.rig, side);
        if (['Orange Justice', 'Best Mates', 'Electro Shuffle'].includes(name)) {
          assert.ok(hand.z - elbow.z > .25, `${name}/${side}/${time}: low front paw folds backward`);
          assert.ok(elbow.y < shoulder.y - .25, `${name}/${side}: low-gesture elbow rises to shoulder height`);
          assert.ok(sign * elbow.x > .4, `${name}/${side}: elbow crosses through the torso`);
        } else if (name === 'Floss') {
          // A front/behind sweep needs its elbow on that same side of the body;
          // its forearm may point slightly back while wrapping around the belly.
          if (hand.z > .12) assert.ok(elbow.z > -.02, `${name}/${side}: front sweep routed behind the torso`);
          if (hand.z > .12) assert.ok(hand.z - elbow.z > -.01, `${name}/${side}: front elbow juts ahead of the crossing paw`);
          if (hand.z < -.12) assert.ok(elbow.z < .02, `${name}/${side}: back sweep routed across the front`);
        } else if (side === 'L') {
          assert.ok(hand.y > shoulder.y && elbow.y < hand.y - .30, 'the raised salute needs its elbow below the paw');
          assert.ok(elbow.x < -.9, 'the salute elbow must stay outside the cheek');
        } else {
          assert.ok(elbow.x > hand.x + .25, 'the hip gesture should retain its outward elbow');
          assert.ok(hand.z > elbow.z + .10, 'the low hip paw should stay in front of its elbow');
        }
        const { pole } = actor.targets.get(`hand_${side.toLowerCase()}`);
        const direction = actor.rig.bones[`Hand_${side}`].getWorldPosition(V())
          .sub(actor.rig.bones[`UpperArm_${side}`].getWorldPosition(V())).normalize();
        const projection = pole.clone().addScaledVector(direction, -pole.dot(direction)).length() / pole.length();
        assert.ok(projection > .30, `${name}/${side}: near-singular elbow pole`);
      }
    }
  }
});

test('Floss retains its lateral/vertical sweep with only a bounded smooth front-clearance arc', () => {
  const actor = fixture();
  let largest = 0;
  for (let frame = 0; frame <= 480; frame++) {
    const time = frame / 120, phase = 2 * Math.PI * time / .8, swing = Math.sin(phase);
    actor.sample('Floss', time, 4);
    for (const side of [-1, 1]) {
      const target = actor.targets.get(side < 0 ? 'hand_l' : 'hand_r').target;
      assert.ok(Math.abs(target.x - (side * .72 + .48 * swing)) < 1e-10);
      assert.ok(Math.abs(target.y - (1.67 + .045 * Math.cos(phase * 2))) < 1e-10);
      const originalDepth = -.51 * side * swing;
      const displacement = target.z - originalDepth;
      assert.ok(displacement >= -1e-10 && displacement <= .1500001, 'belly clearance must stay within .15 model units');
      if (originalDepth < 0) assert.ok(Math.abs(displacement) < 1e-10, 'the behind-body exchange must remain intact');
      largest = Math.max(largest, displacement);
    }
  }
  assert.ok(largest > .149, 'the front-route clearance must actually be exercised');
});

function headMetric(point, attachment = false) {
  // Only the upper segment owns the neck/shoulder attachment allowance.
  // Free elbows, forearms and paw caps must clear the true 3.10 head bottom.
  if (point.y <= (attachment ? 3.28 : 3.10) || point.y >= 5.42) return Infinity;
  const t = point.y >= 4.17 ? (point.y - 4.17) / 1.25 : (point.y - 4.17) / 1.07;
  const exponent = t < 0 ? 2.85 : 2.05;
  const radius = (1 - Math.abs(t) ** exponent) ** (1 / exponent);
  return (Math.abs(point.x) / (1.58 * radius)) ** 2.2 + (Math.abs(point.z) / (.94 * radius)) ** 2.2;
}
function torsoMetric(point) {
  if (point.y <= 1.36 || point.y >= 3.20) return Infinity;
  const height = (point.y - 1.36) / 1.84;
  const bottom = point.y < 1.49 ? Math.sqrt(Math.max(0, 1 - ((point.y - 1.49) / .13) ** 2)) : 1;
  const top = point.y > 3.04 ? Math.sqrt(Math.max(0, 1 - ((point.y - 3.04) / .16) ** 2)) : 1;
  return (Math.abs(point.x) / ((.505 - .11 * height) * bottom * top)) ** 2.8
    + (Math.abs(point.z) / ((.35 - .065 * height) * bottom * top)) ** 2.8;
}
function weightSampler(mesh, spineIndex) {
  const rows = new Map(), { position, skinIndex, skinWeight } = mesh.geometry.attributes;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (rows.has(y)) continue;
    let weight = 0;
    for (let j = 0; j < 4; j++) if (skinIndex.getComponent(i, j) === spineIndex) weight += skinWeight.getComponent(i, j);
    rows.set(y, weight);
  }
  const samples = [...rows].sort((a, b) => a[0] - b[0]);
  return y => {
    if (y <= samples[0][0]) return samples[0][1];
    if (y >= samples.at(-1)[0]) return samples.at(-1)[1];
    let low = 0, high = samples.length - 1;
    while (high - low > 1) { const middle = (low + high) >> 1; if (samples[middle][0] <= y) low = middle; else high = middle; }
    return THREE.MathUtils.lerp(samples[low][1], samples[high][1], (y - samples[low][0]) / (samples[high][0] - samples[low][0]));
  };
}

for (const style of ['original', 'dreamcast', 'ps1', 'ps2']) {
  test(`${style}: both complete classic arms clear head, floor and free-arm torso volume, including subframes`, () => {
    const { cat, rig } = fixture(style), animator = createAnimator(cat);
    const index = name => rig.skeleton.bones.indexOf(rig.bones[name]);
    const weightAtY = weightSampler(cat.userData.parts.body, index('Spine'));
    const point = V(), unposed = V(), blend = new THREE.Matrix4(), inverse = new THREE.Matrix4();
    for (const [name, duration] of CLIPS) {
      animator.play(name, 0);
      for (let frame = 0; frame < 96; frame++) {
        const time = (frame + .37) / 96 * duration;
        animator.seek(time);
        const hips = new THREE.Matrix4().multiplyMatrices(rig.bones.Hips.matrixWorld, rig.skeleton.boneInverses[index('Hips')]);
        const spine = new THREE.Matrix4().multiplyMatrices(rig.bones.Spine.matrixWorld, rig.skeleton.boneInverses[index('Spine')]);
        const inverseHips = hips.clone().invert();
        const inverseHead = new THREE.Matrix4().multiplyMatrices(rig.bones.Head.matrixWorld, rig.skeleton.boneInverses[index('Head')]).invert();
        for (const [side, part] of [['L', 'leftArm'], ['R', 'rightArm']]) {
          const mesh = cat.userData.parts[part].children[0], attributes = mesh.geometry.attributes;
          for (let vertex = 0; vertex < attributes.position.count; vertex++) {
            point.fromBufferAttribute(attributes.position, vertex); mesh.applyBoneTransform(vertex, point);
            const context = `${style}/${name}/${side}/${time.toFixed(4)}/vertex ${vertex}`;
            assert.ok(point.y >= -.0001, `${context}: arm crosses floor`);
            const isUpper = attributes.skinIndex.getX(vertex) === index(`UpperArm_${side}`);
            assert.ok(headMetric(unposed.copy(point).applyMatrix4(inverseHead), isUpper) >= .9999, `${context}: arm enters head`);
            // The upper segment joins the shoulder/armpit volume, as in the
            // existing gait guard. Every elbow/forearm/cap vertex stays free.
            if (isUpper) continue;
            unposed.copy(point).applyMatrix4(inverseHips);
            for (let iteration = 0; iteration < 5; iteration++) {
              const weight = weightAtY(unposed.y);
              for (let component = 0; component < 16; component++) blend.elements[component] = hips.elements[component] * (1 - weight) + spine.elements[component] * weight;
              unposed.copy(point).applyMatrix4(inverse.copy(blend).invert());
            }
            assert.ok(torsoMetric(unposed) >= .9999, `${context}: free arm enters torso`);
          }
        }
      }
    }
    animator.dispose();
  });
}

test('all classic source poses close smoothly and baked hand/elbow paths follow their source between keys', () => {
  const source = fixture(), playback = fixture(), animator = createAnimator(playback.cat);
  const names = ['UpperArm_L', 'Forearm_L', 'Hand_L', 'UpperArm_R', 'Forearm_R', 'Hand_R'];
  const observe = rig => names.map(name => rig.bones[name].getWorldPosition(V()));
  for (const [name, duration] of CLIPS) {
    resetLimbIK(source.rig);
    source.sample(name, 0, duration); const first = observe(source.rig);
    source.sample(name, duration, duration); const last = observe(source.rig);
    first.forEach((point, i) => assert.ok(point.distanceTo(last[i]) < 1e-8, `${name} source loop does not close`));
    const dt = 1 / 1000;
    source.sample(name, dt, duration); const after = observe(source.rig);
    source.sample(name, duration - dt, duration); const before = observe(source.rig);
    for (let i = 0; i < names.length; i++) {
      const incoming = first[i].clone().sub(before[i]).divideScalar(dt), outgoing = after[i].clone().sub(first[i]).divideScalar(dt);
      assert.ok(incoming.distanceTo(outgoing) < .4, `${name}/${names[i]} source velocity jumps at loop`);
    }
    animator.play(name, 0);
    for (let frame = 0; frame <= duration * 120; frame++) {
      const time = frame / 120;
      source.sample(name, time, duration); animator.seek(time);
      const expected = observe(source.rig), actual = observe(playback.rig);
      for (let i = 0; i < names.length; i++) assert.ok(actual[i].distanceTo(expected[i]) < .035, `${name}/${names[i]}/${time}: baked elbow/hand leaves its source path`);
    }
  }
  animator.dispose();
});
