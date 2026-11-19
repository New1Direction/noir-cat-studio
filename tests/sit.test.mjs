import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator } from '../src/animation.js';

function torsoMetric(point) {
  if (point.y <= 1.36 || point.y >= 3.20) return Infinity;
  const t = (point.y - 1.36) / 1.84;
  const lower = point.y < 1.49 ? Math.sqrt(Math.max(0, 1 - ((point.y - 1.49) / .13) ** 2)) : 1;
  const upper = point.y > 3.04 ? Math.sqrt(Math.max(0, 1 - ((point.y - 3.04) / .16) ** 2)) : 1;
  const width = (.505 - .11 * t) * lower * upper;
  const depth = (.35 - .065 * t) * lower * upper;
  return (Math.abs(point.x) / width) ** 2.8 + (Math.abs(point.z) / depth) ** 2.8;
}
function headMetric(point) {
  // The existing shoulder/neck attachment is deliberately fused below 3.28.
  if (point.y <= 3.28 || point.y >= 5.42) return Infinity;
  const t = point.y >= 4.17 ? (point.y - 4.17) / 1.25 : (point.y - 4.17) / 1.07;
  const exponent = t < 0 ? 2.85 : 2.05;
  const r = (1 - Math.abs(t) ** exponent) ** (1 / exponent);
  return (Math.abs(point.x) / (1.58 * r)) ** 2.2 + (Math.abs(point.z) / (.94 * r)) ** 2.2;
}

for (const style of ['original', 'dreamcast', 'ps1', 'ps2']) {
  test(`${style}: Sit drops the elbows and rests paws near knees without arm/head/torso clipping`, () => {
    const cat = rigCat(createCat({ style }));
    const rig = cat.userData.rig;
    const animator = createAnimator(cat);
    const index = name => rig.skeleton.bones.indexOf(rig.bones[name]);
    const hipsIndex = index('Hips'), spineIndex = index('Spine'), headIndex = index('Head');
    const point = new THREE.Vector3(), unposed = new THREE.Vector3();
    const blend = new THREE.Matrix4(), inverseBlend = new THREE.Matrix4();
    const previous = new Map();
    animator.play('Sit', 0);
    const duration = animator.getState().duration;
    const dt = duration / 80;
    for (let frame = 0; frame <= 80; frame++) {
      const time = dt * frame;
      animator.seek(time);
      const hips = new THREE.Matrix4().multiplyMatrices(rig.bones.Hips.matrixWorld, rig.skeleton.boneInverses[hipsIndex]);
      const inverseHips = hips.clone().invert();
      const spine = new THREE.Matrix4().multiplyMatrices(rig.bones.Spine.matrixWorld, rig.skeleton.boneInverses[spineIndex]);
      const inverseHead = new THREE.Matrix4().multiplyMatrices(rig.bones.Head.matrixWorld, rig.skeleton.boneInverses[headIndex]).invert();
      for (const [side, part] of [['L', 'leftArm'], ['R', 'rightArm']]) {
        const context = `${style} Sit ${time.toFixed(2)}s/${side}`;
        const shoulder = rig.bones[`UpperArm_${side}`].getWorldPosition(new THREE.Vector3());
        const elbow = rig.bones[`Forearm_${side}`].getWorldPosition(new THREE.Vector3());
        const paw = rig.bones[`Hand_${side}`].getWorldPosition(new THREE.Vector3());
        const knee = rig.bones[`Shin_${side}`].getWorldPosition(new THREE.Vector3());
        for (const [name, value] of [['elbow', elbow], ['paw', paw]]) {
          const key = `${side}/${name}`;
          if (previous.has(key)) assert.ok(value.distanceTo(previous.get(key)) / dt < 4,
            `${context} ${name} snaps during the descent`);
          previous.set(key, value.clone());
        }
        if (time >= .95) {
          assert.ok(shoulder.y - elbow.y > .65, `${context} upper arm juts forward instead of hanging down`);
          assert.ok(Math.abs(elbow.z - shoulder.z) < .25, `${context} upper arm reaches too far forward`);
          assert.ok(Math.abs(paw.x - knee.x) < .15, `${context} paw hovers outside the knee`);
          assert.ok(paw.y - knee.y > .10 && paw.y - knee.y < .24, `${context} paw is too high above the lap or sinks through it`);
          assert.ok(Math.abs(paw.z - knee.z) < .13, `${context} paw hovers over the shin instead of resting near the knee`);
          assert.ok(paw.distanceTo(knee) < .29, `${context} paw is detached from its resting area`);
        }

        const mesh = cat.userData.parts[part].children[0];
        const sections = mesh.geometry.userData.armSections;
        for (let vertex = 0; vertex < mesh.geometry.attributes.position.count; vertex++) {
          mesh.getVertexPosition(vertex, point);
          unposed.copy(point).applyMatrix4(inverseHead);
          assert.ok(headMetric(unposed) >= 1 - .0001, `${context} arm surface enters the head`);
          // The proximal upper-arm attachment merges with the shoulder. The
          // entire free forearm, elbow ball and rounded paw must clear torso.
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
          assert.ok(torsoMetric(unposed) >= 1 - .0001, `${context} forearm/elbow/paw surface enters the torso`);
        }
      }
    }
    animator.dispose();
  });
}
