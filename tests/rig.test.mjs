import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimationClips, createAnimator } from '../src/animation.js';
import { DANCES } from '../src/dances.js';
import { ACTIONS, ONE_SHOT_CLIPS } from '../src/actions.js';
import { exportAnimatedGLB } from '../src/export.js';

const STYLES = ['original', 'dreamcast', 'ps1', 'ps2'];
const CLIP_NAMES = ['Idle', 'Walk', 'Run', 'Sprint', 'Wave', 'Sit', ...DANCES.map(dance => dance.name), ...ACTIONS.map(action => action.name)];
const BONE_NAMES = [
  'Root', 'Hips', 'Spine', 'Head', 'Ear_L', 'Ear_R', 'Eye_L', 'Eye_R', 'Mouth',
  'UpperArm_L', 'Forearm_L', 'Hand_L', 'UpperArm_R', 'Forearm_R', 'Hand_R',
  'Thigh_L', 'Shin_L', 'Foot_L', 'Thigh_R', 'Shin_R', 'Foot_R',
  'Tail_0', 'Tail_1', 'Tail_2', 'Tail_3', 'Tail_4',
];
const IDENTITY_QUATERNION = new THREE.Quaternion();
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

function modelSurfaces(cat) {
  cat.updateWorldMatrix(true, true);
  const inverse = cat.matrixWorld.clone().invert();
  const surfaces = new Map();
  for (const [partName, part] of Object.entries(cat.userData.parts)) {
    let ordinal = 0;
    part.traverse(object => {
      if (!object.isMesh) return;
      const key = `${partName}/${ordinal++}`;
      const matrix = new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld);
      const source = object.geometry.attributes.position;
      const points = new Float64Array(source.count * 3);
      const point = new THREE.Vector3();
      for (let i = 0; i < source.count; i++) {
        point.fromBufferAttribute(source, i).applyMatrix4(matrix).toArray(points, i * 3);
      }
      surfaces.set(key, { partName, object, points });
    });
  }
  return surfaces;
}

function assertFiniteAttributes(mesh) {
  for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
    for (const value of attribute.array) {
      assert.ok(Number.isFinite(value), `${mesh.name}.${name} contains a non-finite value`);
    }
  }
}

function assertSkinWeights(mesh, jointCount = 26) {
  assert.ok(mesh.isSkinnedMesh, `${mesh.name} must be a genuine SkinnedMesh`);
  const indices = mesh.geometry.attributes.skinIndex;
  const weights = mesh.geometry.attributes.skinWeight;
  assert.equal(indices.itemSize, 4);
  assert.equal(weights.itemSize, 4);
  assert.equal(indices.count, mesh.geometry.attributes.position.count);
  assert.equal(weights.count, indices.count);
  for (let i = 0; i < indices.count; i++) {
    let total = 0;
    let influences = 0;
    for (let j = 0; j < 4; j++) {
      const index = indices.getComponent(i, j);
      const weight = weights.getComponent(i, j);
      assert.ok(Number.isInteger(index) && index >= 0 && index < jointCount, `${mesh.name} has an invalid joint index`);
      assert.ok(Number.isFinite(weight) && weight >= 0 && weight <= 1, `${mesh.name} has an invalid skin weight`);
      total += weight;
      if (weight > 0) influences++;
      else assert.equal(index, 0, `${mesh.name} unused influences must name joint zero for portable glTF`);
    }
    assert.ok(Math.abs(total - 1) < 1e-6, `${mesh.name} weights must sum to one (got ${total})`);
    assert.ok(influences > 0 && influences <= 4);
  }
}

function cpuVertex(mesh, index, target = new THREE.Vector3()) {
  target.fromBufferAttribute(mesh.geometry.attributes.position, index);
  mesh.applyBoneTransform(index, target);
  return target;
}

