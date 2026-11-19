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
const SIDES = ['L', 'R'];
const LIMBS = {
  hand_l: ['UpperArm_L', 'Forearm_L', 'Hand_L'], hand_r: ['UpperArm_R', 'Forearm_R', 'Hand_R'],
  foot_l: ['Thigh_L', 'Shin_L', 'Foot_L'], foot_r: ['Thigh_R', 'Shin_R', 'Foot_R'],
};
const vector = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

function legs(cat) {
  const b = cat.userData.rig.bones;
  const pelvisForward = vector(0, 0, 1).applyQuaternion(b.Hips.getWorldQuaternion(new THREE.Quaternion()));
  const actorForward = vector(0, 0, 1).applyQuaternion(b.Root.getWorldQuaternion(new THREE.Quaternion()));
  return Object.fromEntries(SIDES.map(side => {
    const hip = b[`Thigh_${side}`].getWorldPosition(vector());
    const knee = b[`Shin_${side}`].getWorldPosition(vector());
    const ankle = b[`Foot_${side}`].getWorldPosition(vector());
    const axis = ankle.clone().sub(hip).normalize();
    const bend = knee.clone().sub(hip);
    bend.addScaledVector(axis, -bend.dot(axis));
    const projected = forward => forward.clone().addScaledVector(axis, -forward.dot(axis)).normalize();
    const pelvisDirection = projected(pelvisForward);
    const actorDirection = projected(actorForward);
    const bendDirection = bend.clone().normalize();
    const planeNormal = new THREE.Vector3().crossVectors(axis, bendDirection).normalize();
    const flex = knee.clone().sub(hip).normalize().angleTo(ankle.clone().sub(knee).normalize());
    return [side, { hip, knee, ankle, axis, bend, bendDirection, planeNormal, flex,
      signedPelvis: bend.dot(pelvisDirection), signedActor: bend.dot(actorDirection),
      forwardRatio: bendDirection.dot(pelvisDirection) }];
  }));
}

function sourceSampler(cat) {
  const original = cat.userData.rig;
  const rig = { ...original, root: original.bones.Root };
  let goals;
  const solve = (r, limb, target, pole, endRotation = null) => {
    solveLimbIK(r, LIMBS[limb], target, pole, {
      stableRoll: limb.startsWith('hand'), levelEnd: limb.startsWith('foot'), endRotation,
    });
    goals.set(limb, { target: target.clone(), pole: pole.clone() });
  };
  const helpers = {
    FOOT_HEIGHT: .133,
    solveTwoBone: solve,
    plantFeet(r, spread = .37, forward = .07) {
      solve(r, 'foot_l', vector(-spread, .133, forward), vector(0, 0, 1));
      solve(r, 'foot_r', vector(spread, .133, forward), vector(0, 0, 1));
    },
    rotate(bone, x = 0, y = 0, z = 0) { bone.quaternion.setFromEuler(new THREE.Euler(x, y, z)); },
  };
  return (name, time, duration) => {
    original.resetPose();
    resetLimbIK(rig);
    goals = new Map();
    assert.equal(samplePartyDance(rig, name, time, duration, helpers), true);
    cat.updateMatrixWorld(true);
    return { legs: legs(cat), goals };
  };
}

// Minimum distance between two finite line segments, including endpoints.
function segmentDistance(p, q, r, s) {
  const a = q.clone().sub(p), b = s.clone().sub(r), delta = p.clone().sub(r);
  const aa = a.lengthSq(), bb = b.lengthSq(), ab = a.dot(b), ad = a.dot(delta), bd = b.dot(delta);
  let u = 0, v = 0;
  if (aa < 1e-12 && bb < 1e-12) return p.distanceTo(r);
  if (aa < 1e-12) v = THREE.MathUtils.clamp(bd / bb, 0, 1);
  else if (bb < 1e-12) u = THREE.MathUtils.clamp(-ad / aa, 0, 1);
  else {
    const denominator = aa * bb - ab * ab;
    if (denominator > 1e-12) u = THREE.MathUtils.clamp((ab * bd - ad * bb) / denominator, 0, 1);
    v = (ab * u + bd) / bb;
    if (v < 0) { v = 0; u = THREE.MathUtils.clamp(-ad / aa, 0, 1); }
    else if (v > 1) { v = 1; u = THREE.MathUtils.clamp((ab - ad) / aa, 0, 1); }
  }
  return p.clone().addScaledVector(a, u).distanceTo(r.clone().addScaledVector(b, v));
}

