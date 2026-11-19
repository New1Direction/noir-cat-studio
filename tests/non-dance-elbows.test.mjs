import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator } from '../src/animation.js';

const CLIPS = ['Idle', 'Walk', 'Run', 'Sprint', 'Wave', 'Sit', 'Shoot', 'Smoke', 'Dive'];

function torsoMetric(point) {
  if (point.y <= 1.36 || point.y >= 3.20) return Infinity;
  const t = (point.y - 1.36) / 1.84;
  const lower = point.y < 1.49 ? Math.sqrt(Math.max(0, 1 - ((point.y - 1.49) / .13) ** 2)) : 1;
  const upper = point.y > 3.04 ? Math.sqrt(Math.max(0, 1 - ((point.y - 3.04) / .16) ** 2)) : 1;
  return (Math.abs(point.x) / ((.505 - .11 * t) * lower * upper)) ** 2.8
    + (Math.abs(point.z) / ((.35 - .065 * t) * lower * upper)) ** 2.8;
}
function headMetric(point, lowerBoundary = 3.28) {
  if (point.y <= lowerBoundary || point.y >= 5.42) return Infinity;
  const t = point.y >= 4.17 ? (point.y - 4.17) / 1.25 : (point.y - 4.17) / 1.07;
  const exponent = t < 0 ? 2.85 : 2.05;
  const radius = (1 - Math.abs(t) ** exponent) ** (1 / exponent);
  return (Math.abs(point.x) / (1.58 * radius)) ** 2.2 + (Math.abs(point.z) / (.94 * radius)) ** 2.2;
}

for (const style of ['original', 'dreamcast', 'ps1', 'ps2']) {
  test(`${style}: both elbows follow each non-dance gesture without reversed low forearms, flips or skin collisions`, () => {
    const cat = rigCat(createCat({ style }));
    const animator = createAnimator(cat);
    const rig = cat.userData.rig;
    const boneIndex = name => rig.skeleton.bones.indexOf(rig.bones[name]);
    const hipsIndex = boneIndex('Hips'), spineIndex = boneIndex('Spine'), headIndex = boneIndex('Head');
    const point = new THREE.Vector3(), unposed = new THREE.Vector3();
    const blend = new THREE.Matrix4(), inverseBlend = new THREE.Matrix4();
    for (const name of CLIPS) {
      animator.play(name, 0);
      const duration = animator.getState().duration;
      const previous = { L: null, R: null };
      for (let frame = 0; frame <= 64; frame++) {
        animator.seek(duration * frame / 64);
        const inverseSpine = rig.bones.Spine.matrixWorld.clone().invert();
        const hips = new THREE.Matrix4().multiplyMatrices(rig.bones.Hips.matrixWorld, rig.skeleton.boneInverses[hipsIndex]);
        const inverseHips = hips.clone().invert();
        const spine = new THREE.Matrix4().multiplyMatrices(rig.bones.Spine.matrixWorld, rig.skeleton.boneInverses[spineIndex]);
        const inverseHead = new THREE.Matrix4().multiplyMatrices(rig.bones.Head.matrixWorld, rig.skeleton.boneInverses[headIndex]).invert();
        for (const [side, part] of [['L', 'leftArm'], ['R', 'rightArm']]) {
          const context = `${style}/${name}/${side} at ${(duration * frame / 64).toFixed(3)}s`;
          // A whole-body sideways dive must not be mistaken for an elbow flip.
          const shoulder = rig.bones[`UpperArm_${side}`].getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseSpine);
          const elbow = rig.bones[`Forearm_${side}`].getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseSpine);
          const paw = rig.bones[`Hand_${side}`].getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseSpine);
          const upper = elbow.clone().sub(shoulder);
          const forearm = paw.clone().sub(elbow);
          const bend = upper.angleTo(forearm);
          const plane = upper.clone().cross(forearm).normalize();
          // The raised side-wave has a tiny backwards depth component while
          // travelling up/out. It is intentionally not a relaxed-arm hinge.
          if (name === 'Wave' && side === 'R') {
            assert.ok(paw.y > elbow.y + .25 && paw.x > elbow.x + .35, `${context} loses its raised side-wave gesture`);
            assert.ok(forearm.z > -.05, `${context} raised forearm folds behind the elbow`);
          } else {
            assert.ok(forearm.z >= -.005, `${context} low/forward-reaching paw folds backwards behind its elbow`);
          }
          // A near-straight rest arm has no well-defined bend-plane normal.
          // Only compare normals after a meaningful bend exists on both sides.
          const last = previous[side];
          if (last && bend > .25 && last.bend > .25) {
            assert.ok(plane.angleTo(last.plane) < 20 * Math.PI / 180, `${context} abruptly reverses its elbow plane`);
          }
          previous[side] = { bend, plane };

          const mesh = cat.userData.parts[part].children[0];
          const sections = mesh.geometry.userData.armSections;
          for (let vertex = 0; vertex < mesh.geometry.attributes.position.count; vertex++) {
            mesh.getVertexPosition(vertex, point);
            unposed.copy(point).applyMatrix4(inverseHead);
            // Only the upper-arm attachment may use the neck-join exception.
            // The elbow ball, forearm and paw must clear the actual head from
            // its bottom at 3.10, including the lower cheek band below 3.28.
            const headBoundary = vertex >= sections.forearm.start ? 3.10 : 3.28;
            assert.ok(headMetric(unposed, headBoundary) >= .9999, `${context} arm surface enters the head`);
            // The proximal shoulder joins the torso by design. All free
            // forearm, elbow-ball and paw vertices must clear its actual pose.
            if (vertex < sections.forearm.start) continue;
            unposed.copy(point).applyMatrix4(inverseHips);
            for (let iteration = 0; iteration < 5; iteration++) {
              let t = THREE.MathUtils.clamp((unposed.y - 1.72) / 1.10, 0, 1);
              t = t * t * (3 - 2 * t);
              for (let component = 0; component < 16; component++) {
                blend.elements[component] = hips.elements[component] * (1 - t) + spine.elements[component] * t;
              }
              unposed.copy(point).applyMatrix4(inverseBlend.copy(blend).invert());
            }
            const clearance = torsoMetric(unposed);
            assert.ok(clearance >= .9999, `${context} free arm surface enters the torso (metric ${clearance})`);
          }
        }
      }
    }
    animator.dispose();
  });
}