for (const style of STYLES) {
  test(`${style}: all surfaces share a complete weighted rig without changing the bind silhouette`, () => {
    const cat = createCat({ style });
    const before = modelSurfaces(cat);
    assert.equal(rigCat(cat), cat);
    const rig = cat.userData.rig;
    assert.deepEqual(Object.keys(rig.bones), BONE_NAMES);
    assert.equal(rig.skeleton.bones.length, 26);
    assert.equal(rig.meshes.length, 19);
    assert.equal(rig.bones.Root.parent, cat);
    assert.equal(cat.userData.style, style);
    assert.equal(cat.getObjectByName('Head'), rig.bones.Head, 'named tracks must find the bone before its mesh');

    let countedTriangles = 0;
    let coloredMeshes = 0;
    const point = new THREE.Vector3();
    const expected = new THREE.Vector3();
    for (const mesh of rig.meshes) {
      assert.equal(mesh.skeleton, rig.skeleton);
      assert.equal(mesh.frustumCulled, false);
      assert.equal(mesh.position.length(), 0);
      assert.ok(mesh.quaternion.equals(IDENTITY_QUATERNION));
      assert.ok(mesh.scale.equals(UNIT_SCALE));
      assertFiniteAttributes(mesh);
      assertSkinWeights(mesh);
      const positions = mesh.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        expected.fromBufferAttribute(positions, i);
        cpuVertex(mesh, i, point);
        assert.ok(point.distanceTo(expected) < 1e-6, `${mesh.name} moved while binding`);
      }
      countedTriangles += (mesh.geometry.index?.count ?? positions.count) / 3;
      if (mesh.geometry.hasAttribute('color')) coloredMeshes++;
      if (style === 'ps1') assert.equal(mesh.geometry.index, null, 'PS1 flat normals must survive export');
    }
    assert.equal(cat.userData.triangles, countedTriangles);
    if (style === 'ps2') assert.equal(coloredMeshes, 10, 'PS2 keeps baked fur colors after arm retessellation');

    for (const [key, surface] of modelSurfaces(cat)) {
      if (surface.partName === 'leftArm' || surface.partName === 'rightArm') continue;
      const original = before.get(key);
      assert.ok(original, `missing original part ${key}`);
      assert.equal(surface.points.length, original.points.length);
      for (let i = 0; i < surface.points.length; i++) {
        assert.ok(Math.abs(surface.points[i] - original.points[i]) < 1e-6, `${key} changed its bind surface`);
      }
    }
    const bounds = new THREE.Box3().setFromObject(cat);
    assert.ok(Math.abs(bounds.min.y) < 1e-6);
    assert.ok(Math.abs(bounds.max.y - 6.08) < 1e-5);
    assert.equal(rigCat(cat).userData.rig, rig, 'rigging twice is safe');
  });
}

test('head and facial controls deform their own skin while legs remain independent', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const { rig, parts } = cat.userData;
  const eye = parts.face.children.find(mesh => mesh.name === 'Left smiling eye');
  const leg = parts.leftLeg.children[0];
  const eyeBefore = cpuVertex(eye, 0);
  const legBefore = cpuVertex(leg, Math.floor(leg.geometry.attributes.position.count / 2));
  rig.bones.Head.rotation.set(0.3, 0.2, 0);
  cat.updateMatrixWorld(true);
  rig.skeleton.update();
  assert.ok(cpuVertex(eye, 0).distanceTo(eyeBefore) > 0.1, 'the face follows the Head bone');
  assert.ok(cpuVertex(leg, Math.floor(leg.geometry.attributes.position.count / 2)).distanceTo(legBefore) < 1e-6);

  rig.resetPose();
  const heightAt = mesh => {
    let low = Infinity, high = -Infinity;
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      const y = cpuVertex(mesh, i).y;
      low = Math.min(low, y); high = Math.max(high, y);
    }
    return high - low;
  };
  const openHeight = heightAt(eye);
  rig.bones.Eye_L.scale.y = 0.1;
  cat.updateMatrixWorld(true);
  rig.skeleton.update();
  assert.ok(heightAt(eye) < openHeight * 0.15, 'eye scaling produces a real skinned blink');
  rig.resetPose();
  assert.ok(Math.abs(heightAt(eye) - openHeight) < 1e-6);
});

