import * as THREE from 'three';

const TAU = Math.PI * 2;
const CLASSIC = new Set(['Floss', 'Orange Justice', 'Best Mates', 'Take the L', 'Electro Shuffle']);

function hand(rig, helpers, side, x, y, z, pole = null, wrist = null) {
  helpers.solveTwoBone(rig, side < 0 ? 'hand_l' : 'hand_r', new THREE.Vector3(x, y, z), pole ?? new THREE.Vector3(side * .75, -.50, z * .35 + .25), wrist);
}

function foot(rig, helpers, side, x, y, z, yaw = 0) {
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  helpers.solveTwoBone(rig, side < 0 ? 'foot_l' : 'foot_r', new THREE.Vector3(x, Math.max(helpers.FOOT_HEIGHT, y), z), new THREE.Vector3(0, 0, 1), rotation);
}

function body(rig, helpers, phase, { depth = .20, bob = .035, sway = .05, twist = .04, lean = .035 } = {}) {
  const b = rig.bones;
  b.Hips.position.x += sway * Math.sin(phase);
  b.Hips.position.y -= depth - bob * Math.cos(phase * 2);
  helpers.rotate(b.Hips, .025, twist * Math.sin(phase), lean * Math.sin(phase));
  helpers.rotate(b.Spine, .015 * Math.cos(phase * 2), -twist * .75 * Math.sin(phase), -lean * 1.35 * Math.sin(phase));
  helpers.rotate(b.Head, -.015 + .018 * Math.cos(phase * 2), -.035 * Math.sin(phase), .025 * Math.sin(phase + .4));
}

/** Five classic emote-inspired dance loops, authored for this character. */
export function sampleClassicDance(rig, name, time, duration, helpers) {
  if (!CLASSIC.has(name)) return false;
  const b = rig.bones;
  if (name === 'Floss') {
    const phase = TAU * time / .8;
    const swing = Math.sin(phase);
    body(rig, helpers, phase, { depth: .20, bob: .025, sway: -.13, twist: -.10, lean: .035 });
    helpers.plantFeet(rig, .50, .08);
    // Keep the front/back exchange, with a small belly-clearance arc only
    // while a paw crosses the front. Its maximum extra depth is .15 units.
    // Each elbow follows its own paw around the same side of the torso.
    for (const side of [-1, 1]) {
      const exchange = -side * swing;
      const front = Math.max(0, exchange);
      const z = .51 * exchange + .15 * helpers.smooth(front / .7);
      const pole = new THREE.Vector3(side * 1.25, -.50, z * 1.50);
      hand(rig, helpers, side, side * .72 + .48 * swing, 1.67 + .045 * Math.cos(phase * 2), z, pole);
    }
    helpers.rotate(b.Head, -.012, .08 * swing, -.025 * swing);
    b.Mouth.scale.x = 1.06;
  } else if (name === 'Orange Justice') {
    const phase = TAU * time;
    body(rig, helpers, phase, { depth: .27, bob: .065, sway: .105, twist: .10, lean: .085 });
    for (const side of [-1, 1]) {
      const shifted = phase + (side > 0 ? Math.PI : 0);
      const lift = .095 * Math.pow(Math.max(0, Math.sin(shifted)), 2);
      foot(rig, helpers, side, side * .48, helpers.FOOT_HEIGHT + lift, .12 + .055 * Math.cos(shifted));
      const circle = shifted + .35;
      hand(rig, helpers, side, side * (.96 + .30 * Math.cos(circle)), 2.14 + .37 * Math.sin(circle), .53 + .20 * Math.cos(circle - .6), new THREE.Vector3(side * .50, -1, -.65));
    }
    helpers.rotate(b.Head, .018 * Math.cos(phase * 2), -.075 * Math.sin(phase), -.06 * Math.sin(phase));
    b.Mouth.scale.x = 1.12;
  } else if (name === 'Best Mates') {
    const phase = TAU * time / .8;
    body(rig, helpers, phase, { depth: .21, bob: .055, sway: -.07, twist: .045, lean: .06 });
    for (const side of [-1, 1]) {
      const shifted = phase + (side > 0 ? Math.PI : 0);
      const knee = Math.pow(Math.max(0, Math.sin(shifted)), 1.6);
      foot(rig, helpers, side, side * (.38 + .035 * Math.cos(shifted)), helpers.FOOT_HEIGHT + .33 * knee, .07 + .31 * knee);
      hand(rig, helpers, side, side * 1.19, 2.12 + .13 * Math.sin(shifted), .31 + .16 * Math.cos(shifted), new THREE.Vector3(side * .50, -1, -.65));
    }
    helpers.rotate(b.Head, -.02 + .03 * Math.cos(phase * 2), .06 * Math.sin(phase), .035 * Math.sin(phase));
    b.Mouth.scale.x = 1.10;
    b.Mouth.scale.y = 1.06;
  } else if (name === 'Take the L') {
    const phase = TAU * time / .8;
    const sway = Math.sin(phase);
    body(rig, helpers, phase, { depth: .19, bob: .038, sway: .06, twist: .035, lean: .045 });
    for (const side of [-1, 1]) {
      const kick = Math.pow(Math.max(0, side < 0 ? sway : -sway), 2);
      foot(rig, helpers, side, side * (.43 + .22 * kick), helpers.FOOT_HEIGHT + .23 * kick, .10 + .10 * kick, side * .16 * kick);
    }
    // Noir has a paw rather than fingers and cannot reach over the giant head.
    // A cheek-side salute preserves the gesture while the kicks sell the beat.
    hand(rig, helpers, -1, -1.76, 3.24 + .035 * Math.cos(phase * 2), .16, new THREE.Vector3(-.25, -1, .1), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -.15));
    hand(rig, helpers, 1, .63, 1.81, .36, new THREE.Vector3(.8, -.60, .25));
    helpers.rotate(b.Head, -.015, .045 * sway, -.075);
    b.Mouth.scale.x = 1.08;
  } else if (name === 'Electro Shuffle') {
    const phase = TAU * time / 1.5;
    const crossing = Math.sin(phase);
    body(rig, helpers, phase, { depth: .28, bob: .045, sway: -.07, twist: .12, lean: .055 });
    for (const side of [-1, 1]) {
      const shifted = phase + (side > 0 ? Math.PI : 0);
      const lift = Math.pow(Math.max(0, Math.sin(shifted)), 1.6);
      const x = side * .38 + (side < 0 ? 1 : -1) * .44 * crossing;
      // Separate the crossing shin corridors: one foot passes in front while
      // the other stays behind, without changing the lateral crossover beat.
      const z = .11 + (side < 0 ? 1 : -1) * .45 * crossing;
      foot(rig, helpers, side, x, helpers.FOOT_HEIGHT + .14 * lift, z, side * .31 * Math.sin(phase + .55));
      hand(rig, helpers, side, side * 1.04 + .12 * Math.sin(phase * 2), 1.82 + .10 * Math.cos(phase * 2), .38 + side * .23 * Math.cos(phase), new THREE.Vector3(side * .50, -1, -.65));
    }
    helpers.rotate(b.Head, -.025 + .025 * Math.cos(phase * 2), -.065 * crossing, .03 * crossing);
    b.Mouth.scale.x = 1.07;
  }
  const blink = helpers.blinkAt(time, [duration * .39], .14);
  b.Eye_L.scale.y = b.Eye_R.scale.y = 1 - blink * .94;
  return true;
}
