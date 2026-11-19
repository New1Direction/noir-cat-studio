import * as THREE from 'three';

const TAU = Math.PI * 2;
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const lift = value => Math.max(0, value) ** 2;

// Chest gestures need space beside the torso, while low pumps bend behind it.
// Raised, wide pointing gestures keep a forward/downward, head-safe corridor.
// Blending by the actual reach preserves the dance phrases and their endpoints
// instead of imposing the same backwards elbow on every kind of gesture.
const ARM_CORRIDORS = {
  Fresh: { chest: [.90, -1.0, -.35], low: [.80, -.40, -.65] },
  'Dance Moves': { chest: [1.10, -1.0, -.35], low: [.80, -.40, -.65] },
  Hype: { chest: [.85, -.90, -.30], low: [.75, -.45, -.65] },
  'Groove Jam': { chest: [1.05, -1.0, -.35], low: [.80, -.40, -.65] },
};

function elbowPole(name, side, target) {
  // The crossing dab passes under a bowed chin: a broad outward/down/front
  // bend keeps the paw cap outside the jaw while the elbow stays beside the ribs.
  if (name === 'Dab') return v(side * 3.0, -4.0, 1.5);
  const corridor = ARM_CORRIDORS[name];
  const low = 1 - THREE.MathUtils.smoothstep(target.y, 1.95, 2.50);
  const raised = THREE.MathUtils.smoothstep(target.y, 2.65, 3.10)
    * THREE.MathUtils.smoothstep(Math.abs(target.x), .80, 1.45);
  const pole = v(side * corridor.chest[0], corridor.chest[1], corridor.chest[2])
    .lerp(v(side * corridor.low[0], corridor.low[1], corridor.low[2]), low)
    .lerp(v(side * .65, -1.10, .25), raised);
  return pole;
}

// Each list is a closed set of gesture poses. Periodic Catmull–Rom interpolation
// keeps the dancer moving through a phrase without sudden pose-to-pose stops.
const DEFAULT_HANDS = [
  [[-1.12, 1.95, .30], [1.12, 1.95, .30]],
  [[-.18, 2.58, .88], [.18, 2.58, .88]],
  [[-.08, 2.48, .90], [1.15, 2.66, .58]],
  [[-1.15, 2.66, .58], [.08, 2.48, .90]],
  [[-1.37, 2.77, .35], [1.37, 2.77, .35]],
  [[-.66, 2.18, .78], [.66, 2.18, .78]],
  [[-.19, 2.66, .89], [.19, 2.66, .89]],
  [[-1.10, 2.05, .36], [1.10, 2.05, .36]],
];
const GROOVE_HANDS = [
  [[-1.24, 2.12, .38], [.56, 2.65, .86]],
  [[-.48, 2.67, .87], [1.47, 2.95, .32]],
  [[-.64, 2.53, .90], [.64, 2.53, .90]],
  [[-1.47, 2.95, .32], [.48, 2.67, .87]],
  [[-.75, 2.25, .84], [.75, 2.25, .84]],
  [[-1.43, 2.65, .48], [1.43, 2.65, .48]],
  [[-.34, 2.77, .90], [.34, 2.77, .90]],
  [[-1.08, 1.96, .30], [1.08, 1.96, .30]],
];