test('bone-name animation tracks target the rig and resetPose restores every local transform', () => {
  const cat = rigCat(createCat({ style: 'dreamcast' }));
  const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.4, 0));
  const track = new THREE.QuaternionKeyframeTrack('Head.quaternion', [0, 1], [0, 0, 0, 1, ...target.toArray()]);
  const mixer = new THREE.AnimationMixer(cat);
  mixer.clipAction(new THREE.AnimationClip('Head lookup check', 1, [track])).play();
  mixer.update(0.5);
  assert.ok(cat.userData.rig.bones.Head.quaternion.angleTo(IDENTITY_QUATERNION) > 0.1);
  assert.ok(cat.userData.parts.head.quaternion.equals(IDENTITY_QUATERNION));
  mixer.stopAllAction();
  cat.userData.rig.bones.Hips.position.x += 1;
  cat.userData.rig.bones.Ear_R.scale.set(2, 3, 4);
  cat.userData.rig.resetPose();
  for (const [name, bone] of Object.entries(cat.userData.rig.bones)) {
    const rest = cat.userData.rig.rest[name];
    assert.ok(bone.position.equals(rest.position));
    assert.ok(bone.quaternion.equals(rest.quaternion));
    assert.ok(bone.scale.equals(rest.scale));
  }
});

function skinSamples(cat) {
  const points = [];
  for (const mesh of cat.userData.rig.meshes) {
    const count = mesh.geometry.attributes.position.count;
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      points.push(cpuVertex(mesh, Math.min(count - 1, Math.floor(count * fraction))));
    }
  }
  return points;
}

function soleHeight(mesh) {
  let minimum = Infinity;
  const point = new THREE.Vector3();
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    minimum = Math.min(minimum, cpuVertex(mesh, i, point).y);
  }
  return minimum;
}

test('all nineteen clips have finite unit rotations and looping clips close on the actual skin', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const clips = createAnimationClips(cat.userData.rig);
  assert.deepEqual(clips.map(clip => clip.name), CLIP_NAMES);
  for (const clip of clips) {
    assert.ok(clip.duration > 0);
    assert.equal(clip.tracks.length, 26 * 3 + 4);
    for (const track of clip.tracks) {
      for (const value of track.values) assert.ok(Number.isFinite(value), `${clip.name}/${track.name} contains a non-finite key`);
      if (track.name.endsWith('.quaternion')) {
        for (let offset = 0; offset < track.values.length; offset += 4) {
          const quaternion = new THREE.Quaternion().fromArray(track.values, offset);
          assert.ok(Math.abs(quaternion.length() - 1) < 1e-6, `${clip.name}/${track.name} contains a non-unit rotation`);
        }
      }
      if (!ONE_SHOT_CLIPS.has(clip.name)) {
        const size = track.getValueSize();
        for (let component = 0; component < size; component++) {
          assert.ok(Math.abs(track.values[component] - track.values[track.values.length - size + component]) < 1e-7,
            `${clip.name}/${track.name} does not close its loop`);
        }
      }
    }
  }

  const animator = createAnimator(cat);
  for (const clip of clips.filter(clip => !ONE_SHOT_CLIPS.has(clip.name))) {
    animator.play(clip.name, 0).seek(0);
    const beginning = skinSamples(cat);
    animator.seek(clip.duration - 0.00001);
    const ending = skinSamples(cat);
    beginning.forEach((point, index) => assert.ok(point.distanceTo(ending[index]) < 0.003,
      `${clip.name} has a visible skinned loop seam`));
  }
  animator.dispose();
});

