import * as THREE from 'three';

export const ACTIONS = [
  { name: 'Shoot', duration: 1.6, description: 'A two-paw aim, three crisp recoil beats, and a relaxed finish.', loop: false },
  { name: 'Dive', duration: 2.4, description: 'A crouched anticipation, sideways leap, and low horizontal landing.', loop: false },
  { name: 'Smoke', duration: 5, description: 'A quiet paw-to-mouth draw, a gentle exhale, and an easy reset.', loop: true },
];

export const ONE_SHOT_CLIPS = new Set(['Sit', 'Shoot', 'Dive']);
const NAMES = new Set(ACTIONS.map(action => action.name));
const TAU = Math.PI * 2;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const IDENTITY = new THREE.Quaternion();

function unit(value) { return THREE.MathUtils.clamp(value, 0, 1); }
function ease(value) { const t = unit(value); return t * t * (3 - 2 * t); }
function rise(time, start, end) { return ease((time - start) / (end - start)); }

/** Shared timing keeps each attached prop in phase with its skeletal action. */
export function sampleActionTiming(name, time, duration) {
  const length = duration ?? ACTIONS.find(action => action.name === name)?.duration ?? 1;
  const t = THREE.MathUtils.clamp(Number(time) || 0, 0, length);
  if (name === 'Shoot') {
    const aim = rise(t, 0, .26) * (1 - rise(t, 1.08, 1.6));
    let recoil = 0;
    for (const shot of [.42, .66, .90]) {
      const elapsed = t - shot;
      if (elapsed >= 0) recoil += rise(elapsed, 0, .035) * Math.exp(-elapsed * 18);
    }
    return { t, aim, recoil, visible: rise(t, 0, .12) * (1 - rise(t, 1.32, 1.52)) };
  }
  if (name === 'Smoke') {
    const lift = rise(t, .35, 1.05) * (1 - rise(t, 2.10, 2.95));
    return {
      t, lift,
      draw: rise(t, 1.05, 1.25) * (1 - rise(t, 1.95, 2.15)),
      exhale: rise(t, 2.10, 2.45) * (1 - rise(t, 3.05, 3.60)),
      phase: t / length * TAU,
    };
  }
  if (name === 'Dive') {
    const turn = rise(t, .36, 1.05);
    const anticipation = rise(t, 0, .34);
    const land = rise(t, 1.30, 1.60);
    const airPhase = unit((t - .36) / 1.04);
    const air = .20 * Math.sin(airPhase * Math.PI);
    const bounce = t > 1.40 ? .035 * Math.sin(unit((t - 1.40) / .32) * Math.PI) : 0;
    return { t, turn, anticipation, land, air, bounce };
  }
  return { t };
}

function paw(rig, helpers, side, point, pole = null) {
  helpers.solveTwoBone(rig, side < 0 ? 'hand_l' : 'hand_r', point,
    pole ?? new THREE.Vector3(side * .25, -1, .55));
}

function setBlink(bones, amount) {
  bones.Eye_L.scale.y = bones.Eye_R.scale.y = 1 - .94 * unit(amount);
}

function modelTransform(rig) {
  rig.root.updateMatrixWorld(true);
  return rig.root.parent?.matrixWorld.clone().invert() ?? new THREE.Matrix4();
}

/**
 * Conservative model-space envelope for a rolling dive. The oversized head
 * and ears use one box; capsules bound the limbs. Applying Root last keeps IK
 * authored in a consistent upright space and avoids chasing moving targets.
 */
function diveFloorOffset(rig, rotation) {
  const inverseModel = modelTransform(rig);
  const headMatrix = new THREE.Matrix4().multiplyMatrices(inverseModel, rig.bones.Head.matrixWorld);
  const point = new THREE.Vector3();
  let minimum = Infinity;
  // The Head pivot is at bind coordinate (0,3.22,0). The box includes eye
  // inlays, both ears, and a little allowance for baked secondary ear motion.
  for (const x of [-1.64, 1.64]) {
    for (const y of [3.08, 6.12]) {
      for (const z of [-1.15, 1.15]) {
        point.set(x, y - 3.22, z).applyMatrix4(headMatrix).applyQuaternion(rotation);
        minimum = Math.min(minimum, point.y);
      }
    }
  }
  const sphereNames = ['UpperArm_L', 'Forearm_L', 'Hand_L', 'UpperArm_R', 'Forearm_R', 'Hand_R', 'Thigh_L', 'Shin_L', 'Thigh_R', 'Shin_R', 'Tail_0', 'Tail_1', 'Tail_2', 'Tail_3', 'Tail_4'];
  for (const name of sphereNames) {
    rig.bones[name].getWorldPosition(point).applyMatrix4(inverseModel).applyQuaternion(rotation);
    minimum = Math.min(minimum, point.y - .185);
  }
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
  const footRadius = .13 * Math.abs(up.y) + .20 * Math.abs(up.x);
  for (const name of ['Foot_L', 'Foot_R']) {
    rig.bones[name].getWorldPosition(point).applyMatrix4(inverseModel).applyQuaternion(rotation);
    minimum = Math.min(minimum, point.y - footRadius);
  }
  return Math.max(0, .012 - minimum);
}

