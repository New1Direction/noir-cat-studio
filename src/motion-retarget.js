import * as THREE from 'three';
import { solveLimbIK } from './limb-ik.js';

const UP = new THREE.Vector3(0, 1, 0);
const PROP_NAMES = ['NoirBlaster', 'NoirSmokeProp'];
const SIDES = { L: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 }, R: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 } };
const clamp = THREE.MathUtils.clamp;
const smooth = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const mean = (a, b) => a.clone().add(b).multiplyScalar(.5);
const median = values => quantile(values, .5);
function quantile(values, fraction) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0; }

/**
 * Retarget MediaPipe Pose Landmarker output to Noir's fixed 26-bone skeleton.
 * Input stays local: no model, video, or landmark data is sent to a server.
 * This produces an ordinary, one-shot AnimationClip with portable bone tracks.
 */
export function retargetMotion(rig, capture, options = {}) {
  if (!rig?.skeleton || rig.skeleton.bones.length !== 26) throw new Error('Create Noir’s rig before importing motion.');
  const settings = { mirror: false, smoothing: .65, footLock: true, intensity: 1, inPlace: true, loop: false, ...options };
  settings.smoothing = clamp(Number(settings.smoothing) || 0, 0, .95);
  settings.intensity = clamp(Number.isFinite(Number(settings.intensity)) ? Number(settings.intensity) : 1, 0, 1.5);
  const prepared = prepareCapture(capture, settings);
  const { samples, calibration: cal, duration, warnings, stats } = prepared;
  const actor = samplingRig(rig);
  const groups = skinGroups(rig);
  const tracks = Object.fromEntries(actor.list.map(bone => [bone.name, { position: [], quaternion: [], scale: [] }]));
  const count = samples.length;
  const times = Float32Array.from(samples, frame => frame.time);
  const anchors = { L: null, R: null };
  let armAdaptations = 0;
  let floorCorrections = 0;
  let reachAdjustments = 0;
  let limitedFrames = 0;
  let previousHip = null;
  let rootTravel = 0;

  for (let frame = 0; frame < count; frame++) {
    const sample = samples[frame];
    resetActor(actor);
    const b = actor.bones;
    const mapped = sample.points.map(point => cal.project(point));
    const hip = mean(mapped[23], mapped[24]);
    const shoulders = mean(mapped[11], mapped[12]);
    const torso = shoulders.clone().sub(hip).normalize();
    const right = mapped[12].clone().sub(mapped[11]).normalize();
    const forward = new THREE.Vector3().crossVectors(right, torso).multiplyScalar(cal.forwardSign).normalize();
    const mirrorSign = settings.mirror ? -1 : 1;
    const yaw = clamp((Math.atan2(forward.x, forward.z) - cal.yaw) * settings.intensity, -.65, .65) * mirrorSign;
    const lean = clamp(Math.atan2(torso.z, torso.y) * settings.intensity, -.30, .32);
    const roll = -clamp(Math.atan2(torso.x, torso.y) * settings.intensity, -.22, .22) * mirrorSign;
    rotate(b.Hips, lean * .35, yaw * .3, roll * .35);
    rotate(b.Spine, lean * .65, yaw * .7, roll * .65);

    const sourceFloor = Math.min(...[29, 30, 31, 32].map(id => mapped[id].y));
    const hipHeight = hip.y - sourceFloor;
    const requestedHipY = 1.53 + (hipHeight - cal.hipHeight) * cal.scale * settings.intensity;
    const hipY = clamp(requestedHipY, .82, 1.60);
    if (Math.abs(hipY - requestedHipY) > .01) limitedFrames++;
    const imageFloor = Math.max(...[29, 30, 31, 32].map(id => sample.image[id].y));
    const jump = clamp((cal.imageFloor - imageFloor) * cal.imageScale * settings.intensity, 0, .40);
    b.Hips.position.y = hipY + jump;
    const imageHip = mean(sample.image[23], sample.image[24]);
    const imageShift = (imageHip.x - cal.imageHip.x) * cal.imageScale * mirrorSign * settings.intensity;
    b.Hips.position.x += settings.inPlace ? clamp(imageShift * .3, -.16, .16) : 0;
    if (!settings.inPlace) {
      b.Root.position.x = clamp(imageShift, -2.5, 2.5);
      const torsoImage = mean(sample.image[11], sample.image[12]).distanceTo(imageHip);
      b.Root.position.z = clamp((1 - cal.imageTorso / Math.max(.04, torsoImage)) * 2.5, -2, 2);
      rootTravel = Math.max(rootTravel, Math.hypot(b.Root.position.x, b.Root.position.z));
    }
    const nose = mapped[0].clone().sub(mean(mapped[7], mapped[8]));
    const faceYaw = clamp(Math.atan2(nose.x, Math.max(.025, nose.z)) - cal.faceYaw - yaw / mirrorSign, -.40, .40) * mirrorSign;
    const facePitch = clamp(Math.atan2(nose.y, Math.max(.025, Math.abs(nose.z))) - cal.facePitch, -.18, .18);
    rotate(b.Head, -facePitch * .6 * settings.intensity - lean * .35, faceYaw * .65 * settings.intensity, roll * -.25);
    actor.root.updateMatrixWorld(true);

    const footTargets = {};
    const kneePoles = {};
    for (const [side, sign] of [['L', -1], ['R', 1]]) {
      const sourceSide = settings.mirror ? (side === 'L' ? 'R' : 'L') : side;
      const ids = SIDES[sourceSide];
      const ankle = mapped[ids.ankle];
      const relative = ankle.clone().sub(hip);
      const baseline = cal.ankles[sourceSide];
      const x = sign * .37 + (relative.x - baseline.x) * cal.scale * settings.intensity * mirrorSign;
      const z = .07 + (relative.z - baseline.z) * cal.scale * settings.intensity;
      const sole = Math.min(mapped[ids.heel].y, mapped[ids.toe].y);
      const lift = clamp((sole - sourceFloor) * cal.scale * settings.intensity, 0, .60);
      const target = new THREE.Vector3(clamp(x, side === 'L' ? -.85 : -.18, side === 'L' ? .18 : .85), .145 + lift + jump, clamp(z, -.65, .9));
      const contact = lift < .035 && jump < .025;
      if (settings.footLock && contact && !sample.closing) {
        if (!anchors[side]) anchors[side] = target.clone();
        else anchors[side].lerp(target, .06);
        target.x = anchors[side].x;
        target.z = anchors[side].z;
      } else anchors[side] = null;
      target.add(b.Root.position);
      footTargets[side] = target;
      kneePoles[side] = new THREE.Vector3(Math.sin(yaw) + sign * .08, 0, Math.cos(yaw));
      solveIK(actor, `Thigh_${side}`, `Shin_${side}`, `Foot_${side}`, target, kneePoles[side], true);
    }
    // A human's grounded stride can exceed the short toy legs' reach. Lower
    // the pelvis before solving again, rather than stretching a bone or
    // allowing a supposedly planted sole to float above its contact point.
    let reachDrop = 0;
    for (const side of ['L', 'R']) {
      const target = footTargets[side];
      if (target.y - b.Root.position.y > .195) continue;
      const thigh = b[`Thigh_${side}`].getWorldPosition(new THREE.Vector3());
      const length = actor.rest[`Shin_${side}`].position.length() + actor.rest[`Foot_${side}`].position.length() - .004;
      const horizontalSquared = (target.x - thigh.x) ** 2 + (target.z - thigh.z) ** 2;
      const vertical = Math.sqrt(Math.max(.01, length * length - horizontalSquared));
      reachDrop = Math.max(reachDrop, thigh.y - target.y - vertical);
    }
    if (reachDrop > .001) {
      b.Hips.position.y = Math.max(.82 + jump, b.Hips.position.y - reachDrop);
      actor.root.updateMatrixWorld(true);
      for (const side of ['L', 'R']) solveIK(actor, `Thigh_${side}`, `Shin_${side}`, `Foot_${side}`, footTargets[side], kneePoles[side], true);
      reachAdjustments++;
    }
    for (let pass = 0; pass < 3; pass++) {
      updateSkin(actor);
      let changed = false;
      for (const side of ['L', 'R']) {
        const minimum = minimumSkinY(groups.legs[side], actor);
        if (minimum < .002) {
          footTargets[side].y += .004 - minimum;
          solveIK(actor, `Thigh_${side}`, `Shin_${side}`, `Foot_${side}`, footTargets[side], kneePoles[side], true);
          floorCorrections++; changed = true;
        }
      }
      if (!changed) break;
    }

    for (const [side, sign] of [['L', -1], ['R', 1]]) {
      const sourceSide = settings.mirror ? (side === 'L' ? 'R' : 'L') : side;
      const ids = SIDES[sourceSide];
      const upper = mapped[ids.elbow].clone().sub(mapped[ids.shoulder]).normalize();
      const lower = mapped[ids.wrist].clone().sub(mapped[ids.elbow]).normalize();
      upper.x *= mirrorSign; lower.x *= mirrorSign;
      const neutralUpper = new THREE.Vector3(sign * .36, -.95, .04).normalize();
      const neutralLower = new THREE.Vector3(sign * .18, -.98, .10).normalize();
      upper.copy(neutralUpper.lerp(upper, clamp(settings.intensity, 0, 1))).normalize();
      lower.copy(neutralLower.lerp(lower, clamp(settings.intensity, 0, 1))).normalize();
      const shoulder = b[`UpperArm_${side}`].getWorldPosition(new THREE.Vector3());
      const target = shoulder.clone().addScaledVector(upper, actor.rest[`Forearm_${side}`].position.length()).addScaledVector(lower, actor.rest[`Hand_${side}`].position.length());
      target.y = Math.max(.22, target.y);
      if (Math.abs(target.x - b.Root.position.x) < .72 && target.z - b.Root.position.z < .42 && target.y < shoulder.y - .25) target.x = b.Root.position.x + sign * .72;
      const raised = upper.y > .15 || target.y > shoulder.y + .15;
      const pole = upper.clone();
      if (pole.clone().cross(target.clone().sub(shoulder)).lengthSq() < .01) pole.set(sign * .25, -.4, -.8);
      solveIK(actor, `UpperArm_${side}`, `Forearm_${side}`, `Hand_${side}`, target, pole, false);
      for (let pass = 0; pass < 5; pass++) {
        updateSkin(actor);
        if (!armEntersHead(groups.arms[side], actor)) break;
        armAdaptations++;
        const headFrame = actor.skinMatrices[actor.indices.Head];
        // Short paws cannot reach over the giant head. Keep the raised gesture
        // visible beside its cheek, with its elbow routed below the jaw.
        const safe = new THREE.Vector3(sign * (1.78 + .035 * pass), raised ? 3.27 + .30 * clamp(Math.max(upper.y, lower.y), 0, 1) - .10 * pass : 2.70 - .08 * pass, .20 + .07 * pass).applyMatrix4(headFrame);
        solveIK(actor, `UpperArm_${side}`, `Forearm_${side}`, `Hand_${side}`, safe, new THREE.Vector3(sign * .25, -1.1, .25), false);
        if (pass === 3) b.Head.quaternion.identity();
      }
    }
    // A final conservative check handles a head correction made while solving
    // the second arm; it must not leave the first arm inside the new head pose.
    updateSkin(actor);
    if (['L', 'R'].some(side => armEntersHead(groups.arms[side], actor))) {
      b.Head.quaternion.identity();
      for (const [side, sign] of [['L', -1], ['R', 1]]) {
        updateSkin(actor);
        if (!armEntersHead(groups.arms[side], actor)) continue;
        const shoulder = b[`UpperArm_${side}`].getWorldPosition(new THREE.Vector3());
        solveIK(actor, `UpperArm_${side}`, `Forearm_${side}`, `Hand_${side}`,
          shoulder.add(new THREE.Vector3(sign * .65, -1.15, .20)), new THREE.Vector3(sign * .25, -1.1, .25), false);
        armAdaptations++;
      }
    }
    // Secondary motion follows the recorded rhythm, rather than replacing it.
    const speed = previousHip ? Math.min(1, hip.distanceTo(previousHip) * 30 * 3) * (1 - (sample.closing ?? 0)) : 0;
    previousHip = hip;
    const phase = settings.loop ? sample.time / duration * Math.PI * 2 : sample.time * 4;
    const slower = settings.loop ? phase : sample.time * 3;
    for (let i = 0; i < 5; i++) rotate(b[`Tail_${i}`], 0, (.035 + .055 * speed) * Math.sin(phase - i * .4), .012 * Math.cos(slower - i * .3));
    rotate(b.Ear_L, .015 * Math.sin(slower), 0, -.02 * speed);
    rotate(b.Ear_R, -.015 * Math.sin(slower + .4), 0, .02 * speed);
    const blinkPhase = settings.loop ? sample.time - duration * .55 : ((sample.time - 1.25) % 3 + 3) % 3;
    const blinkWidth = settings.loop ? Math.min(.15, duration * .20) : .15;
    const blink = blinkPhase >= 0 && blinkPhase < blinkWidth ? Math.sin(blinkPhase / blinkWidth * Math.PI) ** 2 : 0;
    b.Eye_L.scale.y = b.Eye_R.scale.y = 1 - .94 * blink;
    actor.root.updateMatrixWorld(true);
    for (const bone of actor.list) {
      const entry = tracks[bone.name];
      const quaternion = bone.quaternion.clone().normalize();
      if (frame && quaternion.dot(new THREE.Quaternion().fromArray(entry.quaternion, (frame - 1) * 4)) < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
      bone.position.toArray(entry.position, frame * 3);
      quaternion.toArray(entry.quaternion, frame * 4);
      bone.scale.toArray(entry.scale, frame * 3);
    }
  }

  const animationTracks = [];
  for (const bone of actor.list) {
    animationTracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, tracks[bone.name].position));
    animationTracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, tracks[bone.name].quaternion));
    animationTracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.scale`, times, tracks[bone.name].scale));
  }
  for (const name of PROP_NAMES) {
    animationTracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, [0, duration], [0, 0, 0, 0, 0, 0]));
    animationTracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, duration], [0, 0, 0, 1, 0, 0, 0, 1]));
  }
  if (armAdaptations) warnings.push('Raised or hidden paws were adapted around Noir’s larger head.');
  if (limitedFrames > count * .1) warnings.push('Deep crouches were limited to fit Noir’s proportions.');
  return {
    clip: new THREE.AnimationClip('Your motion', duration, animationTracks),
    stats: { ...stats, duration, sampleRate: 30, outputFrames: count, armAdaptations, floorCorrections, reachAdjustments, rootTravel, mirrored: Boolean(settings.mirror), loop: Boolean(settings.loop) },
    warnings: [...new Set(warnings)],
  };
}

function prepareCapture(capture, options) {
  if (!capture || !Array.isArray(capture.frames) || capture.frames.length < 2) throw new Error('This video did not contain enough pose frames. Try a longer, full-body clip.');
  if (capture.duration != null && (!Number.isFinite(capture.duration) || capture.duration <= 0)) throw new Error('The video duration must be a finite number of seconds.');
  const rate = clamp(Number(capture.sampleRate) || 15, 1, 60);
  const inferredDuration = (capture.frames.length - 1) / rate;
  const duration = Math.min(20, Number(capture.duration) || inferredDuration);
  if (!Number.isFinite(duration) || duration < .15) throw new Error('Choose at least a short moment of visible full-body movement.');
  const warnings = [];
  if (Number(capture.duration) > 20) warnings.push('Only the first 20 seconds were imported.');
  let previousTime = -Infinity;
  const attempted = [];
  for (let index = 0; index < capture.frames.length; index++) {
    const frame = capture.frames[index];
    const time = frame?.time ?? index / rate;
    if (!Number.isFinite(time) || time < 0 || time < previousTime) throw new Error('Pose frames must have finite timestamps in time order.');
    previousTime = time;
    if (time > duration + .001) break;
    if (!frame || !frame.landmarks || !frame.worldLandmarks) { attempted.push({ time, valid: false }); continue; }
    for (const key of ['landmarks', 'worldLandmarks']) {
      if (!Array.isArray(frame[key]) || frame[key].length !== 33) throw new Error('Expected 33 MediaPipe pose landmarks per frame. Please analyze the video again.');
    }
    const finite = frame.worldLandmarks.every(point => point && [point.x, point.y, point.z].every(Number.isFinite))
      && frame.landmarks.every(point => point && [point.x, point.y, point.z].every(Number.isFinite));
    const confidence = Number.isFinite(frame.confidence) ? clamp(frame.confidence, 0, 1) : 1;
    const visibility = frame.landmarks.map((point, id) => clamp(point?.visibility ?? frame.worldLandmarks[id]?.visibility ?? 1, 0, 1));
    const torsoConfidence = [11, 12, 23, 24].reduce((sum, id) => sum + visibility[id], 0) / 4;
    attempted.push({ time, valid: finite && confidence >= .30 && torsoConfidence >= .35, confidence, visibility, frame });
  }
  const usable = attempted.filter(frame => frame.valid);
  const coverage = usable.length / Math.max(1, attempted.length);
  if (usable.length < 2 || coverage < .25) throw new Error('Too little of your body could be tracked. Try a well-lit video with your whole body visible.');
  const convert = point => new THREE.Vector3(point.x, -point.y, -point.z);
  for (const item of usable) {
    item.points = item.frame.worldLandmarks.map(convert);
    item.image = item.frame.landmarks.map(point => new THREE.Vector3(point.x, point.y, point.z));
  }
  let longestGap = Math.max(usable[0].time, duration - usable.at(-1).time);
  for (let i = 1; i < usable.length; i++) longestGap = Math.max(longestGap, usable[i].time - usable[i - 1].time);
  if (longestGap > .75) warnings.push('Some movement was hidden for a while; those sections hold the nearest reliable pose.');
  const outputCount = Math.ceil(duration * 30) + 1;
  const samples = [];
  let cursor = 0;
  for (let i = 0; i < outputCount; i++) {
    const time = i / (outputCount - 1) * duration;
    while (cursor < usable.length - 2 && usable[cursor + 1].time < time) cursor++;
    const a = usable[cursor], b = usable[Math.min(cursor + 1, usable.length - 1)];
    let t = clamp((time - a.time) / Math.max(.0001, b.time - a.time), 0, 1);
    if (b.time - a.time > .75) t = time < b.time - .15 ? 0 : smooth((time - b.time + .15) / .15);
    samples.push({ time, confidence: THREE.MathUtils.lerp(a.confidence, b.confidence, t),
      points: a.points.map((point, id) => point.clone().lerp(b.points[id], t)),
      image: a.image.map((point, id) => point.clone().lerp(b.image[id], t)),
      visibility: a.visibility.map((value, id) => THREE.MathUtils.lerp(value, b.visibility[id], t)),
    });
  }
  // Bidirectional filtering reduces jitter without delaying the recorded beat.
  for (const direction of [1, -1]) {
    for (let k = 1; k < samples.length; k++) {
      const i = direction > 0 ? k : samples.length - 1 - k;
      const previous = samples[i - direction];
      for (let id = 0; id < 33; id++) {
        const trust = clamp(samples[i].visibility[id] * samples[i].confidence, .10, 1);
        const alpha = (1 - options.smoothing * .85) * trust;
        samples[i].points[id].lerp(previous.points[id], 1 - alpha);
        samples[i].image[id].lerp(previous.image[id], 1 - alpha);
      }
    }
  }
  if (options.loop) {
    // Blend the recorded source, then solve IK and all skin-clearance checks
    // normally. Closing bone tracks afterwards would bypass those safeguards.
    const firstPoints = samples[0].points.map(point => point.clone());
    const firstImage = samples[0].image.map(point => point.clone());
    const closingTime = Math.min(.25, duration * .3);
    const openingTime = Math.min(.15, duration * .15);
    for (const sample of samples) {
      const closing = smooth((sample.time - duration + closingTime) / closingTime);
      const opening = 1 - smooth(sample.time / openingTime);
      const amount = Math.max(closing, opening);
      sample.closing = closing;
      for (let id = 0; id < 33; id++) {
        sample.points[id].lerp(firstPoints[id], amount);
        sample.image[id].lerp(firstImage[id], amount);
      }
    }
  }
  const calibration = calibrate(samples);
  return { samples, calibration, duration, warnings, stats: { sourceFrames: attempted.length, validFrames: usable.length, missingFrames: attempted.length - usable.length, coverage, confidence: usable.reduce((sum, item) => sum + item.confidence, 0) / usable.length, longestGap } };
}

function calibrate(samples) {
  const initial = samples.slice(0, Math.min(samples.length, 16));
  const right = new THREE.Vector3();
  for (const sample of initial) right.add(sample.points[12].clone().sub(sample.points[11]));
  right.y = 0;
  if (right.length() < .03) throw new Error('The shoulders were hard to distinguish. Try a clearer front-facing full-body video.');
  right.normalize();
  const forward = new THREE.Vector3().crossVectors(right, UP).normalize();
  if (forward.z < 0) forward.negate();
  const project = point => new THREE.Vector3(point.dot(right), point.y, point.dot(forward));
  const all = samples.map(sample => sample.points.map(project));
  const legLengths = [];
  const hipHeights = [];
  for (const points of all) {
    legLengths.push((points[23].distanceTo(points[25]) + points[25].distanceTo(points[27]) + points[24].distanceTo(points[26]) + points[26].distanceTo(points[28])) / 2);
    hipHeights.push(mean(points[23], points[24]).y - Math.min(...[29, 30, 31, 32].map(id => points[id].y)));
  }
  const length = median(legLengths);
  if (length < .15 || length > 3) throw new Error('The full-body pose scale could not be estimated. Keep your legs and feet visible.');
  const base = all.slice(0, initial.length);
  const ankles = {};
  for (const [side, id] of [['L', 27], ['R', 28]]) {
    ankles[side] = new THREE.Vector3(...[0, 1, 2].map(axis => median(base.map(points => points[id].getComponent(axis) - mean(points[23], points[24]).getComponent(axis)))));
  }
  const imageHip = mean(initial[0].image[23], initial[0].image[24]);
  const imageLeg = median(initial.map(sample => Math.abs(mean(sample.image[27], sample.image[28]).y - mean(sample.image[23], sample.image[24]).y)));
  const p = all[0];
  const torso = mean(p[11], p[12]).sub(mean(p[23], p[24])).normalize();
  const axis = p[12].clone().sub(p[11]).normalize();
  const f = new THREE.Vector3().crossVectors(axis, torso);
  const forwardSign = f.z >= 0 ? 1 : -1;
  f.multiplyScalar(forwardSign);
  const face = p[0].clone().sub(mean(p[7], p[8]));
  return { project, forwardSign, yaw: Math.atan2(f.x, f.z), faceYaw: Math.atan2(face.x, Math.max(.025, face.z)), facePitch: Math.atan2(face.y, Math.max(.025, Math.abs(face.z))), ankles,
    scale: 1.405 / length, hipHeight: quantile(hipHeights, .85), imageHip, imageScale: 1.40 / Math.max(.15, imageLeg),
    imageFloor: quantile(samples.map(sample => Math.max(...[29, 30, 31, 32].map(id => sample.image[id].y))), .85),
    imageTorso: mean(initial[0].image[11], initial[0].image[12]).distanceTo(imageHip),
  };
}

function samplingRig(source) {
  const bones = {}, rest = {}, indices = {};
  source.skeleton.bones.forEach((original, index) => {
    const bone = new THREE.Bone(); bone.name = original.name;
    const pose = source.rest[bone.name];
    bone.position.copy(pose.position); bone.quaternion.copy(pose.quaternion); bone.scale.copy(pose.scale);
    if (original.parent?.isBone) bones[original.parent.name].add(bone);
    bones[bone.name] = bone; indices[bone.name] = index;
    rest[bone.name] = { position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() };
  });
  const root = bones.Root; root.updateMatrixWorld(true);
  const list = source.skeleton.bones.map(bone => bones[bone.name]);
  const inverseBind = list.map(bone => bone.matrixWorld.clone().invert());
  return { bones, rest, indices, root, list, inverseBind, skinMatrices: list.map(() => new THREE.Matrix4()) };
}
function resetActor(actor) { for (const bone of actor.list) { bone.position.copy(actor.rest[bone.name].position); bone.quaternion.copy(actor.rest[bone.name].quaternion); bone.scale.copy(actor.rest[bone.name].scale); } }
function rotate(bone, x = 0, y = 0, z = 0) { bone.quaternion.setFromEuler(new THREE.Euler(x, y, z)).normalize(); }

function solveIK(actor, upperName, middleName, endName, requested, pole, levelFoot) {
  return solveLimbIK(actor, [upperName, middleName, endName], requested, pole, {
    stableRoll: !levelFoot, levelEnd: levelFoot,
    minReachMargin: .001, maxReachMargin: .001,
    zeroDirection: new THREE.Vector3(0, -1, 0),
  });
}

function skinGroups(rig) {
  const groups = { arms: { L: [], R: [] }, legs: { L: [], R: [] } };
  for (const mesh of rig.meshes) {
    const ids = new Set();
    const { skinIndex, skinWeight } = mesh.geometry.attributes;
    for (let i = 0; i < skinIndex.count; i++) for (let j = 0; j < 4; j++) if (skinWeight.getComponent(i, j) > 0) ids.add(skinIndex.getComponent(i, j));
    for (const [side, arm, leg] of [['L', 'UpperArm_L', 'Thigh_L'], ['R', 'UpperArm_R', 'Thigh_R']]) {
      if (ids.has(rig.skeleton.bones.findIndex(bone => bone.name === arm))) groups.arms[side].push(mesh);
      if (ids.has(rig.skeleton.bones.findIndex(bone => bone.name === leg))) groups.legs[side].push(mesh);
    }
  }
  return groups;
}
function updateSkin(actor) { actor.root.updateMatrixWorld(true); actor.list.forEach((bone, index) => actor.skinMatrices[index].multiplyMatrices(bone.matrixWorld, actor.inverseBind[index])); }
const skinPosition = new THREE.Vector3();
const skinTemporary = new THREE.Vector3();
function skinVertex(mesh, index, actor, target) {
  const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
  skinPosition.fromBufferAttribute(position, index); target.set(0, 0, 0);
  for (let j = 0; j < 4; j++) {
    const weight = skinWeight.getComponent(index, j);
    if (weight) target.addScaledVector(skinTemporary.copy(skinPosition).applyMatrix4(actor.skinMatrices[skinIndex.getComponent(index, j)]), weight);
  }
  return target;
}
function minimumSkinY(meshes, actor) {
  let minimum = Infinity;
  const point = new THREE.Vector3();
  for (const mesh of meshes) for (let i = 0; i < mesh.geometry.attributes.position.count; i++) minimum = Math.min(minimum, skinVertex(mesh, i, actor, point).y);
  return minimum;
}
function armEntersHead(meshes, actor) {
  const inverse = actor.skinMatrices[actor.indices.Head].clone().invert();
  const point = new THREE.Vector3();
  for (const mesh of meshes) for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    skinVertex(mesh, i, actor, point).applyMatrix4(inverse);
    if (point.y <= 3.28 || point.y >= 5.42) continue;
    const t = point.y >= 4.17 ? (point.y - 4.17) / 1.25 : (point.y - 4.17) / 1.07;
    const exponent = t < 0 ? 2.85 : 2.05;
    const radius = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), exponent)), 1 / exponent);
    const metric = Math.pow(Math.abs(point.x) / (1.58 * radius), 2.2) + Math.pow(Math.abs(point.z) / (.94 * radius), 2.2);
    if (metric < 1 - .0001) return true;
  }
  return false;
}