for (const style of STYLES) {
  test(`${style}: animated soles stay above ground and planted feet remain in contact`, () => {
    const cat = rigCat(createCat({ style }));
    const animator = createAnimator(cat);
    const left = cat.userData.parts.leftLeg.children[0];
    const right = cat.userData.parts.rightLeg.children[0];
    const peakLift = { Walk: [0, 0], Run: [0, 0], Sprint: [0, 0] };
    for (const clip of animator.clips.filter(clip => ['Idle', 'Walk', 'Run', 'Sprint', 'Wave', 'Sit'].includes(clip.name))) {
      animator.play(clip.name, 0);
      for (const fraction of [0, 0.11, 0.25, 0.43, 0.5, 0.69, 0.87, 0.999]) {
        animator.seek(clip.duration * fraction);
        for (const bone of cat.userData.rig.skeleton.bones) {
          for (const value of [...bone.position, ...bone.quaternion, ...bone.scale]) assert.ok(Number.isFinite(value));
          assert.ok(Math.abs(bone.quaternion.length() - 1) < 1e-5);
        }
        const heights = [soleHeight(left), soleHeight(right)];
        heights.forEach((height, side) => {
          assert.ok(height >= -0.01, `${clip.name} ${style} foot ${side} penetrates the floor: ${height}`);
          assert.ok(height <= (clip.name === 'Sprint' ? .48 : .36), `${clip.name} ${style} foot ${side} exceeds its expected swing height`);
          if (clip.name === 'Walk' || clip.name === 'Run' || clip.name === 'Sprint') {
            peakLift[clip.name][side] = Math.max(peakLift[clip.name][side], height);
            const phase = (fraction + side * 0.5) % 1;
            const stanceEnd = clip.name === 'Walk' ? .62 : clip.name === 'Run' ? .44 : .34;
            if (phase < stanceEnd) assert.ok(Math.abs(height) < (clip.name === 'Sprint' ? .035 : .025),
              `${clip.name} ${style} stance foot ${side} loses contact: ${height}`);
          } else {
            assert.ok(Math.abs(height) < 0.015, `${clip.name} ${style} planted foot ${side} floats: ${height}`);
          }
        });
      }
    }
    assert.ok(peakLift.Walk.every(height => height > 0.12), 'both walking feet must leave the ground');
    assert.ok(peakLift.Run.every(height => height > 0.26), 'both running feet must have a visible swing');
    assert.ok(peakLift.Sprint.every(height => height > .36), 'both sprinting feet must recover above a normal running stride');
    animator.dispose();
  });
}

test('paused expression controls and IK remain stable without accumulating offsets', () => {
  const cat = createCat({ style: 'dreamcast' });
  cat.position.set(2, 0.5, -1);
  cat.rotation.y = 0.65;
  cat.scale.setScalar(1.15);
  rigCat(cat);
  const animator = createAnimator(cat);
  const requestedHand = new THREE.Vector3(-1.5, 2.8, 0.3);
  animator.seek(0.6).setPaused(true)
    .setPose({ headYaw: 0.4, tailSway: 0.5, blink: 0.5, smile: 0.3, armRaise: 0.7 })
    .setIKTarget('hand_l', requestedHand);
  const before = Object.fromEntries(Object.entries(cat.userData.rig.bones).map(([name, bone]) => [name, {
    position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone(),
  }]));
  const pausedTime = animator.getState().time;
  for (let i = 0; i < 80; i++) animator.update(1 / 60);
  assert.equal(animator.getState().time, pausedTime);
  for (const [name, bone] of Object.entries(cat.userData.rig.bones)) {
    assert.ok(bone.position.distanceTo(before[name].position) < 1e-10, `${name} position drifts while paused`);
    assert.ok(1 - Math.abs(bone.quaternion.dot(before[name].quaternion)) < 1e-10, `${name} rotation drifts while paused`);
    assert.ok(bone.scale.distanceTo(before[name].scale) < 1e-10, `${name} scale drifts while paused`);
  }
  const actualHand = cat.userData.rig.bones.Hand_L.getWorldPosition(new THREE.Vector3());
  cat.worldToLocal(actualHand);
  assert.ok(actualHand.distanceTo(requestedHand) < 1e-5, 'IK target uses cat-local coordinates even when the model is placed/rotated/scaled');
  animator.dispose();
});

// GLTFExporter reads its binary Blob through FileReader. Node provides Blob
// but no FileReader, so this minimal asynchronous shim covers that boundary.
class NodeFileReader {
  readAsArrayBuffer(blob) {
    this.read(blob, array => array);
  }
  readAsDataURL(blob) {
    this.read(blob, array => `data:${blob.type};base64,${Buffer.from(array).toString('base64')}`);
  }
  read(blob, convert) {
    blob.arrayBuffer().then(array => {
      this.result = convert(array);
      this.onload?.({ target: this });
      this.onloadend?.({ target: this });
    }, error => {
      this.error = error;
      this.onerror?.({ target: this });
    });
  }
}

