import * as THREE from 'three';

const IDENTITY = new THREE.Quaternion();
const lastBends = new WeakMap();

/** Forget a sampling sequence's singularity fallback before baking a new clip. */
export function resetLimbIK(rig) {
  lastBends.delete(rig);
}

function frameRotation(axis, normal) {
  const x = axis.clone().normalize();
  const z = normal.clone().addScaledVector(x, -normal.dot(x)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

function modelRotation(object, inverseModel) {
  if (!object) return new THREE.Quaternion();
  const matrix = new THREE.Matrix4().multiplyMatrices(inverseModel, object.matrixWorld);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(matrix));
}

function bendDirection(rig, key, direction, pole, defaultBend) {
  const bend = pole.clone().addScaledVector(direction, -pole.dot(direction));
  if (bend.lengthSq() < 1e-10) {
    // At a singular pole, transport the last plane rather than choosing an
    // unrelated world-up roll. Repeated paused evaluation remains idempotent.
    const previous = lastBends.get(rig)?.get(key);
    const candidates = [previous, defaultBend, new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)];
    for (const candidate of candidates) {
      if (!candidate) continue;
      bend.copy(candidate).addScaledVector(direction, -candidate.dot(direction));
      if (bend.lengthSq() >= 1e-10) break;
    }
  }
  bend.normalize();
  if (!lastBends.has(rig)) lastBends.set(rig, new Map());
  lastBends.get(rig).set(key, bend.clone());
  return bend;
}

/**
 * Analytic two-bone IK in character/model coordinates.
 *
 * A pole controls the elbow position. Arm rotations also share its bend-plane
 * normal, removing the unrelated axial twists of two independent shortest-arc
 * rotations. Collinear bind arms get an explicit, fixed rest plane. Feet keep
 * their existing shortest-arc roll and an optional model-space end rotation.
 * Only ordinary bone TRS changes are used, so the result can be baked to glTF.
 */
export function solveLimbIK(rig, names, requestedTarget, pole, {
  stableRoll = names[0].startsWith('UpperArm'),
  levelEnd = false,
  endRotation = null,
  minReachMargin = .001,
  maxReachMargin = .0005,
  zeroDirection = null,
} = {}) {
  const upper = rig.bones[names[0]];
  const middle = rig.bones[names[1]];
  const end = rig.bones[names[2]];
  if (!upper || !middle || !end) return null;
  const axisA = rig.rest[middle.name].position.clone();
  const axisB = rig.rest[end.name].position.clone();
  const lengthA = axisA.length();
  const lengthB = axisB.length();
  if (lengthA < 1e-8 || lengthB < 1e-8) return null;
  rig.root.parent?.updateWorldMatrix(true, false);
  rig.root.updateMatrixWorld(true);
  const model = rig.root.parent?.matrixWorld ?? new THREE.Matrix4();
  const inverseModel = model.clone().invert();
  const start = upper.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseModel);
  const direction = requestedTarget.clone().sub(start);
  const desiredDistance = direction.length();
  if (desiredDistance < 1e-8) {
    if (!zeroDirection) return null;
    direction.copy(zeroDirection).normalize();
  } else direction.divideScalar(desiredDistance);
  const distance = THREE.MathUtils.clamp(desiredDistance,
    Math.abs(lengthA - lengthB) + minReachMargin,
    lengthA + lengthB - maxReachMargin);
  const target = start.clone().addScaledVector(direction, distance);
  const defaultBend = new THREE.Vector3(0, 0, stableRoll ? -1 : 1);
  const bend = bendDirection(rig, upper.name, direction, pole, defaultBend);
  const along = (lengthA * lengthA + distance * distance - lengthB * lengthB) / (2 * distance);
  const joint = start.clone().addScaledVector(direction, along)
    .addScaledVector(bend, Math.sqrt(Math.max(0, lengthA * lengthA - along * along)));
  const upperDirection = joint.clone().sub(start).normalize();
  const lowerDirection = target.clone().sub(joint).normalize();
  let upperRotation;
  let lowerRotation;
  const planeNormal = new THREE.Vector3().crossVectors(direction, bend).normalize();
  if (stableRoll) {
    // The two arm offsets are collinear in bind pose, so their cross product
    // cannot define roll. Both segments use the same explicit bind normal.
    const restNormal = new THREE.Vector3().crossVectors(axisA, defaultBend).normalize();
    upperRotation = frameRotation(upperDirection, planeNormal)
      .multiply(frameRotation(axisA, restNormal).invert()).normalize();
    lowerRotation = frameRotation(lowerDirection, planeNormal)
      .multiply(frameRotation(axisB, restNormal).invert()).normalize();
  } else {
    upperRotation = new THREE.Quaternion().setFromUnitVectors(axisA.normalize(), upperDirection);
    lowerRotation = new THREE.Quaternion().setFromUnitVectors(axisB.normalize(), lowerDirection);
  }
  const parentRotation = modelRotation(upper.parent, inverseModel);
  upper.quaternion.copy(parentRotation.invert().multiply(upperRotation)).normalize();
  middle.quaternion.copy(upperRotation.clone().invert().multiply(lowerRotation)).normalize();
  if (levelEnd) {
    end.quaternion.copy(lowerRotation.clone().invert().multiply(endRotation ?? IDENTITY)).normalize();
  } else {
    // A toy paw inherits its forearm. Explicit wrist offsets remain local.
    end.quaternion.copy(endRotation ?? IDENTITY).normalize();
  }
  rig.root.updateMatrixWorld(true);
  return { start, joint, target, planeNormal, distance, desiredDistance };
}
