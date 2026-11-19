import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator } from '../src/animation.js';
import { exportAnimatedGLB } from '../src/export.js';

const STYLES = ['original', 'dreamcast', 'ps1', 'ps2'];
const RADIUS = .155;
const point = new THREE.Vector3();

function vertices(section) { return Array.from({ length: section.count }, (_, i) => section.start + i); }
function sectionTriangles(geometry, section) {
  const result = [];
  const count = geometry.index?.count ?? geometry.attributes.position.count;
  const get = geometry.index ? i => geometry.index.getX(i) : i => i;
  for (let i = 0; i < count; i += 3) {
    const tri = [get(i), get(i + 1), get(i + 2)];
    if (tri.every(index => index >= section.start && index < section.start + section.count)) result.push(tri);
  }
  return result;
}
function jointRing(mesh, section, center, axis) {
  const first = new THREE.Vector3(0, 0, 1).cross(axis).normalize();
  const second = axis.clone().cross(first);
  const result = [], seen = new Set();
  for (const i of vertices(section)) {
    point.fromBufferAttribute(mesh.geometry.attributes.position, i).sub(center);
    if (Math.abs(point.dot(axis)) > .000001) continue;
    const key = point.toArray().map(value => value.toFixed(5)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ i, angle: Math.atan2(point.dot(second), point.dot(first)) });
  }
  return result.sort((a, b) => a.angle - b.angle).map(entry => entry.i);
}
function ringArea(mesh, ring, center) {
  const sum = new THREE.Vector3();
  for (let i = 0; i < ring.length; i++) {
    const a = mesh.getVertexPosition(ring[i], new THREE.Vector3()).sub(center);
    const b = mesh.getVertexPosition(ring[(i + 1) % ring.length], new THREE.Vector3()).sub(center);
    sum.add(a.cross(b));
  }
  return sum.length() / 2;
}
function ballVolume(mesh, triangles, center) {
  let volume = 0;
  for (const tri of triangles) {
    const a = mesh.getVertexPosition(tri[0], new THREE.Vector3()).sub(center);
    const b = mesh.getVertexPosition(tri[1], new THREE.Vector3()).sub(center);
    const c = mesh.getVertexPosition(tri[2], new THREE.Vector3()).sub(center);
    volume += a.dot(b.cross(c)) / 6;
  }
  return Math.abs(volume);
}
function armFixture(cat, side) {
  const rig = cat.userData.rig;
  const mesh = cat.userData.parts[side === 'L' ? 'leftArm' : 'rightArm'].children[0];
  const sections = mesh.geometry.userData.armSections;
  const shoulder = rig.rest[`UpperArm_${side}`].worldPosition;
  const joint = rig.rest[`Forearm_${side}`].worldPosition;
  const hand = rig.rest[`Hand_${side}`].worldPosition;
  const axis = hand.clone().sub(shoulder).normalize();
  const upperRing = jointRing(mesh, sections.upper, joint, axis);
  const forearmRing = jointRing(mesh, sections.forearm, joint, axis);
  const triangles = sectionTriangles(mesh.geometry, sections.elbow);
  return { mesh, sections, joint, axis, upperRing, forearmRing, triangles,
    upperArea: ringArea(mesh, upperRing, joint), forearmArea: ringArea(mesh, forearmRing, joint), volume: ballVolume(mesh, triangles, joint) };
}
function assertRoundArm(cat, side, fixture, context) {
  const { mesh, sections } = fixture;
  const joint = cat.userData.rig.bones[`Forearm_${side}`].getWorldPosition(new THREE.Vector3());
  for (const i of vertices(sections.elbow)) {
    mesh.getVertexPosition(i, point);
    assert.ok(Math.abs(point.distanceTo(joint) - RADIUS) < .000002, `${context}: elbow ball loses its radius`);
  }
  assert.ok(Math.abs(ringArea(mesh, fixture.upperRing, joint) / fixture.upperArea - 1) < .00001, `${context}: upper shaft pinches at the elbow`);
  assert.ok(Math.abs(ringArea(mesh, fixture.forearmRing, joint) / fixture.forearmArea - 1) < .00001, `${context}: forearm shaft pinches at the elbow`);
  assert.ok(Math.abs(ballVolume(mesh, fixture.triangles, joint) / fixture.volume - 1) < .00001, `${context}: elbow joint loses volume`);
}