function glbJSON(binary) {
  const header = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  assert.equal(header.getUint32(0, true), 0x46546c67, 'export must be a binary glTF file');
  assert.equal(header.getUint32(16, true), 0x4e4f534a);
  return JSON.parse(new TextDecoder().decode(binary.subarray(20, 20 + header.getUint32(12, true))));
}

for (const style of STYLES) {
test(`${style}: optimized animated GLB validates and reloads with all nineteen clips, skins and weights`, async () => {
  const previousFileReader = globalThis.FileReader;
  globalThis.FileReader = NodeFileReader;
  const cat = rigCat(createCat({ style }));
  const animator = createAnimator(cat);
  animator.play('Wave', 0).seek(0.7).setPose({ headYaw: 0.2, blink: 0.4 });
  const originalRig = cat.userData.rig;
  const originalHead = originalRig.bones.Head.quaternion.clone();
  try {
    const exported = await exportAnimatedGLB(cat, animator.clips);
    assert.equal(exported.report.issues.numErrors, 0);
    assert.equal(exported.report.issues.numWarnings, 0);
    assert.deepEqual(exported.animations, CLIP_NAMES);
    assert.ok(exported.binary.byteLength > 1000);
    assert.ok(exported.binary.byteLength < exported.originalBytes, 'the optimized export should remove redundant animation data');
    assert.equal(cat.userData.rig, originalRig, 'export must restore the runtime controller data');
    assert.ok(originalRig.bones.Head.quaternion.equals(originalHead), 'export must preserve the edited source pose');

    const json = glbJSON(exported.binary);
    assert.equal(json.animations.length, CLIP_NAMES.length);
    assert.ok(json.skins.length >= 1);
    assert.ok(json.skins.every(skin => skin.joints.length === 26));
    const skinnedNodes = json.nodes.filter(node => Number.isInteger(node.skin));
    assert.equal(skinnedNodes.length, 19, 'all character surfaces retain their skin; attached props are rigid meshes');
    for (const node of skinnedNodes) {
      const mesh = json.meshes[node.mesh];
      for (const primitive of mesh.primitives) {
        assert.ok(Number.isInteger(primitive.attributes.JOINTS_0));
        assert.ok(Number.isInteger(primitive.attributes.WEIGHTS_0));
      }
    }

    const buffer = exported.binary.buffer.slice(exported.binary.byteOffset, exported.binary.byteOffset + exported.binary.byteLength);
    const loaded = await new GLTFLoader().parseAsync(buffer, '');
    assert.deepEqual(loaded.animations.map(clip => clip.name), exported.animations);
    const meshes = [];
    loaded.scene.traverse(object => { if (object.isSkinnedMesh) meshes.push(object); });
    assert.equal(meshes.length, 19);
    assert.equal(meshes.filter(mesh => mesh.geometry.hasAttribute('color')).length, style === 'ps2' ? 10 : 0);
    for (const mesh of meshes) {
      assertSkinWeights(mesh, mesh.skeleton.bones.length);
      assertFiniteAttributes(mesh);
    }
    const loadedEye = loaded.scene.getObjectByName('Eye_L');
    assert.ok(loadedEye?.isBone);
    const mixer = new THREE.AnimationMixer(loaded.scene);
    mixer.clipAction(loaded.animations.find(clip => clip.name === 'Idle')).play();
    mixer.setTime(1.28);
    loaded.scene.updateMatrixWorld(true);
    assert.ok(loadedEye.scale.y < 0.4, 'the reloaded clip must animate the actual eye bone');
    // The downloadable rigs must keep both elbow and knee paths, including
    // mid-key interpolation, rather than only retaining valid skin data.
    const limbJoints = ['UpperArm_L', 'Forearm_L', 'Hand_L', 'UpperArm_R', 'Forearm_R', 'Hand_R',
      'Thigh_L', 'Shin_L', 'Foot_L', 'Thigh_R', 'Shin_R', 'Foot_R'];
    const expectedPoint = new THREE.Vector3();
    const exportedPoint = new THREE.Vector3();
    for (const clip of loaded.animations) {
      mixer.stopAllAction();
      const action = mixer.clipAction(clip).reset();
      action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
      animator.play(clip.name, 0);
      for (const fraction of [0, .137, .333, .619, .887, 1]) {
        const time = clip.duration * fraction;
        animator.seek(time); mixer.setTime(time); loaded.scene.updateMatrixWorld(true);
        for (const name of limbJoints) {
          originalRig.bones[name].getWorldPosition(expectedPoint);
          loaded.scene.getObjectByName(name).getWorldPosition(exportedPoint);
          const pathError = expectedPoint.distanceTo(exportedPoint);
          assert.ok(pathError < .001,
            `${style}/${clip.name}/${name} at ${time.toFixed(4)}s changes its path after optimized GLB export by ${pathError.toFixed(6)}`);
        }
      }
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(loaded.scene);
  } finally {
    animator.dispose();
    if (previousFileReader === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = previousFileReader;
  }
});
}

function walkHeadSurfaceMetric(point) {
  // The shoulder caps intentionally meet the underside of the head at the
  // neck. Above that join, every part of the arm must stay outside its volume.
  if (point.y <= 3.28 || point.y >= 5.42) return Infinity;
  const t = point.y >= 4.17 ? (point.y - 4.17) / 1.25 : (point.y - 4.17) / 1.07;
  const exponent = t < 0 ? 2.85 : 2.05;
  const radius = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), exponent)), 1 / exponent);
  return Math.pow(Math.abs(point.x) / (1.58 * radius), 2.2)
    + Math.pow(Math.abs(point.z) / (.94 * radius), 2.2);
}

