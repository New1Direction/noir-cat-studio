import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator } from '../src/animation.js';
import { sampleClassicDance } from '../src/dances-classic.js';
import { solveLimbIK } from '../src/limb-ik.js';

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
      targets.set(limb, { target: target.clone(), endRotation: endRotation?.clone() });
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

function kneeFrame(rig, side) {
  const inverse = rig.bones.Hips.matrixWorld.clone().invert();
  const [hip, knee, ankle] = ['Thigh', 'Shin', 'Foot'].map(name => rig.bones[`${name}_${side}`].getWorldPosition(V()).applyMatrix4(inverse));
  const upper = knee.clone().sub(hip).normalize(), lower = ankle.clone().sub(knee).normalize();
  const axis = ankle.clone().sub(hip).normalize();
  const bend = knee.clone().sub(hip).addScaledVector(axis, -knee.clone().sub(hip).dot(axis));
  const cross = V().crossVectors(upper, lower);
  const footRight = V(1, 0, 0).applyQuaternion(rig.bones[`Foot_${side}`].getWorldQuaternion(new THREE.Quaternion())).transformDirection(inverse);
  return { hip, knee, ankle, bend, normal: cross.clone().normalize(),
    signedHip: Math.atan2(cross.x, upper.dot(lower)),
    signedFoot: Math.atan2(cross.dot(footRight), upper.dot(lower)),
  };
}

// Exact triangle-surface distance: vertex/face, edge/edge and piercing-edge
// cases, with an AABB hierarchy so near-crossing poses stay cheap to inspect.
function surfaceTree(mesh) {
  const vertices = Array.from({ length: mesh.geometry.attributes.position.count }, (_, index) => mesh.getVertexPosition(index, V()).applyMatrix4(mesh.matrixWorld));
  const indices = mesh.geometry.index;
  const triangles = [];
  for (let index = 0; index < (indices?.count ?? vertices.length); index += 3) {
    const triangle = new THREE.Triangle(...[0, 1, 2].map(offset => vertices[indices ? indices.getX(index + offset) : index + offset]));
    if (triangle.getArea() < 1e-12) continue;
    triangles.push({ triangle, box: new THREE.Box3().setFromPoints([triangle.a, triangle.b, triangle.c]), center: triangle.getMidpoint(V()) });
  }
  const build = values => {
    const box = new THREE.Box3(); values.forEach(value => box.union(value.box));
    if (values.length <= 4) return { box, triangles: values, count: values.length };
    const size = box.getSize(V()), axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
    values.sort((a, b) => a.center[axis] - b.center[axis]);
    const middle = values.length >> 1;
    return { box, left: build(values.slice(0, middle)), right: build(values.slice(middle)), count: values.length };
  };
  return build(triangles);
}

function boxDistanceSquared(a, b) {
  let squared = 0;
  for (const axis of ['x', 'y', 'z']) squared += Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]) ** 2;
  return squared;
}

