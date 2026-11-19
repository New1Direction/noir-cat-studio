import * as THREE from 'three';
import { DANCES, sampleDancePose } from './dances.js';
import { ACTIONS, ONE_SHOT_CLIPS, sampleActionPose } from './actions.js';
import { attachActionProps, sampleActionProps } from './action-props.js';
import { solveLimbIK, resetLimbIK } from './limb-ik.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const CLIP_CACHE = new Map();
const PROP_NAMES = ['NoirBlaster', 'NoirSmokeProp'];
const DURATIONS = { Idle: 4, Walk: 1.2, Run: .8, Sprint: .6, Wave: 2.4, Sit: 2.8, ...Object.fromEntries([...DANCES, ...ACTIONS].map(clip => [clip.name, clip.duration])) };
const DEFAULT_POSE = { headYaw: 0, headPitch: 0, armRaise: 0, tailSway: 0, blink: 0, smile: 0 };
// A three-millimetre clearance absorbs the tiny skin-blend bow at the sole.
const FOOT_HEIGHT = .133;
const LIMBS = {
  hand_l: ['UpperArm_L', 'Forearm_L', 'Hand_L', -1],
  hand_r: ['UpperArm_R', 'Forearm_R', 'Hand_R', 1],
  foot_l: ['Thigh_L', 'Shin_L', 'Foot_L', -1],
  foot_r: ['Thigh_R', 'Shin_R', 'Foot_R', 1],
};

function asVector(value, fallback = new THREE.Vector3()) {
  if (value?.isVector3) return value.clone();
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return new THREE.Vector3().fromArray(value);
  if (value && Number.isFinite(value.x)) return new THREE.Vector3(value.x, value.y, value.z);
  return fallback.clone();
}

function sourceBones(rig) {
  return rig.skeleton?.bones ?? (rig.bones instanceof Map ? [...rig.bones.values()] : Object.values(rig.bones));
}

function restFor(rig, name) {
  return rig.rest instanceof Map ? rig.rest.get(name) : rig.rest[name];
}

function makeSamplingRig(rig) {
  const list = sourceBones(rig);
  const bones = Object.fromEntries(list.map(bone => [bone.name, new THREE.Bone()]));
  const rest = {};
  for (const source of list) {
    const bone = bones[source.name];
    const pose = restFor(rig, source.name);
    bone.name = source.name;
    bone.position.copy(asVector(pose?.position, source.position));
    bone.quaternion.identity();
    bone.scale.copy(asVector(pose?.scale, new THREE.Vector3(1, 1, 1)));
    if (source.parent?.isBone && bones[source.parent.name]) bones[source.parent.name].add(bone);
    rest[bone.name] = { position: bone.position.clone(), scale: bone.scale.clone() };
  }
  const root = bones.Root ?? Object.values(bones).find(bone => !bone.parent);
  root.updateMatrixWorld(true);
  return { bones, root, rest, list: list.map(source => bones[source.name]) };
}

function resetSamplingRig(rig) {
  for (const bone of rig.list) {
    bone.position.copy(rig.rest[bone.name].position);
    bone.quaternion.identity();
    bone.scale.copy(rig.rest[bone.name].scale);
  }
}

function rotate(bone, x = 0, y = 0, z = 0) {
  bone.quaternion.setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
}

function smooth(value) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function blinkAt(time, centers, width = .17) {
  let amount = 0;
  for (const center of centers) {
    const distance = Math.abs(time - center) / (width / 2);
    if (distance < 1) amount = Math.max(amount, .5 + .5 * Math.cos(distance * Math.PI));
  }
  return amount;
}

/**
 * Analytic two-bone IK. Inputs are in cat-local coordinates; a rig with world
 * placement is handled by its root's transform. Pole is a model-space vector.
 * Rest bone orientations are identity, while child offsets define each axis.
 */
function solveTwoBone(rig, limb, targetLocal, poleLocal, endRotation = null) {
  const names = LIMBS[limb];
  if (!names) return;
  return solveLimbIK(rig, names, targetLocal, poleLocal, {
    stableRoll: limb.startsWith('hand'),
    levelEnd: limb.startsWith('foot'), endRotation,
    minReachMargin: .001, maxReachMargin: .0005,
  });
}