/** Sample five looping party dances into the shared Noir rig, without state. */
export function samplePartyDance(rig, name, time, duration, helpers) {
  if (!['Fresh', 'Dance Moves', 'Dab', 'Hype', 'Groove Jam'].includes(name)) return false;
  const { bones: b } = rig;
  const { rotate, solveTwoBone, plantFeet, FOOT_HEIGHT } = helpers;
  const phase = time / duration * TAU;

  function hands(left, right, wristRoll = 0) {
    for (const [side, target] of [[-1, left], [1, right]]) {
      const wrist = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, side * wristRoll));
      solveTwoBone(rig, side < 0 ? 'hand_l' : 'hand_r', target,
        elbowPole(name, side, target), wrist);
    }
  }
  function feet(left, right) {
    solveTwoBone(rig, 'foot_l', left, v(-.12, 0, 1));
    solveTwoBone(rig, 'foot_r', right, v(.12, 0, 1));
  }

  if (name === 'Fresh') {
    // A loose side-to-side pendulum, bent elbows travelling together across
    // the chest, with alternating heel lifts and a counter-rotating head.
    const swing = Math.sin(phase * 2);
    const counter = Math.cos(phase * 2);
    b.Hips.position.x += .12 * swing;
    b.Hips.position.y -= .145 + .035 * (1 - counter * counter);
    rotate(b.Hips, .02, .20 * swing, -.045 * swing);
    rotate(b.Spine, -.025, -.16 * swing, .08 * swing);
    rotate(b.Head, -.025, -.10 * swing, -.06 * swing);
    feet(v(-.41 + .07 * swing, FOOT_HEIGHT + .085 * lift(swing), .07 + .12 * counter),
      v(.41 + .07 * swing, FOOT_HEIGHT + .085 * lift(-swing), .07 - .12 * counter));
    hands(v(-.78 + .47 * swing, 2.39 + .09 * counter, .78),
      v(.78 + .47 * swing, 2.39 - .09 * counter, .78), .12 * swing);
    b.Mouth.scale.x = 1.10;
  } else if (name === 'Dance Moves') {
    // An eight-count phrase: open, clap, sweep right/left, open wide, tuck,
    // clap, release. The steps keep time while the upper-body phrase changes.
    const step = Math.sin(phase * 4);
    b.Hips.position.x += .10 * step;
    b.Hips.position.y -= .145 + .025 * Math.cos(phase * 8);
    rotate(b.Hips, .025, .10 * Math.sin(phase * 2), -.035 * step);
    rotate(b.Spine, -.025, .14 * Math.sin(phase * 2 + .3), .055 * step);
    rotate(b.Head, .025 * Math.cos(phase * 4), -.055 * Math.sin(phase * 2), -.035 * step);
    feet(v(-.40 + .06 * step, FOOT_HEIGHT + .08 * lift(step), .07 + .14 * step),
      v(.40 + .06 * step, FOOT_HEIGHT + .08 * lift(-step), .07 - .14 * step));
    hands(gesture(DEFAULT_HANDS, phase, 0), gesture(DEFAULT_HANDS, phase, 1));
    b.Mouth.scale.x = 1.08;
    b.Mouth.scale.y = 1.05;
  } else if (name === 'Dab') {
    // Mirrored dabs have readable held accents: one paw points outside the
    // cheek while the other folds across the chest. The giant head bows in.
    const accent = Math.tanh(2.8 * Math.sin(phase));
    const blend = (accent + 1) / 2;
    b.Hips.position.y -= .165 + .025 * (1 - accent * accent);
    b.Hips.position.x += .06 * accent;
    rotate(b.Hips, .035, .08 * accent, -.025 * accent);
    rotate(b.Spine, .045, -.08 * accent, .10 * accent);
    rotate(b.Head, .17, -.18 * accent, .15 * accent);
    plantFeet(rig, .46, .08);
    const left = v(-1.79, 3.13, .14).lerp(v(.37, 2.59, .91), blend);
    const right = v(-.37, 2.59, .91).lerp(v(1.79, 3.13, .14), blend);
    hands(left, right, .08 * accent);
    b.Eye_L.scale.y = b.Eye_R.scale.y = 1 - .24 * accent * accent;
    b.Mouth.scale.x = 1.12;
  } else if (name === 'Hype') {
    // Alternating high-knee hops and strong opposing arm pumps give this a
    // running-man silhouette instead of the lateral motion of the other dances.
    const stepPhase = phase * 2;
    const step = Math.sin(stepPhase);
    const bounce = .045 * (1 - Math.cos(stepPhase * 2));
    b.Hips.position.x += .075 * step;
    b.Hips.position.y -= .19 - bounce;
    rotate(b.Hips, .085, .08 * step, -.045 * step);
    rotate(b.Spine, .035, -.10 * step, .065 * step);
    rotate(b.Head, -.095, -.045 * step, -.025 * step);
    feet(v(-.40 + .035 * Math.cos(stepPhase), FOOT_HEIGHT + .27 * lift(step), .07 + .25 * lift(step)),
      v(.40 + .035 * Math.cos(stepPhase), FOOT_HEIGHT + .27 * lift(-step), .07 + .25 * lift(-step)));
    hands(v(-1.03 - .12 * Math.cos(stepPhase), 2.13 - .40 * step, .48 - .27 * step),
      v(1.03 + .12 * Math.cos(stepPhase), 2.13 + .40 * step, .48 + .27 * step));
    b.Mouth.scale.x = 1.14;
    b.Mouth.scale.y = 1.10;
  } else if (name === 'Groove Jam') {
    // Disco-like pointing phrases pass through rolling forearms; the feet
    // cross toward the center in turn while the pelvis traces a broad groove.
    const step = Math.sin(phase * 4);
    b.Hips.position.x += .13 * step;
    b.Hips.position.y -= .17 - .03 * Math.cos(phase * 8);
    rotate(b.Hips, .025, .22 * Math.sin(phase * 2), -.055 * step);
    rotate(b.Spine, -.025, -.16 * Math.sin(phase * 2), .075 * step);
    rotate(b.Head, -.02, .06 * Math.cos(phase * 2), -.06 * step);
    feet(v(-.40 + .22 * lift(step), FOOT_HEIGHT + .13 * lift(step), .07 + .25 * step),
      v(.40 - .22 * lift(-step), FOOT_HEIGHT + .13 * lift(-step), .07 - .25 * step));
    const left = gesture(GROOVE_HANDS, phase, 0);
    const right = gesture(GROOVE_HANDS, phase, 1);
    const roll = phase * 4;
    left.add(v(.075 * Math.cos(roll), .075 * Math.sin(roll), .035 * Math.cos(roll)));
    right.add(v(-.075 * Math.cos(roll), -.075 * Math.sin(roll), -.035 * Math.cos(roll)));
    hands(left, right, .12 * Math.sin(roll));
    b.Mouth.scale.x = 1.10;
  }
  rig.root.updateMatrixWorld(true);
  return true;
}

function gesture(keys, phase, hand) {
  const count = keys.length;
  const position = ((phase / TAU * count) % count + count) % count;
  const index = Math.floor(position);
  const t = position - index;
  const p0 = keys[(index - 1 + count) % count][hand];
  const p1 = keys[index][hand];
  const p2 = keys[(index + 1) % count][hand];
  const p3 = keys[(index + 2) % count][hand];
  const result = new THREE.Vector3();
  for (let axis = 0; axis < 3; axis++) {
    const a = 2 * p1[axis];
    const b = -p0[axis] + p2[axis];
    const c = 2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis];
    const d = -p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis];
    result.setComponent(axis, .5 * (a + b * t + c * t * t + d * t * t * t));
  }
  return result;
}