function segmentDistanceSquared(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.lengthSq(), e = d2.lengthSq(), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-16 && e <= 1e-16) return p1.distanceToSquared(p2);
  if (a <= 1e-16) t = THREE.MathUtils.clamp(f / e, 0, 1);
  else {
    const c = d1.dot(r);
    if (e <= 1e-16) s = THREE.MathUtils.clamp(-c / a, 0, 1);
    else {
      const b = d1.dot(d2), denominator = a * e - b * b;
      if (Math.abs(denominator) > 1e-16) s = THREE.MathUtils.clamp((b * f - c * e) / denominator, 0, 1);
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  return p1.clone().addScaledVector(d1, s).distanceToSquared(p2.clone().addScaledVector(d2, t));
}

function triangleDistanceSquared(a, b) {
  let best = Infinity;
  const pointsA = [a.a, a.b, a.c], pointsB = [b.a, b.b, b.c], closest = V();
  for (const point of pointsA) best = Math.min(best, b.closestPointToPoint(point, closest).distanceToSquared(point));
  for (const point of pointsB) best = Math.min(best, a.closestPointToPoint(point, closest).distanceToSquared(point));
  for (let i = 0; i < 3; i++) {
    const start = pointsA[i], end = pointsA[(i + 1) % 3], direction = end.clone().sub(start), length = direction.length();
    const hit = new THREE.Ray(start, direction.divideScalar(length)).intersectTriangle(b.a, b.b, b.c, false, closest);
    if (hit && hit.distanceToSquared(start) <= length * length + 1e-12) return 0;
    const reverseStart = pointsB[i], reverseEnd = pointsB[(i + 1) % 3], reverseDirection = reverseEnd.clone().sub(reverseStart), reverseLength = reverseDirection.length();
    const reverseHit = new THREE.Ray(reverseStart, reverseDirection.divideScalar(reverseLength)).intersectTriangle(a.a, a.b, a.c, false, closest);
    if (reverseHit && reverseHit.distanceToSquared(reverseStart) <= reverseLength * reverseLength + 1e-12) return 0;
    for (let j = 0; j < 3; j++) best = Math.min(best, segmentDistanceSquared(start, end, pointsB[j], pointsB[(j + 1) % 3]));
  }
  return best;
}

function surfaceDistance(a, b) {
  let best = Infinity;
  const visit = (left, right) => {
    if (boxDistanceSquared(left.box, right.box) >= best) return;
    if (left.triangles && right.triangles) {
      for (const x of left.triangles) for (const y of right.triangles) {
        if (boxDistanceSquared(x.box, y.box) >= best) continue;
        best = Math.min(best, triangleDistanceSquared(x.triangle, y.triangle));
        if (best < 1e-16) return;
      }
    } else {
      const pairs = !left.triangles && (right.triangles || left.count >= right.count)
        ? [[left.left, right], [left.right, right]] : [[left, right.left], [left, right.right]];
      pairs.sort((x, y) => boxDistanceSquared(x[0].box, x[1].box) - boxDistanceSquared(y[0].box, y[1].box));
      for (const pair of pairs) visit(...pair);
    }
  };
  visit(a, b);
  return Math.sqrt(best);
}

test('both classic knees bend forward in hip and foot-progression frames through every cycle and subframe', () => {
  const actor = fixture(), animator = createAnimator(actor.cat);
  for (const [name, duration] of CLIPS) {
    animator.play(name, 0);
    const previous = {}, first = {};
    for (let frame = 0; frame <= duration * 240; frame++) {
      const time = frame / 240; animator.seek(time);
      for (const side of ['L', 'R']) {
        const sample = kneeFrame(actor.rig, side), context = `${name}/${side}/${time}`;
        assert.ok(sample.bend.z > 0, `${context}: knee bends behind its hip-to-ankle line`);
        assert.ok(sample.signedHip > 0 && sample.signedFoot > 0, `${context}: knee flexes opposite its actor/foot progression`);
        if (previous[side]) assert.ok(previous[side].angleTo(sample.normal) < .04, `${context}: knee plane flips between subframes`);
        previous[side] = sample.normal;
        if (frame === 0) first[side] = sample;
        if (frame === duration * 240) for (const key of ['hip', 'knee', 'ankle']) assert.ok(sample[key].distanceTo(first[side][key]) < 1e-6, `${name}/${side}: physical loop seam`);
      }
    }
  }
  animator.dispose();
});

test('Electro Shuffle retains its crossed lateral step with a bounded front/back clearance change', () => {
  const actor = fixture();
  let largest = 0;
  for (let frame = 0; frame <= 720; frame++) {
    const time = frame / 120, phase = Math.PI * 2 * time / 1.5, crossing = Math.sin(phase);
    actor.sample('Electro Shuffle', time, 6);
    for (const side of [-1, 1]) {
      const target = actor.targets.get(side < 0 ? 'foot_l' : 'foot_r').target;
      const shifted = phase + (side > 0 ? Math.PI : 0);
      assert.ok(Math.abs(target.x - (side * .38 - side * .44 * crossing)) < 1e-10, 'the lateral crossover must remain intact');
      assert.ok(Math.abs(target.y - (.133 + .14 * Math.max(0, Math.sin(shifted)) ** 1.6)) < 1e-10, 'the lift and beat must remain intact');
      const original = .11 - side * .25 * crossing;
      largest = Math.max(largest, Math.abs(target.z - original));
      assert.ok(Math.abs(target.z - original) <= .2000001, 'clearance change exceeds .20 model units');
    }
  }
  assert.ok(largest > .1999);
  actor.sample('Electro Shuffle', .375, 6);
  assert.ok(actor.targets.get('foot_l').target.x > 0 && actor.targets.get('foot_r').target.x < 0, 'the deliberate crossing is not a knee-direction error');
});

for (const style of ['original', 'dreamcast', 'ps1', 'ps2']) {
  test(`${style}: classic legs keep floor contact and their actual triangle surfaces remain separate`, () => {
    const actor = fixture(style), animator = createAnimator(actor.cat);
    const legs = ['leftLeg', 'rightLeg'].map(name => actor.cat.userData.parts[name].children[0]);
    let minimumGap = Infinity;
    for (const [name, duration] of CLIPS) {
      animator.play(name, 0);
      for (let frame = 0; frame < 64; frame++) {
        const time = (frame + .37) / 64 * duration; animator.seek(time);
        const sole = [];
        for (const leg of legs) {
          let lowest = Infinity;
          for (let vertex = 0; vertex < leg.geometry.attributes.position.count; vertex++) lowest = Math.min(lowest, leg.getVertexPosition(vertex, V()).y);
          assert.ok(lowest >= -.0001, `${style}/${name}/${time}: leg skin crosses floor`);
          sole.push(lowest);
        }
        assert.ok(Math.min(...sole) < .025, `${style}/${name}/${time}: both feet lose stance contact`);
        const gap = surfaceDistance(surfaceTree(legs[0]), surfaceTree(legs[1]));
        minimumGap = Math.min(minimumGap, gap);
        assert.ok(gap > .0001, `${style}/${name}/${time}: leg triangle surfaces intersect or graze (${gap})`);
      }
    }
    assert.ok(minimumGap > .0001);
    animator.dispose();

    // The altered crossing route must be safe before clip sampling as well;
    // interpolation must not be what hides an authored collision.
    const source = fixture(style);
    const sourceLegs = ['leftLeg', 'rightLeg'].map(name => source.cat.userData.parts[name].children[0]);
    for (let frame = 0; frame < 64; frame++) {
      const time = (frame + .271) / 64 * 6;
      source.sample('Electro Shuffle', time, 6);
      const gap = surfaceDistance(surfaceTree(sourceLegs[0]), surfaceTree(sourceLegs[1]));
      assert.ok(gap > .0001, `${style}/Electro Shuffle source/${time}: crossing leg surfaces intersect (${gap})`);
      const soles = sourceLegs.map(leg => {
        let lowest = Infinity;
        for (let vertex = 0; vertex < leg.geometry.attributes.position.count; vertex++) lowest = Math.min(lowest, leg.getVertexPosition(vertex, V()).y);
        assert.ok(lowest >= -.0001, 'the source crossing route must not pass through the floor');
        return lowest;
      });
      assert.ok(Math.min(...soles) < .025, 'the source crossing route must retain its stance foot');
    }
  });
}

test('classic source knee/ankle paths stay close to baked playback between keys', () => {
  const source = fixture(), actor = fixture(), animator = createAnimator(actor.cat);
  for (const [name, duration] of CLIPS) {
    animator.play(name, 0);
    for (let frame = 0; frame <= duration * 120; frame++) {
      const time = frame / 120; source.sample(name, time, duration); animator.seek(time);
      for (const side of ['L', 'R']) for (const part of ['Shin', 'Foot']) {
        const expected = source.rig.bones[`${part}_${side}`].getWorldPosition(V()), actual = actor.rig.bones[`${part}_${side}`].getWorldPosition(V());
        assert.ok(actual.distanceTo(expected) < .015, `${name}/${part}_${side}/${time}: interpolation changes the leg route`);
      }
    }
  }
  animator.dispose();
});