function plantFeet(rig, spread = .37, forward = .07) {
  solveTwoBone(rig, 'foot_l', new THREE.Vector3(-spread, FOOT_HEIGHT, forward), new THREE.Vector3(0, 0, 1));
  solveTwoBone(rig, 'foot_r', new THREE.Vector3(spread, FOOT_HEIGHT, forward), new THREE.Vector3(0, 0, 1));
}

function gaitFoot(phase, mode) {
  const sprint = mode === 'Sprint';
  const run = mode === 'Run';
  const stance = sprint ? .34 : run ? .44 : .62;
  const stride = sprint ? .65 : run ? .47 : .27;
  const height = sprint ? .42 : run ? .31 : .17;
  const heel = sprint ? .15 : run ? .13 : .10;
  const toe = sprint ? .23 : run ? .18 : .14;
  let z, y, pitch;
  if (phase < stance) {
    const contact = phase / stance;
    z = THREE.MathUtils.lerp(stride, -stride, contact);
    y = FOOT_HEIGHT;
    // Heel contact settles to a level sole before the toe pushes off.
    pitch = contact < .22
      ? THREE.MathUtils.lerp(-heel, 0, smooth(contact / .22))
      : toe * smooth((contact - .70) / .30);
  } else {
    const swing = (phase - stance) / (1 - stance);
    const u2 = swing * swing;
    const u3 = u2 * swing;
    // Match the backwards stance velocity at either end of the airborne arc.
    // This gives a continuous foot path rather than stopping at each contact.
    const tangent = -2 * stride * (1 - stance) / stance;
    z = (2 * u3 - 3 * u2 + 1) * -stride + (u3 - 2 * u2 + swing) * tangent
      + (-2 * u3 + 3 * u2) * stride + (u3 - u2) * tangent;
    y = FOOT_HEIGHT + height * Math.pow(Math.sin(swing * Math.PI), 1.25);
    pitch = THREE.MathUtils.lerp(toe, -heel, smooth(swing));
  }
  // Keep the rolled, softly rounded sole above the floor without a visible gap.
  y += .012 * Math.abs(pitch) / .23 + (sprint ? .010 : 0);
  return { z, y, pitch };
}