for (const style of STYLES) {
  test(`${style}: arm construction retains the reference capsule and uses rigid sections`, () => {
    const cat = rigCat(createCat({ style }));
    const rig = cat.userData.rig;
    assert.equal(rig.skeleton.bones.length, 26); assert.equal(rig.meshes.length, 19);
    for (const side of ['L', 'R']) {
      const { mesh, sections, axis } = armFixture(cat, side);
      assert.deepEqual(Object.keys(sections), ['upper', 'forearm', 'elbow']);
      const shoulder = rig.rest[`UpperArm_${side}`].worldPosition;
      const hand = rig.rest[`Hand_${side}`].worldPosition;
      const capStart = shoulder.clone().addScaledVector(axis, RADIUS);
      const capEnd = hand.clone().addScaledVector(axis, -RADIUS);
      const segment = capEnd.clone().sub(capStart);
      for (const section of Object.values(sections)) {
        const bone = rig.skeleton.bones.findIndex(bone => bone.name === section.bone);
        for (const i of vertices(section)) {
          assert.equal(mesh.geometry.attributes.skinIndex.getX(i), bone);
          assert.equal(mesh.geometry.attributes.skinWeight.getX(i), 1);
          for (let j = 1; j < 4; j++) assert.equal(mesh.geometry.attributes.skinWeight.getComponent(i, j), 0);
          point.fromBufferAttribute(mesh.geometry.attributes.position, i);
          const t = THREE.MathUtils.clamp(point.clone().sub(capStart).dot(segment) / segment.lengthSq(), 0, 1);
          const nearest = capStart.clone().addScaledVector(segment, t);
          assert.ok(point.distanceTo(nearest) <= RADIUS + .000002, 'new joint protrudes beyond the reference rest silhouette');
        }
      }
      // Open joint ends avoid a disk or a second curved cap fighting the ball.
      for (const name of ['upper', 'forearm']) for (const triangle of sectionTriangles(mesh.geometry, sections[name])) {
        assert.ok(!triangle.every(i => Math.abs(new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i).sub(rig.rest[`Forearm_${side}`].worldPosition).dot(axis)) < .000001), 'shaft has a cap across the elbow opening');
      }
      if (style === 'ps1') assert.equal(mesh.geometry.index, null);
      if (style === 'ps2') assert.ok(mesh.geometry.hasAttribute('color'));
    }
  });

  test(`${style}: actual elbow surfaces retain radius, area and volume through deep bends and twists`, () => {
    const cat = rigCat(createCat({ style })); const rig = cat.userData.rig;
    const fixtures = Object.fromEntries(['L', 'R'].map(side => [side, armFixture(cat, side)]));
    for (const bend of [0, 60, 90, 120, 150, 170, 179, 180]) {
      for (const twist of [0, 90, 180, 359]) {
        rig.resetPose();
        for (const side of ['L', 'R']) {
          const axis = fixtures[side].axis;
          const hinge = new THREE.Vector3(0, 0, 1).cross(axis).normalize();
          rig.bones[`UpperArm_${side}`].quaternion.setFromEuler(new THREE.Euler(.3, -.4, .25));
          rig.bones[`Forearm_${side}`].quaternion.setFromAxisAngle(hinge, bend * Math.PI / 180)
            .multiply(new THREE.Quaternion().setFromAxisAngle(axis, twist * Math.PI / 180));
        }
        cat.updateMatrixWorld(true);
        for (const side of ['L', 'R']) assertRoundArm(cat, side, fixtures[side], `${style}/${side} bend${bend} twist${twist}`);
      }
    }
  });

  test(`${style}: wrist controls cannot crease or detach the rounded paw cap`, () => {
    const cat = rigCat(createCat({ style })); const rig = cat.userData.rig;
    rig.bones.Forearm_L.rotation.set(.7, -.4, 1.0); cat.updateMatrixWorld(true);
    const mesh = cat.userData.parts.leftArm.children[0];
    const section = mesh.geometry.userData.armSections.forearm;
    const before = vertices(section).map(i => mesh.getVertexPosition(i, new THREE.Vector3()));
    rig.bones.Hand_L.rotation.set(1.2, -2, .8); cat.updateMatrixWorld(true);
    vertices(section).forEach((i, index) => assert.ok(mesh.getVertexPosition(i, point).distanceTo(before[index]) < .000001,
      'the paw cap is being blended into the prop/IK endpoint bone'));
  });
}