function assertForward(pose, where) {
  for (const side of SIDES) {
    const leg = pose[side];
    // Project against hip-to-ankle first: a turned or crossed foot must not be
    // mistaken for a reverse knee merely because of its screen-space position.
    assert.ok(leg.signedPelvis > .25, `${where}/${side} knee bends behind the pelvis`);
    assert.ok(leg.signedActor > .25, `${where}/${side} knee bends behind the actor`);
    assert.ok(leg.forwardRatio > .92, `${where}/${side} knee turns sideways during a forward step`);
    assert.ok(leg.flex > 40 * Math.PI / 180 && leg.flex < 82 * Math.PI / 180,
      `${where}/${side} has an implausible party-step bend`);
  }
}

test('all five party dances keep both source knees forward through turns and raised steps', () => {
  const sample = sourceSampler(rigCat(createCat({ style: 'ps2' })));
  for (const [name, duration] of PARTY) {
    for (let frame = 0; frame <= duration * 240; frame++) {
      const time = frame / 240;
      const pose = sample(name, time, duration);
      const where = `${name} ${time.toFixed(4)}s`;
      assertForward(pose.legs, where);
      for (const [side, limb] of [['L', 'foot_l'], ['R', 'foot_r']]) {
        const leg = pose.legs[side], goal = pose.goals.get(limb);
        assert.ok(leg.ankle.distanceTo(goal.target) < 1e-6, `${where}/${side} misses its authored step`);
        const projectedPole = goal.pole.clone().addScaledVector(leg.axis, -goal.pole.dot(leg.axis));
        assert.ok(projectedPole.length() / goal.pole.length() > .90, `${where}/${side} has an ambiguous knee plane`);
      }
    }
  }
});

test('party source knee positions, velocities, and bend planes close before baked endpoint copying', () => {
  const sample = sourceSampler(rigCat(createCat({ style: 'ps2' })));
  const epsilon = .0001;
  for (const [name, duration] of PARTY) {
    const start = sample(name, 0, duration).legs, end = sample(name, duration, duration).legs;
    const next = sample(name, epsilon, duration).legs, prior = sample(name, duration - epsilon, duration).legs;
    for (const side of SIDES) {
      for (const joint of ['hip', 'knee', 'ankle']) {
        assert.ok(start[side][joint].distanceTo(end[side][joint]) < 1e-9, `${name}/${side}/${joint} source loop has a seam`);
        const outgoing = next[side][joint].clone().sub(start[side][joint]).divideScalar(epsilon);
        const incoming = end[side][joint].clone().sub(prior[side][joint]).divideScalar(epsilon);
        assert.ok(outgoing.distanceTo(incoming) < .01, `${name}/${side}/${joint} reverses at the source loop`);
      }
      assert.ok(start[side].planeNormal.dot(end[side].planeNormal) > .99999999, `${name}/${side} knee plane flips at the source loop`);
    }
  }
});