function samplePose(rig, name, time, duration) {
  resetSamplingRig(rig);
  const b = rig.bones;
  const phase = time / duration * TAU;
  const sine = Math.sin(phase);
  const strideBob = Math.cos(phase * 2);
  let blink = 0;

  const dance = sampleDancePose(rig, name, time, duration, { solveTwoBone, plantFeet, rotate, smooth, blinkAt, FOOT_HEIGHT });
  const action = !dance && sampleActionPose(rig, name, time, duration, { solveTwoBone, plantFeet, rotate, smooth, blinkAt, FOOT_HEIGHT });
  if (dance || action) {
    // Dance modules set their own body/limb/face choreography. The same baked
    // secondary motion below gives each dance responsive ears and tail.
  } else if (name === 'Idle') {
    b.Hips.position.y -= .035 - .012 * sine;
    b.Spine.position.y += .009 * sine;
    rotate(b.Hips, 0, .012 * sine, .009 * Math.sin(phase + .5));
    rotate(b.Spine, .012 * Math.sin(phase + .4), -.012 * sine, -.009 * Math.sin(phase + .5));
    rotate(b.Head, .016 * Math.sin(phase + .7), .035 * Math.sin(phase - .4), .012 * sine);
    rotate(b.Forearm_L, -.025 + .012 * sine, 0, -.012);
    rotate(b.Forearm_R, -.025 - .012 * sine, 0, .012);
    plantFeet(rig);
    blink = blinkAt(time, [1.28, 3.37]);
  } else if (name === 'Walk' || name === 'Run' || name === 'Sprint') {
    const run = name === 'Run';
    const sprint = name === 'Sprint';
    const fast = run || sprint;
    const bob = Math.cos(phase * 2 + (sprint ? Math.PI * .32 : run ? Math.PI * .12 : 0));
    b.Hips.position.x -= (sprint ? .060 : run ? .050 : .038) * sine;
    b.Hips.position.y -= (sprint ? .29 : run ? .20 : .12) - (sprint ? .075 : run ? .045 : .018) * bob;
    rotate(b.Hips, sprint ? .18 : run ? .095 : .025, (sprint ? .055 : run ? .04 : .025) * sine, (sprint ? .045 : run ? .033 : .025) * sine);
    rotate(b.Spine, sprint ? .10 : run ? .045 : 0, -(sprint ? .09 : run ? .065 : .045) * sine, -(sprint ? .060 : run ? .045 : .035) * sine);
    rotate(b.Head, (sprint ? -.23 : run ? -.13 : -.018) + (sprint ? .014 : .018) * bob, .035 * sine, .012 * sine);
    rig.root.updateMatrixWorld(true);
    for (const [side, offset] of [[-1, 0], [1, .5]]) {
      const cycle = (time / duration + offset) % 1;
      const foot = gaitFoot(cycle, name);
      const footRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), foot.pitch);
      solveTwoBone(rig, side < 0 ? 'foot_l' : 'foot_r', new THREE.Vector3(side * .37, foot.y, foot.z + .07), new THREE.Vector3(0, 0, 1), footRotation);
      const swing = Math.cos(cycle * TAU);
      const hand = new THREE.Vector3(
        side * (sprint ? .94 : run ? .91 : .75),
        fast ? (sprint ? 2.10 : 2.04) - (sprint ? .18 : .14) * swing : 1.57 + .025 * swing,
        (sprint ? .14 : run ? .10 : .04) - swing * (sprint ? .62 : run ? .47 : .26),
      );
      const sprintHand = sprint ? new THREE.Vector3(side * .94, .06 - .35 * swing, .14 - .62 * swing) : null;
      if (sprint) hand.copy(sprintHand).applyMatrix4(b.Spine.matrixWorld);
      // Walking arms stay close; faster gaits open up with breathing room
      // between the elbow and torso while pumping mainly forward and back.
      const elbowPole = new THREE.Vector3(side * (fast ? .26 : .28), fast ? -.55 : -.15, -1);
      if (fast) {
        // Select a comfortable elbow corridor in torso coordinates, with a
        // little lateral give through the stride instead of a rigid pin.
        const shoulder = b[side < 0 ? 'UpperArm_L' : 'UpperArm_R'].position;
        const localHand = sprintHand ?? hand.clone().applyMatrix4(b.Spine.matrixWorld.clone().invert());
        const axis = localHand.clone().sub(shoulder);
        const distance = axis.length();
        axis.divideScalar(distance);
        const upperLength = rig.rest[side < 0 ? 'Forearm_L' : 'Forearm_R'].position.length();
        const lowerLength = rig.rest[side < 0 ? 'Hand_L' : 'Hand_R'].position.length();
        const along = (upperLength * upperLength + distance * distance - lowerLength * lowerLength) / (2 * distance);
        const bendRadius = Math.sqrt(Math.max(.000001, upperLength * upperLength - along * along));
        const centerX = shoulder.x + axis.x * along;
        const lateral = new THREE.Vector3(1, 0, 0).addScaledVector(axis, -axis.x).normalize();
        const around = new THREE.Vector3().crossVectors(axis, lateral).normalize();
        const elbowWidth = (sprint ? .77 : .74) + .02 * swing;
        const amount = THREE.MathUtils.clamp((side * elbowWidth - centerX) / (bendRadius * lateral.x), -.999, .999);
        elbowPole.copy(lateral).multiplyScalar(amount)
          .addScaledVector(around, -Math.sign(around.z) * Math.sqrt(1 - amount * amount))
          .transformDirection(b.Spine.matrixWorld);
      }
      solveTwoBone(rig, side < 0 ? 'hand_l' : 'hand_r', hand, elbowPole);
    }
  } else if (name === 'Wave') {
    b.Hips.position.y -= .045 - .008 * sine;
    rotate(b.Spine, 0, -.025, .018);
    rotate(b.Head, .015 * sine, -.055, -.035 + .014 * sine);
    plantFeet(rig);
    // The tiny arm cannot reach above the giant head without stretching.
    // Wave beside the outer cheek, routing the elbow below its silhouette.
    const hand = new THREE.Vector3(1.77 + .035 * Math.sin(phase * 2), 3.37 + .055 * Math.cos(phase * 2), .09);
    const wrist = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, .08 * Math.sin(phase * 2), .16 * Math.sin(phase * 2)));
    solveTwoBone(rig, 'hand_r', hand, new THREE.Vector3(.25, -1, .14), wrist);
    rotate(b.Forearm_L, -.035, 0, -.02);
    blink = blinkAt(time, [1.70]);
  } else if (name === 'Sit') {
    const settle = smooth(time / .9);
    const breath = time > .9 ? Math.sin((time - .9) * 2.0) * .003 : 0;
    b.Hips.position.y -= .98 * settle - breath;
    b.Hips.position.z -= .08 * settle;
    rotate(b.Hips, .12 * settle, 0, 0);
    rotate(b.Spine, .025 * settle, 0, 0);
    rotate(b.Head, -.135 * settle + breath, 0, .008 * settle);
    const spread = THREE.MathUtils.lerp(.37, .48, settle);
    const forward = THREE.MathUtils.lerp(.07, 1.02, settle);
    plantFeet(rig, spread, forward);
    for (const side of [-1, 1]) {
      // Rest the paws over the knees, with the upper arms hanging beside the
      // torso. A forward pole lifts the elbows and leaves the paws dangling.
      const hand = new THREE.Vector3(side * THREE.MathUtils.lerp(1.28, .31, settle), THREE.MathUtils.lerp(1.78, .83, settle), THREE.MathUtils.lerp(.035, .62, settle));
      solveTwoBone(rig, side < 0 ? 'hand_l' : 'hand_r', hand, new THREE.Vector3(side * .75, -1, -.25));
    }
    blink = blinkAt(time, [.55]);
  }

  // All secondary motion is sampled into portable clips, not runtime-only
  // springs, so tail and ear motion survives GLB export.
  for (let i = 0; i <= 4; i++) {
    const amount = dance ? .085 : name === 'Sprint' ? .16 : name === 'Run' ? .13 : name === 'Walk' ? .095 : name === 'Wave' ? .08 : .045;
    const settled = name === 'Sit' ? smooth(time / .9) : 0;
    const secondaryPhase = dance ? phase * 4 : phase;
    const secondary = new THREE.Quaternion().setFromEuler(new THREE.Euler(-.055 * settled, amount * Math.sin(secondaryPhase - i * .48) * (1 - settled * .7), .016 * Math.cos(secondaryPhase - i * .4)));
    if (dance) b[`Tail_${i}`].quaternion.multiply(secondary).normalize();
    else b[`Tail_${i}`].quaternion.copy(secondary);
  }
  const twitch = name === 'Idle' ? .045 * Math.pow(Math.max(0, Math.sin(phase * 2)), 7) : .012 * sine;
  rotate(b.Ear_L, .01 * Math.sin(phase - .4), 0, -.015 * sine - twitch);
  rotate(b.Ear_R, .01 * Math.sin(phase + .4), 0, .015 * Math.sin(phase + .8) + twitch * .65);
  b.Eye_L.scale.y = Math.min(b.Eye_L.scale.y, 1 - blink * .94);
  b.Eye_R.scale.y = Math.min(b.Eye_R.scale.y, 1 - blink * .94);
  if (name === 'Wave') { b.Mouth.scale.x = 1.06; b.Mouth.scale.y = 1.05; }
  rig.root.updateMatrixWorld(true);
}