function walkTorsoSurfaceMetric(point) {
  if (point.y <= 1.36 || point.y >= 3.20) return Infinity;
  const height = (point.y - 1.36) / 1.84;
  const bottom = point.y < 1.49 ? Math.sqrt(Math.max(0, 1 - ((point.y - 1.49) / .13) ** 2)) : 1;
  const top = point.y > 3.04 ? Math.sqrt(Math.max(0, 1 - ((point.y - 3.04) / .16) ** 2)) : 1;
  const width = (.505 - .11 * height) * bottom * top;
  const depth = (.35 - .065 * height) * bottom * top;
  return Math.pow(Math.abs(point.x) / width, 2.8) + Math.pow(Math.abs(point.z) / depth, 2.8);
}

function torsoWeightSampler(mesh, spineIndex) {
  // Read the body's actual vertex weights, including its LOD-specific ring
  // spacing. Interpolate that skinning field when unposing a nearby arm point.
  const rows = new Map();
  const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
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
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (samples[middle][0] <= y) low = middle;
      else high = middle;
    }
    const t = (y - samples[low][0]) / (samples[high][0] - samples[low][0]);
    return THREE.MathUtils.lerp(samples[low][1], samples[high][1], t);
  };
}

for (const style of STYLES) {
  for (const [gait, duration] of [['Walk', 1.2], ['Run', .8], ['Sprint', .6]]) {
  test(`${style}: ${gait} elbows stay tucked while forearms swing beside the torso without clipping`, () => {
    const cat = rigCat(createCat({ style }));
    const animator = createAnimator(cat);
    const rig = cat.userData.rig;
    const boneIndex = name => rig.skeleton.bones.indexOf(rig.bones[name]);
    const hipsIndex = boneIndex('Hips');
    const spineIndex = boneIndex('Spine');
    const headIndex = boneIndex('Head');
    const weightAtY = torsoWeightSampler(cat.userData.parts.body, spineIndex);
    const point = new THREE.Vector3();
    const unposed = new THREE.Vector3();
    const blend = new THREE.Matrix4();
    const inverseBlend = new THREE.Matrix4();
    const ranges = { L: { x: [Infinity, -Infinity], z: [Infinity, -Infinity] }, R: { x: [Infinity, -Infinity], z: [Infinity, -Infinity] } };
    animator.play(gait, 0);

    for (let frame = 0; frame < 64; frame++) {
      animator.seek(duration * frame / 64);
      const context = `${style} ${gait} frame ${frame}`;
      const inverseSpine = rig.bones.Spine.matrixWorld.clone().invert();
      const hips = new THREE.Matrix4().multiplyMatrices(rig.bones.Hips.matrixWorld, rig.skeleton.boneInverses[hipsIndex]);
      const inverseHips = hips.clone().invert();
      const spine = new THREE.Matrix4().multiplyMatrices(rig.bones.Spine.matrixWorld, rig.skeleton.boneInverses[spineIndex]);
      const inverseHead = new THREE.Matrix4().multiplyMatrices(rig.bones.Head.matrixWorld, rig.skeleton.boneInverses[headIndex]).invert();

      for (const [side, part] of [['L', 'leftArm'], ['R', 'rightArm']]) {
        // Measure in the torso's frame so natural pelvis sway and turning do
        // not count as an elbow flare or a sideways forearm swing.
        const shoulder = rig.bones[`UpperArm_${side}`].getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseSpine);
        const elbow = rig.bones[`Forearm_${side}`].getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseSpine);
        const hand = rig.bones[`Hand_${side}`].getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseSpine);
        const fastGait = gait !== 'Walk';
        assert.ok(Math.abs(elbow.x) < (fastGait ? .85 : .72), `${context}/${side} elbow flares away from the torso`);
        assert.ok((side === 'L' ? -1 : 1) * elbow.x > (fastGait ? .67 : .36),
          `${context}/${side} elbow pinches inward instead of leaving natural running clearance`);
        assert.ok(Math.abs(elbow.x - shoulder.x) < (fastGait ? .50 : .38), `${context}/${side} upper arm spreads sideways`);
        assert.ok(elbow.z < (gait === 'Sprint' ? .16 : .05), `${context}/${side} elbow should bend behind the hanging upper arm`);
        assert.ok(Math.abs(hand.x - elbow.x) < (fastGait ? .28 : .25), `${context}/${side} forearm bends sideways instead of forward/back`);
        for (const axis of ['x', 'z']) {
          ranges[side][axis][0] = Math.min(ranges[side][axis][0], hand[axis]);
          ranges[side][axis][1] = Math.max(ranges[side][axis][1], hand[axis]);
        }

        const mesh = cat.userData.parts[part].children[0];
        const upperIndex = boneIndex(`UpperArm_${side}`);
        const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
        for (let i = 0; i < position.count; i++) {
          cpuVertex(mesh, i, point);
          unposed.copy(point).applyMatrix4(inverseHead);
          assert.ok(walkHeadSurfaceMetric(unposed) >= 1 - .0001,
            `${context}/${side} arm vertex ${i} enters the head`);

          let upperWeight = 0;
          for (let j = 0; j < 4; j++) if (skinIndex.getComponent(i, j) === upperIndex) upperWeight += skinWeight.getComponent(i, j);
          // The proximal upper arm joins the shoulder/armpit volume. The elbow
          // center and the entire free forearm must clear the separate torso.
          if (upperWeight > .500001) continue;
          unposed.copy(point).applyMatrix4(inverseHips);
          for (let iteration = 0; iteration < 5; iteration++) {
            const t = weightAtY(unposed.y);
            for (let component = 0; component < 16; component++) {
              blend.elements[component] = hips.elements[component] * (1 - t) + spine.elements[component] * t;
            }
            unposed.copy(point).applyMatrix4(inverseBlend.copy(blend).invert());
          }
          assert.ok(walkTorsoSurfaceMetric(unposed) >= 1 - .0001,
            `${context}/${side} elbow/forearm vertex ${i} enters the torso`);
        }
      }
    }
    for (const side of ['L', 'R']) {
      const lateral = ranges[side].x[1] - ranges[side].x[0];
      const sagittal = ranges[side].z[1] - ranges[side].z[0];
      assert.ok(sagittal > .44, `${style}/${gait}/${side} arm must still swing visibly`);
      assert.ok(lateral < .20 && sagittal > lateral * 3, `${style}/${side} swing must stay mainly in the forward/back plane`);
    }
    animator.dispose();
  });
}
}