test('both baked party knees preserve their source path and continuous bend planes between keys', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const animator = createAnimator(cat);
  const sample = sourceSampler(rigCat(createCat({ style: 'ps2' })));
  try {
    for (const [name, duration] of PARTY) {
      animator.play(name, 0);
      let previous;
      for (let frame = 0; frame < duration * 240; frame++) {
        const time = frame / 240;
        animator.seek(time);
        const actual = legs(cat), expected = sample(name, time, duration).legs;
        const where = `${name} ${time.toFixed(4)}s`;
        assertForward(actual, where);
        for (const side of SIDES) {
          assert.ok(actual[side].knee.distanceTo(expected[side].knee) < .0015, `${where}/${side} baked knee leaves its source path`);
          assert.ok(actual[side].ankle.distanceTo(expected[side].ankle) < .0015, `${where}/${side} baked ankle leaves its source path`);
          if (previous) {
            assert.ok(actual[side].planeNormal.dot(previous[side].planeNormal) > .999,
              `${where}/${side} knee plane flips between playback frames`);
          }
        }
        // Include the .1914 leg depth and its small bind-center offset from
        // the bone axis, rather than treating the visible leg as a thin line.
        for (const [a, b] of [[actual.L.hip, actual.L.knee], [actual.L.knee, actual.L.ankle]]) {
          for (const [c, d] of [[actual.R.hip, actual.R.knee], [actual.R.knee, actual.R.ankle]]) {
            assert.ok(segmentDistance(a, b, c, d) > .46, `${where} crosses the two leg corridors`);
          }
        }
        previous = actual;
      }
    }
  } finally { animator.dispose(); }
});

test('Groove Jam keeps intentional inward crossover steps without exchanging knees or reversing their hinges', () => {
  const sample = sourceSampler(rigCat(createCat({ style: 'ps2' })));
  const leftAccent = sample('Groove Jam', .5, 8).legs;
  const rightAccent = sample('Groove Jam', 1.5, 8).legs;
  assert.ok(leftAccent.L.ankle.x > -.20 && leftAccent.L.ankle.y > .25, 'left crossover must step inward and lift');
  assert.ok(rightAccent.R.ankle.x < .20 && rightAccent.R.ankle.y > .25, 'right crossover must step inward and lift');
  for (let frame = 0; frame <= 8 * 240; frame++) {
    const time = frame / 240;
    const pose = sample('Groove Jam', time, 8).legs;
    assert.ok(pose.L.ankle.x < -.15 && pose.R.ankle.x > .15, `Groove Jam ${time}s exchanges left/right feet`);
    assertForward(pose, `Groove Jam crossover ${time.toFixed(4)}s`);
  }
});

for (const style of STYLES) {
  test(`${style}: both party leg skins clear the floor and each other at source and baked key/mid-key times`, () => {
    const source = rigCat(createCat({ style })), baked = rigCat(createCat({ style }));
    const sample = sourceSampler(source), animator = createAnimator(baked);
    const point = vector();
    try {
      for (const [name, duration] of PARTY) {
        animator.play(name, 0);
        // All clips are baked at 30Hz. 60Hz covers each stored key and midpoint.
        for (let frame = 0; frame < duration * 60; frame++) {
          const time = frame / 60;
          sample(name, time, duration);
          animator.seek(time);
          for (const [label, cat] of [['source', source], ['baked', baked]]) {
            const bounds = {};
            for (const [side, part] of [['L', 'leftLeg'], ['R', 'rightLeg']]) {
              const mesh = cat.userData.parts[part].children[0];
              let sole = Infinity, minimumX = Infinity, maximumX = -Infinity;
              for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
                mesh.getVertexPosition(i, point);
                sole = Math.min(sole, point.y);
                minimumX = Math.min(minimumX, point.x);
                maximumX = Math.max(maximumX, point.x);
              }
              bounds[side] = { minimumX, maximumX };
              const where = `${style}/${name}/${label}/${side} ${time.toFixed(4)}s`;
              assert.ok(sole >= -.0001, `${where} leg skin crosses the floor`);
              const ankle = cat.userData.rig.bones[`Foot_${side}`].getWorldPosition(vector());
              if (ankle.y < .1335) assert.ok(sole < .005, `${where} planted sole floats above the floor`);
            }
            // These inward party steps never exchange the feet. Disjoint
            // actual skin X bounds prove that the legs do not intersect.
            assert.ok(bounds.L.maximumX < bounds.R.minimumX,
              `${style}/${name}/${label} ${time.toFixed(4)}s leg skins intersect during a cross-step`);
          }
        }
      }
    } finally { animator.dispose(); }
  });
}
