import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCat } from '../src/cat.js';
import { rigCat } from '../src/rig.js';
import { createAnimator, createAnimationClips } from '../src/animation.js';
import { DANCES, sampleDancePose } from '../src/dances.js';

const STYLES = ['original', 'dreamcast', 'ps1', 'ps2'];
const PARTY = new Set(['Fresh', 'Dance Moves', 'Dab', 'Hype', 'Groove Jam']);
const EXPECTED = [
  'Floss', 'Orange Justice', 'Best Mates', 'Take the L', 'Electro Shuffle',
  'Fresh', 'Dance Moves', 'Dab', 'Hype', 'Groove Jam',
];
const JOINTS = ['Hips', 'Head', 'Hand_L', 'Hand_R', 'Foot_L', 'Foot_R'];
const vector = (x, y, z) => new THREE.Vector3(x, y, z);

function cpuVertex(mesh, index, target) {
  target.fromBufferAttribute(mesh.geometry.attributes.position, index);
  return mesh.applyBoneTransform(index, target);
}

function jointPoints(cat) {
  return JOINTS.map(name => cat.userData.rig.bones[name].getWorldPosition(new THREE.Vector3()));
}

function skinSamples(cat) {
  const points = [];
  for (const mesh of cat.userData.rig.meshes) {
    const count = mesh.geometry.attributes.position.count;
    for (const fraction of [0, .25, .5, .75, 1]) {
      points.push(cpuVertex(mesh, Math.min(count - 1, Math.floor(count * fraction)), new THREE.Vector3()));
    }
  }
  return points;
}

// Observe choreography before IK/clip generation, so copying a final keyframe
// cannot hide a non-periodic source path. Real IK is tested on the skin below.
function rawSampler(cat) {
  const original = cat.userData.rig;
  const rig = { ...original, root: original.bones.Root, list: original.skeleton.bones };
  return (name, time, duration) => {
    original.resetPose();
    const targets = new Map();
    const solveTwoBone = (_rig, limb, target, pole, rotation = null) => {
      targets.set(limb, [...target, ...pole, ...(rotation ?? new THREE.Quaternion())]);
    };
    const helpers = {
      FOOT_HEIGHT: .133,
      solveTwoBone,
      plantFeet(_rig, spread = .37, forward = .07) {
        solveTwoBone(rig, 'foot_l', vector(-spread, .133, forward), vector(0, 0, 1));
        solveTwoBone(rig, 'foot_r', vector(spread, .133, forward), vector(0, 0, 1));
      },
      rotate(bone, x = 0, y = 0, z = 0) { bone.quaternion.setFromEuler(new THREE.Euler(x, y, z)); },
      smooth(value) { const t = THREE.MathUtils.clamp(value, 0, 1); return t * t * (3 - 2 * t); },
      blinkAt(time, centers, width = .17) {
        let blink = 0;
        for (const center of centers) {
          const distance = Math.abs(time - center) / (width / 2);
          if (distance < 1) blink = Math.max(blink, .5 + .5 * Math.cos(distance * Math.PI));
        }
        return blink;
      },
    };
    const handled = sampleDancePose(rig, name, time, duration, helpers);
    const values = [];
    for (const bone of rig.list) values.push(...bone.position, ...bone.quaternion, ...bone.scale);
    for (const limb of ['foot_l', 'foot_r', 'hand_l', 'hand_r']) values.push(...(targets.get(limb) ?? []));
    return { handled, values, targetCount: targets.size };
  };
}

test('ten named dances have finite periodic source choreography before endpoint copying', () => {
  assert.deepEqual(DANCES.map(dance => dance.name), EXPECTED);
  assert.equal(new Set(DANCES.map(dance => dance.name)).size, 10);
  const cat = rigCat(createCat({ style: 'ps2' }));
  const sample = rawSampler(cat);
  for (const dance of DANCES) {
    assert.ok(dance.duration > 0 && typeof dance.description === 'string');
    const start = sample(dance.name, 0, dance.duration);
    const end = sample(dance.name, dance.duration, dance.duration);
    assert.ok(start.handled && end.handled);
    assert.equal(start.targetCount, 4, `${dance.name} must pose both paws and both feet`);
    assert.equal(end.values.length, start.values.length);
    start.values.forEach((value, i) => {
      assert.ok(Number.isFinite(value) && Number.isFinite(end.values[i]));
      assert.ok(Math.abs(value - end.values[i]) < 1e-9, `${dance.name} source has a loop discontinuity`);
    });
    if (PARTY.has(dance.name)) {
      const epsilon = .001;
      const next = sample(dance.name, epsilon, dance.duration);
      const previous = sample(dance.name, dance.duration - epsilon, dance.duration);
      start.values.forEach((value, i) => {
        const outgoing = (next.values[i] - value) / epsilon;
        const incoming = (value - previous.values[i]) / epsilon;
        assert.ok(Math.abs(outgoing - incoming) < .03, `${dance.name} source velocity jumps at the seam`);
      });
    }
  }
  assert.equal(sample('Unknown dance', 0, 4).handled, false);
});