for (const style of STYLES) {
  test(`${style}: Sprint changes stride, flight and forward drive while keeping feet upright`, () => {
    const cat = rigCat(createCat({ style }));
    const animator = createAnimator(cat);
    const rig = cat.userData.rig;
    const point = new THREE.Vector3();
    const up = new THREE.Vector3();
    const measurements = {};
    for (const name of ['Walk', 'Run', 'Sprint']) {
      animator.play(name, 0);
      const data = {
        duration: animator.getState().duration,
        flight: 0, stride: [Infinity, -Infinity], armSwing: [Infinity, -Infinity],
        hips: 0, forward: 0, soleMinimum: Infinity, poses: [],
      };
      for (let frame = 0; frame < 96; frame++) {
        animator.seek(data.duration * frame / 96);
        const inverseSpine = rig.bones.Spine.matrixWorld.clone().invert();
        const soles = [];
        for (const [side, part] of [['L', 'leftLeg'], ['R', 'rightLeg']]) {
          const mesh = cat.userData.parts[part].children[0];
          let minimum = Infinity;
          for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
            minimum = Math.min(minimum, cpuVertex(mesh, i, point).y);
          }
          soles.push(minimum);
          data.soleMinimum = Math.min(data.soleMinimum, minimum);
          const foot = rig.bones[`Foot_${side}`];
          const rotation = foot.getWorldQuaternion(new THREE.Quaternion());
          up.set(0, 1, 0).applyQuaternion(rotation);
          assert.ok(up.y > .95, `${style}/${name} sole tips or inverts during a stride`);
          foot.getWorldPosition(point);
          data.stride[0] = Math.min(data.stride[0], point.z);
          data.stride[1] = Math.max(data.stride[1], point.z);
          const thigh = rig.bones[`Thigh_${side}`].getWorldPosition(new THREE.Vector3());
          const shin = rig.bones[`Shin_${side}`].getWorldPosition(new THREE.Vector3());
          const axis = point.clone().sub(thigh).normalize();
          const bend = shin.sub(thigh);
          bend.addScaledVector(axis, -bend.dot(axis));
          assert.ok(bend.z >= -.0001, `${style}/${name} knee bends backwards`);
        }
        if (Math.min(...soles) > .035) data.flight++;
        assert.ok(Math.min(...soles) >= -.0001, `${style}/${name} skin penetrates the floor`);
        data.hips += rig.bones.Hips.position.y / 96;
        up.set(0, 1, 0).applyQuaternion(rig.bones.Spine.getWorldQuaternion(new THREE.Quaternion()));
        data.forward += up.z / 96;
        for (const name of ['Hand_L', 'Hand_R']) {
          rig.bones[name].getWorldPosition(point).applyMatrix4(inverseSpine);
          data.armSwing[0] = Math.min(data.armSwing[0], point.z);
          data.armSwing[1] = Math.max(data.armSwing[1], point.z);
        }
        for (const bone of [rig.bones.Hips, rig.bones.Head, rig.bones.Hand_L, rig.bones.Hand_R, rig.bones.Foot_L, rig.bones.Foot_R]) {
          bone.getWorldPosition(point);
          data.poses.push(...point);
        }
      }
      data.stride = data.stride[1] - data.stride[0];
      data.armSwing = data.armSwing[1] - data.armSwing[0];
      measurements[name] = data;
    }
    const { Walk: walk, Run: run, Sprint: sprint } = measurements;
    assert.equal(sprint.duration, .6);
    assert.ok(sprint.duration < run.duration && run.duration < walk.duration);
    assert.equal(walk.flight, 0, 'walking keeps a stance foot planted');
    assert.ok(run.flight > 0, 'running has a short airborne phase');
    assert.ok(sprint.flight > run.flight + 10, 'sprinting has a longer flight phase than a normal run');
    assert.ok(sprint.stride > run.stride * 1.25, 'Sprint lengthens the step instead of only speeding up Run');
    assert.ok(sprint.armSwing > run.armSwing * 1.15, 'Sprint drives the tucked forearms farther forward/back');
    assert.ok(sprint.forward > run.forward + .09, 'Sprint leans its torso forward');
    assert.ok(sprint.hips < run.hips - .06, 'Sprint loads the legs more deeply between strides');
    let squared = 0;
    sprint.poses.forEach((value, i) => { squared += (value - run.poses[i]) ** 2; });
    assert.ok(Math.sqrt(squared / sprint.poses.length) > .10,
      'Sprint must have different poses at matching phases, not a time-scaled Run');
    animator.dispose();
  });
}