test('all nineteen built-in clips keep full elbow surfaces instead of merely finite vertices', () => {
  const cat = rigCat(createCat());
  const fixture = armFixture(cat, 'L');
  const animator = createAnimator(cat);
  assert.equal(animator.clips.length, 19);
  for (const clip of animator.clips) {
    animator.play(clip.name, 0);
    for (let i = 0; i < 24; i++) {
      animator.seek(clip.duration * i / 24);
      assertRoundArm(cat, 'L', fixture, clip.name);
    }
  }
  animator.dispose();
});

class FileReaderShim {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
}

test('standard GLB roundtrip preserves the round elbow under a 150-degree bone bend', async () => {
  const previous = globalThis.FileReader; globalThis.FileReader = FileReaderShim;
  try {
    const cat = rigCat(createCat({ style: 'ps2' })); createAnimator(cat).dispose();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 150 * Math.PI / 180);
    const clip = new THREE.AnimationClip('Arm surface stress', 2, [new THREE.QuaternionKeyframeTrack('Forearm_L.quaternion', [0, 1, 2], [0, 0, 0, 1, ...q, 0, 0, 0, 1])]);
    const exported = await exportAnimatedGLB(cat, [clip]);
    assert.equal(exported.report.issues.numErrors, 0); assert.equal(exported.report.issues.numWarnings, 0);
    const data = exported.binary;
    const loaded = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
    const forearm = loaded.scene.getObjectByName('Forearm_L');
    let mesh = null, indices = [];
    loaded.scene.traverse(object => {
      if (!object.isSkinnedMesh) return;
      const boneIndex = object.skeleton.bones.findIndex(bone => bone.name === 'Forearm_L');
      const center = new THREE.Vector3(-.82, 2.46, .0125);
      const attributes = object.geometry.attributes;
      const candidates = [];
      for (let i = 0; i < attributes.position.count; i++) {
        if (attributes.skinIndex.getX(i) !== boneIndex || attributes.skinWeight.getX(i) !== 1) continue;
        point.fromBufferAttribute(attributes.position, i);
        if (Math.abs(point.distanceTo(center) - RADIUS) < .00001) candidates.push(i);
      }
      if (candidates.length > indices.length) { mesh = object; indices = candidates; }
    });
    assert.ok(mesh && indices.length > 100, 'the exported joint surface is missing');
    const mixer = new THREE.AnimationMixer(loaded.scene);
    mixer.clipAction(loaded.animations[0]).play(); mixer.setTime(1); loaded.scene.updateMatrixWorld(true);
    const center = forearm.getWorldPosition(new THREE.Vector3());
    for (const i of indices) assert.ok(Math.abs(mesh.getVertexPosition(i, point).distanceTo(center) - RADIUS) < .00001);
    mixer.stopAllAction(); mixer.uncacheRoot(loaded.scene);
  } finally { if (previous === undefined) delete globalThis.FileReader; else globalThis.FileReader = previous; }
});