/** Author one action on a freshly reset rig, before shared secondary motion. */
export function sampleActionPose(rig, name, time, duration, helpers) {
  if (!NAMES.has(name)) return false;
  const b = rig.bones;
  const timing = sampleActionTiming(name, time, duration);
  const lerp = THREE.MathUtils.lerp;
  if (name === 'Shoot') {
    const { aim, recoil, t } = timing;
    b.Hips.position.y -= .10 * aim + .026 * recoil;
    helpers.rotate(b.Hips, -.012 * aim, -.015 * aim, 0);
    helpers.rotate(b.Spine, -.055 * recoil, .022 * aim, 0);
    helpers.rotate(b.Head, .015 * aim - .025 * recoil, -.015 * aim, 0);
    helpers.plantFeet(rig, lerp(.37, .43, aim), lerp(.07, .12, aim));
    // Keep the elbows beside/behind the torso. A forward pole nearly aligns
    // with the reaching hand midway through the aim and spins the elbow plane.
    paw(rig, helpers, 1, new THREE.Vector3(lerp(1.30, .39, aim), lerp(1.80, 2.52, aim) + .025 * recoil, lerp(.025, .90, aim) - .14 * recoil), new THREE.Vector3(.55, -1, -.55));
    paw(rig, helpers, -1, new THREE.Vector3(lerp(-1.30, -.27, aim), lerp(1.80, 2.47, aim) + .018 * recoil, lerp(.025, .90, aim) - .14 * recoil), new THREE.Vector3(-.70, -1, -.55));
    b.Mouth.scale.x = 1 + .05 * aim;
    setBlink(b, helpers.blinkAt(t, [.46, .70, .94], .10) * .25);
  } else if (name === 'Smoke') {
    const { lift, draw, exhale, phase, t } = timing;
    b.Hips.position.x += .025 * Math.sin(phase);
    b.Hips.position.y -= .09 - .008 * Math.sin(phase);
    helpers.rotate(b.Hips, .008 * Math.sin(phase), .015 * Math.sin(phase), -.008 * Math.sin(phase));
    helpers.rotate(b.Spine, -.018 * lift + .007 * Math.sin(phase), -.01 * lift, .008 * Math.sin(phase));
    helpers.rotate(b.Head, -.025 * lift - .018 * exhale, .018 * lift + .016 * Math.sin(phase), -.012 * lift);
    helpers.plantFeet(rig, .40, .09);
    const low = new THREE.Vector3(.73, 1.91, .32);
    const mouth = new THREE.Vector3(.25, 3.78, 1.18);
    // Stay outside the reaching axis while low, then route the forearm in
    // front of the oversized face as the paw arrives at the mouth.
    const elbowPole = new THREE.Vector3(.80, -1, -.40).lerp(new THREE.Vector3(.20, -1.05, .85), lift);
    paw(rig, helpers, 1, low.lerp(mouth, lift), elbowPole);
    // The free arm hangs beside the body, with its elbow folding backward.
    paw(rig, helpers, -1, new THREE.Vector3(-.79 + .012 * Math.sin(phase), 1.78, .12), new THREE.Vector3(-.30, -.40, -1));
    b.Mouth.scale.x = 1 - .10 * draw + .06 * exhale;
    b.Mouth.scale.y = 1 - .16 * draw + .15 * exhale;
    setBlink(b, Math.max(helpers.blinkAt(t, [3.48], .18), .14 * draw));
  } else {
    const { anticipation, turn, land, air, bounce, t } = timing;
    b.Hips.position.y -= .26 * anticipation * (1 - .60 * turn) + .12 * turn;
    helpers.rotate(b.Hips, .025 * anticipation, 0, 0);
    helpers.rotate(b.Spine, -.02 * anticipation, 0, 0);
    helpers.rotate(b.Head, -.015 * turn, 0, .03 * anticipation * (1 - turn));
    const tuck = turn * (1 - .20 * land);
    for (const side of [-1, 1]) {
      const foot = new THREE.Vector3(side * lerp(.37, .52, tuck), lerp(helpers.FOOT_HEIGHT, side < 0 ? .50 : .61, tuck), lerp(.07, .20, tuck));
      helpers.solveTwoBone(rig, side < 0 ? 'foot_l' : 'foot_r', foot, new THREE.Vector3(0, 0, 1), IDENTITY);
      const guarded = anticipation * (1 - turn);
      const hand = new THREE.Vector3(
        side * lerp(lerp(1.30, .96, guarded), .76, turn),
        lerp(lerp(1.80, 2.12, guarded), lerp(2.88, 2.70, land), turn),
        lerp(lerp(.025, .38, guarded), .82, turn),
      );
      // Keep the elbows behind the guarding paws through crouch and launch.
      paw(rig, helpers, side, hand, new THREE.Vector3(side * .55, -1, -.55));
    }
    b.Mouth.scale.x = 1 + .065 * anticipation;
    setBlink(b, helpers.blinkAt(t, [.46, 1.37], .14));
    const rotation = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -Math.PI / 2 * turn);
    const floor = diveFloorOffset(rig, rotation);
    // Rotate the already solved upright pose as a whole, then translate its
    // conservative envelope onto the floor. The final pose is intentionally
    // held horizontally, rather than looping back through a standing pose.
    b.Root.quaternion.copy(rotation);
    b.Root.position.x -= 2.65 * turn;
    b.Root.position.y += floor + air + bounce;
  }
  rig.root.updateMatrixWorld(true);
  return true;
}