/** Bake portable tracks at 30fps; use 60fps for recoil and fast Floss reaches. */
export function createAnimationClips(rig) {
  if (!rig?.skeleton) throw new Error('createAnimationClips needs a rig created by rigCat().');
  const sampling = makeSamplingRig(rig);
  const signature = sampling.list.map(bone => `${bone.name}:${bone.position.toArray().join(',')}`).join('|');
  if (CLIP_CACHE.has(signature)) return CLIP_CACHE.get(signature).map(clip => clip.clone());
  const clips = [];
  for (const [name, duration] of Object.entries(DURATIONS)) {
    resetLimbIK(sampling);
    const frames = Math.round(duration * (['Shoot', 'Floss'].includes(name) ? 60 : 30));
    const times = Float32Array.from({ length: frames + 1 }, (_, i) => i / frames * duration);
    const values = Object.fromEntries(sampling.list.map(bone => [bone.name, { position: [], quaternion: [], scale: [] }]));
    const propValues = Object.fromEntries(PROP_NAMES.map(prop => [prop, { quaternion: [], scale: [] }]));
    for (let frame = 0; frame <= frames; frame++) {
      samplePose(sampling, name, times[frame], duration);
      const props = sampleActionProps(sampling, name, times[frame], duration);
      for (const prop of PROP_NAMES) {
        props[prop].scale.toArray(propValues[prop].scale, frame * 3);
        const q = props[prop].quaternion.clone().normalize();
        if (frame > 0 && q.dot(new THREE.Quaternion().fromArray(propValues[prop].quaternion, (frame - 1) * 4)) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        q.toArray(propValues[prop].quaternion, frame * 4);
      }
      for (const bone of sampling.list) {
        const entry = values[bone.name];
        const q = bone.quaternion.clone().normalize();
        if (frame > 0) {
          const previous = new THREE.Quaternion().fromArray(entry.quaternion, (frame - 1) * 4);
          if (previous.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        }
        bone.position.toArray(entry.position, frame * 3);
        q.toArray(entry.quaternion, frame * 4);
        bone.scale.toArray(entry.scale, frame * 3);
      }
    }
    const tracks = [];
    for (const bone of sampling.list) {
      const entry = values[bone.name];
      if (!ONE_SHOT_CLIPS.has(name)) {
        for (const [property, size] of [['position', 3], ['quaternion', 4], ['scale', 3]]) {
          for (let i = 0; i < size; i++) entry[property][frames * size + i] = entry[property][i];
        }
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, entry.position));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, entry.quaternion));
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.scale`, times, entry.scale));
    }
    for (const prop of PROP_NAMES) {
      const entry = propValues[prop];
      if (!ONE_SHOT_CLIPS.has(name)) {
        for (const [property, size] of [['quaternion', 4], ['scale', 3]]) {
          for (let i = 0; i < size; i++) entry[property][frames * size + i] = entry[property][i];
        }
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${prop}.scale`, times, entry.scale));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${prop}.quaternion`, times, entry.quaternion));
    }
    const clip = new THREE.AnimationClip(name, duration, tracks);
    clips.push(clip);
  }
  CLIP_CACHE.set(signature, clips);
  return clips.map(clip => clip.clone());
}

function savePose(bones) {
  return bones.map(bone => ({ position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() }));
}

function restorePose(bones, pose) {
  bones.forEach((bone, i) => { bone.position.copy(pose[i].position); bone.quaternion.copy(pose[i].quaternion); bone.scale.copy(pose[i].scale); });
}

/** Animation playback, additive expression controls, and optional limb targets. */
export function createAnimator(cat) {
  const rig = cat.userData.rig;
  if (!rig?.skeleton) throw new Error('Call rigCat(cat) before createAnimator(cat).');
  attachActionProps(cat);
  const list = sourceBones(rig);
  const bones = Object.fromEntries(list.map(bone => [bone.name, bone]));
  const runtimeRig = {
    root: bones.Root,
    bones,
    rest: Object.fromEntries(list.map(bone => [bone.name, { position: asVector(restFor(rig, bone.name)?.position, bone.position) }])),
  };
  const clips = createAnimationClips(rig);
  const mixer = new THREE.AnimationMixer(cat);
  const actions = new Map(clips.map(clip => [clip.name, mixer.clipAction(clip)]));
  const builtInNames = new Set(clips.map(clip => clip.name));
  const loopPolicy = new Map(clips.map(clip => [clip.name, !ONE_SHOT_CLIPS.has(clip.name)]));
  const loops = clipName => loopPolicy.get(clipName) ?? false;
  let name = 'Idle';
  let paused = false;
  let speed = 1;
  let disposed = false;
  let basePose = savePose(list);
  const manual = { ...DEFAULT_POSE };
  const ikTargets = new Map();
  let active = null;

  function applyControls() {
    bones.Head.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(manual.headPitch, manual.headYaw, 0))).normalize();
    for (let i = 0; i <= 4; i++) bones[`Tail_${i}`].quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(UP, manual.tailSway * (i === 0 ? 1 : .18))).normalize();
    bones.Eye_L.scale.y = Math.min(bones.Eye_L.scale.y, 1 - manual.blink * .94);
    bones.Eye_R.scale.y = Math.min(bones.Eye_R.scale.y, 1 - manual.blink * .94);
    bones.Mouth.scale.x *= 1 + manual.smile * .16;
    bones.Mouth.scale.y *= 1 + manual.smile * .28;
    cat.updateMatrixWorld(true);
    if (Math.abs(manual.armRaise) > .00001) {
      const factor = THREE.MathUtils.clamp(Math.abs(manual.armRaise) / 1.2, 0, 1);
      for (const side of [-1, 1]) {
        const hand = bones[side < 0 ? 'Hand_L' : 'Hand_R'].getWorldPosition(new THREE.Vector3());
        cat.worldToLocal(hand);
        const target = manual.armRaise > 0 ? new THREE.Vector3(side * 1.77, 3.37, .09) : new THREE.Vector3(side * .75, 1.70, .08);
        solveTwoBone(runtimeRig, side < 0 ? 'hand_l' : 'hand_r', hand.lerp(target, factor), new THREE.Vector3(side * .25, -1, .14));
      }
    }
    for (const [limb, target] of ikTargets) {
      const side = LIMBS[limb][3];
      solveTwoBone(runtimeRig, limb, target, limb.startsWith('foot') ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(side * .7, -.7, .35));
    }
    cat.updateMatrixWorld(true);
  }

  function evaluate(delta = 0) {
    if (disposed) return;
    // Restore the mixer's last result before applying it again. Resetting to
    // bind pose here would break paused playback: PropertyMixer avoids writes
    // when its output values did not change. The cached base also prevents
    // manual offsets or IK from accumulating across frames.
    restorePose(list, basePose);
    mixer.update(paused ? 0 : Math.max(0, Math.min(Number(delta) || 0, .1)));
    basePose = savePose(list);
    applyControls();
  }

  const controller = {
    clips,
    mixer,
    hasClip(clipName) { return actions.has(clipName); },
    addClip(clip, { loop = false } = {}) {
      if (!clip?.isAnimationClip && !(clip instanceof THREE.AnimationClip)) throw new Error('Choose a valid animation clip.');
      if (!clip.name || builtInNames.has(clip.name)) throw new Error('Imported motion cannot replace a built-in animation.');
      if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 20.1 || !clip.tracks.length) throw new Error('Imported motion must be between 0 and 20 seconds long.');
      const allowed = new Set([...list.map(bone => bone.name), ...PROP_NAMES]);
      const bindings = new Set();
      for (const track of clip.tracks) {
        const [target, property] = track.name.split('.');
        const stride = property === 'quaternion' ? 4 : 3;
        if (!allowed.has(target) || !['position', 'quaternion', 'scale'].includes(property)
          || bindings.has(track.name) || track.name !== `${target}.${property}`
          || track.values.length !== track.times.length * stride
          || track.ValueTypeName !== (property === 'quaternion' ? 'quaternion' : 'vector')
          || !track.times.length || !Array.from(track.values).every(Number.isFinite)
          || !Array.from(track.times).every((time, index, times) => Number.isFinite(time) && time >= 0 && time <= clip.duration + .0001 && (index === 0 || time > times[index - 1]))) {
          throw new Error('The imported motion contains invalid animation data.');
        }
        bindings.add(track.name);
      }
      if (actions.has(clip.name)) controller.removeClip(clip.name);
      const imported = clip.clone();
      clips.push(imported); actions.set(imported.name, mixer.clipAction(imported)); loopPolicy.set(imported.name, Boolean(loop));
      return controller;
    },
    removeClip(clipName) {
      if (builtInNames.has(clipName)) throw new Error('Built-in animations cannot be removed.');
      const action = actions.get(clipName);
      if (!action) return false;
      if (name === clipName) controller.play('Idle', 0).seek(0);
      action.stop(); mixer.uncacheAction(action.getClip(), cat); mixer.uncacheClip(action.getClip());
      actions.delete(clipName); loopPolicy.delete(clipName);
      const index = clips.findIndex(clip => clip.name === clipName);
      if (index >= 0) clips.splice(index, 1);
      return true;
    },
    play(nextName, fade = .3) {
      if (!actions.has(nextName)) throw new Error(`Unknown Noir animation: ${nextName}`);
      if (active && name === nextName && loops(nextName)) return controller;
      restorePose(list, basePose);
      const next = actions.get(nextName);
      next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
      next.setLoop(loops(nextName) ? THREE.LoopRepeat : THREE.LoopOnce, loops(nextName) ? Infinity : 1);
      next.clampWhenFinished = !loops(nextName);
      next.play();
      if (active && active !== next) {
        active.stopFading();
        if (fade > 0) active.crossFadeTo(next, fade, false);
        else { for (const action of actions.values()) if (action !== next) action.stop(); }
      }
      active = next; name = nextName;
      evaluate(0);
      return controller;
    },
    update(delta) { evaluate(delta); return controller; },
    seek(seconds) {
      if (!active) return controller;
      restorePose(list, basePose);
      for (const action of actions.values()) if (action !== active) action.stop();
      active.stopFading().setEffectiveWeight(1);
      const duration = active.getClip().duration;
      const requested = Math.max(0, Number(seconds) || 0);
      active.time = loops(name) ? requested % duration : Math.min(requested, duration);
      active.enabled = true; active.paused = !loops(name) && requested >= duration;
      evaluate(0);
      return controller;
    },
    setPaused(value) { paused = Boolean(value); evaluate(0); return controller; },
    setSpeed(value) { speed = THREE.MathUtils.clamp(Number(value) || 0, 0, 4); mixer.timeScale = speed; return controller; },
    getState() {
      return { name, time: active?.time ?? 0, duration: active?.getClip().duration ?? 0, paused, speed, finished: !loops(name) && !!active && active.time >= active.getClip().duration, pose: { ...manual }, ikTargets: Object.fromEntries([...ikTargets].map(([key, vector]) => [key, vector.toArray()])) };
    },
    reset() {
      for (const action of actions.values()) action.stop();
      active = null; paused = false; speed = 1; mixer.timeScale = 1;
      Object.assign(manual, DEFAULT_POSE); ikTargets.clear();
      rig.resetPose(); basePose = savePose(list);
      controller.play('Idle', 0); controller.seek(0);
      return controller;
    },
    setPose(pose = {}) {
      const limits = { headYaw: [-1.2, 1.2], headPitch: [-.65, .65], armRaise: [-1.2, 1.2], tailSway: [-1.0, 1.0], blink: [0, 1], smile: [-1, 1] };
      for (const key of Object.keys(DEFAULT_POSE)) if (Number.isFinite(pose[key])) manual[key] = THREE.MathUtils.clamp(pose[key], ...limits[key]);
      evaluate(0); return controller;
    },
    setIKTarget(limb, target) {
      if (!LIMBS[limb]) throw new Error(`Unknown Noir IK target: ${limb}`);
      const value = asVector(target);
      if (![value.x, value.y, value.z].every(Number.isFinite)) throw new Error('IK target coordinates must be finite.');
      ikTargets.set(limb, value); evaluate(0); return controller;
    },
    clearIK() { ikTargets.clear(); evaluate(0); return controller; },
    dispose() { if (disposed) return; disposed = true; mixer.stopAllAction(); mixer.uncacheRoot(cat); ikTargets.clear(); },
  };
  controller.play('Idle', 0);
  return controller;
}