test('all dance clips have finite unit rotations and smooth skinned loop seams', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const clips = createAnimationClips(cat.userData.rig);
  const animator = createAnimator(cat);
  for (const dance of DANCES) {
    const clip = clips.find(clip => clip.name === dance.name);
    assert.ok(clip, `${dance.name} must be a portable AnimationClip`);
    assert.equal(clip.duration, dance.duration);
    assert.equal(clip.tracks.length, 26 * 3 + 4, 'bone transforms plus two portable prop scale/rotation tracks');
    for (const track of clip.tracks) {
      assert.equal(track.times.length, Math.round(dance.duration * (dance.name === 'Floss' ? 60 : 30)) + 1);
      for (const value of track.values) assert.ok(Number.isFinite(value), `${dance.name}/${track.name} has a non-finite key`);
      if (track.name.endsWith('.quaternion')) {
        for (let i = 0; i < track.values.length; i += 4) {
          assert.ok(Math.abs(new THREE.Quaternion().fromArray(track.values, i).length() - 1) < 1e-6);
        }
      }
    }
    animator.play(dance.name, 0).seek(0);
    const startSkin = skinSamples(cat);
    const center = jointPoints(cat);
    animator.seek(1 / 30);
    const next = jointPoints(cat);
    animator.seek(dance.duration - 1 / 30);
    const previous = jointPoints(cat);
    for (let i = 0; i < center.length; i++) {
      const incoming = center[i].clone().sub(previous[i]).multiplyScalar(30);
      const outgoing = next[i].clone().sub(center[i]).multiplyScalar(30);
      assert.ok(incoming.distanceTo(outgoing) < 2.5,
        `${dance.name}/${JOINTS[i]} has an abrupt seam velocity change`);
    }
    animator.seek(dance.duration - .00001);
    const endSkin = skinSamples(cat);
    startSkin.forEach((point, i) => assert.ok(point.distanceTo(endSkin[i]) < .004,
      `${dance.name} has a visible skinned seam`));
  }
  animator.dispose();
});

// Conservative analytic surface of the rounded head, in its original bind
// coordinates. The y<=3.28 neck join intentionally overlaps the shoulder caps.
function headSurfaceMetric(point) {
  if (point.y <= 3.28 || point.y >= 5.42) return Infinity;
  const t = point.y >= 4.17 ? (point.y - 4.17) / 1.25 : (point.y - 4.17) / 1.07;
  const exponent = t < 0 ? 2.85 : 2.05;
  const radius = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), exponent)), 1 / exponent);
  return Math.pow(Math.abs(point.x) / (1.58 * radius), 2.2)
    + Math.pow(Math.abs(point.z) / (.94 * radius), 2.2);
}

for (const style of STYLES) {
  test(`${style}: every dance keeps soles above the floor and arms outside the head`, () => {
    const cat = rigCat(createCat({ style }));
    const animator = createAnimator(cat);
    const rig = cat.userData.rig;
    const headIndex = rig.skeleton.bones.indexOf(rig.bones.Head);
    const point = new THREE.Vector3();
    const inverseHead = new THREE.Matrix4();
    const legs = ['leftLeg', 'rightLeg'].map(name => cat.userData.parts[name].children[0]);
    const arms = ['leftArm', 'rightArm'].map(name => cat.userData.parts[name].children[0]);
    for (const dance of DANCES) {
      animator.play(dance.name, 0);
      for (let frame = 0; frame < 64; frame++) {
        animator.seek(dance.duration * frame / 64);
        const where = `${style}/${dance.name} frame ${frame}`;
        for (const bone of rig.skeleton.bones) {
          for (const value of [...bone.position, ...bone.quaternion, ...bone.scale]) assert.ok(Number.isFinite(value), `${where} has a non-finite bone`);
          assert.ok(Math.abs(bone.quaternion.length() - 1) < 1e-5);
        }
        const soleHeights = legs.map(mesh => {
          let minimum = Infinity;
          for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
            minimum = Math.min(minimum, cpuVertex(mesh, i, point).y);
          }
          return minimum;
        });
        assert.ok(soleHeights.every(height => height >= -.0001), `${where} penetrates the floor: ${soleHeights}`);
        assert.ok(soleHeights.every(height => height < .40), `${where} exceeds the authored knee-lift range`);
        assert.ok(Math.min(...soleHeights) < .025, `${where} loses its planted stance foot`);

        inverseHead.multiplyMatrices(rig.bones.Head.matrixWorld, rig.skeleton.boneInverses[headIndex]).invert();
        for (const mesh of arms) {
          for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
            cpuVertex(mesh, i, point).applyMatrix4(inverseHead);
            assert.ok(headSurfaceMetric(point) >= 1 - .0001,
              `${where}/${mesh.name} vertex ${i} enters the head above the neck join`);
          }
        }
      }
    }
    animator.dispose();
  });
}

test('all ten dances retain distinct poses and travel rather than duplicating a generic sway', () => {
  const cat = rigCat(createCat({ style: 'ps2' }));
  const animator = createAnimator(cat);
  const signatures = DANCES.map(dance => {
    animator.play(dance.name, 0);
    const values = [];
    for (const fraction of [.03, .13, .29, .47, .61, .79, .93]) {
      animator.seek(dance.duration * fraction);
      for (const point of jointPoints(cat)) values.push(...point);
    }
    return { name: dance.name, values };
  });
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      let squared = 0;
      for (let k = 0; k < signatures[i].values.length; k++) {
        squared += (signatures[i].values[k] - signatures[j].values[k]) ** 2;
      }
      const distance = Math.sqrt(squared / signatures[i].values.length);
      assert.ok(distance > .12, `${signatures[i].name} and ${signatures[j].name} are insufficiently distinct (${distance})`);
    }
  }
  animator.dispose();
});
