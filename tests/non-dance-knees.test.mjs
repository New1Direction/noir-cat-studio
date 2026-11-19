import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator } from '../src/animation.js';

const CLIPS = ['Idle', 'Walk', 'Run', 'Sprint', 'Wave', 'Sit', 'Shoot', 'Smoke', 'Dive'];
const FRONT = new THREE.Vector3(0, 0, 1);

for (const style of ['original', 'dreamcast', 'ps1', 'ps2']) {
  test(`${style}: both knees bend forward with stable hinges, fixed lengths and clear soles in all nine non-dance clips`, () => {
    const cat = rigCat(createCat({ style }));
    const animator = createAnimator(cat);
    const rig = cat.userData.rig;
    const point = new THREE.Vector3();
    for (const name of CLIPS) {
      animator.play(name, 0);
      const duration = animator.getState().duration;
      const previous = { L: null, R: null };
      for (let frame = 0; frame <= 96; frame++) {
        animator.seek(duration * frame / 96);
        // In particular, a whole-body sideways Dive must not turn a correct
        // anatomical knee into an apparently reversed world-space hinge.
        const inverseHips = rig.bones.Hips.matrixWorld.clone().invert();
        for (const [side, part, sign] of [['L', 'leftLeg', -1], ['R', 'rightLeg', 1]]) {
          const context = `${style}/${name}/${side} ${(duration * frame / 96).toFixed(3)}s`;
          const thighBone = rig.bones[`Thigh_${side}`];
          const kneeBone = rig.bones[`Shin_${side}`];
          const footBone = rig.bones[`Foot_${side}`];
          for (const bone of [thighBone, kneeBone, footBone]) {
            for (const value of [...bone.position, ...bone.quaternion, ...bone.scale]) {
              assert.ok(Number.isFinite(value), `${context} contains a non-finite joint transform`);
            }
            assert.ok(Math.abs(bone.quaternion.length() - 1) < .00001, `${context} joint rotation is not unit length`);
            assert.ok(bone.scale.distanceTo(new THREE.Vector3(1, 1, 1)) < .000001, `${context} stretches a leg bone`);
          }
          const hip = thighBone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseHips);
          const knee = kneeBone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseHips);
          const ankle = footBone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseHips);
          const upper = knee.clone().sub(hip);
          const lower = ankle.clone().sub(knee);
          assert.ok(Math.abs(upper.length() - rig.rest[`Shin_${side}`].position.length()) < .00001, `${context} changes thigh length`);
          assert.ok(Math.abs(lower.length() - rig.rest[`Foot_${side}`].position.length()) < .00001, `${context} changes shin length`);

          const axis = ankle.clone().sub(hip).normalize();
          const kneeOffset = knee.clone().sub(hip);
          kneeOffset.addScaledVector(axis, -kneeOffset.dot(axis));
          const projectedFront = FRONT.clone().addScaledVector(axis, -FRONT.dot(axis)).normalize();
          const forward = kneeOffset.dot(projectedFront);
          const flex = upper.angleTo(lower);
          assert.ok(forward >= -.0001, `${context} bends backwards in the character's hip frame`);
          if (flex > .17) assert.ok(forward > .015, `${context} meaningful bend leaves its forward hinge plane`);
          assert.ok(knee.x * sign > .05, `${context} knee folds across the body's center line`);

          const plane = upper.clone().cross(lower).normalize();
          const prior = previous[side];
          // Almost straight legs do not define a reliable plane normal.
          if (prior && flex > .17 && prior.flex > .17) {
            assert.ok(plane.angleTo(prior.plane) < 12 * Math.PI / 180, `${context} abruptly flips the knee bend plane`);
          }
          previous[side] = { flex, plane };

          // Check the actual animated leg/sole skin, rather than assuming that
          // an upright ankle bone guarantees a grounded rounded foot.
          const mesh = cat.userData.parts[part].children[0];
          for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
            mesh.getVertexPosition(i, point);
            if (point.y < -.0001) assert.fail(`${context} leg or sole penetrates the floor at vertex ${i}`);
          }
        }
      }
    }
    animator.dispose();
  });
}
