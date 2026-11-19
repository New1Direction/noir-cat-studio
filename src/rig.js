import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Locations are expressed in the cat's model coordinates. Local bone rotations
// are identity in the bind pose, so animations can share the same tracks at
// every geometry detail level.
const BONE_LAYOUT = [
  ['Root', null, [0, 0, 0]],
  ['Hips', 'Root', [0, 1.55, 0]],
  ['Spine', 'Hips', [0, 2.35, 0]],
  ['Head', 'Spine', [0, 3.22, 0]],
  ['Ear_L', 'Head', [-0.99, 4.85, -0.12]],
  ['Ear_R', 'Head', [0.99, 4.85, -0.12]],
  ['Eye_L', 'Head', [-0.69, 4.2, 0.93]],
  ['Eye_R', 'Head', [0.69, 4.2, 0.93]],
  ['Mouth', 'Head', [0, 3.9, 0.96]],
  ['UpperArm_L', 'Spine', [-0.34, 3.12, 0]],
  ['Forearm_L', 'UpperArm_L', [-0.82, 2.46, 0.0125]],
  ['Hand_L', 'Forearm_L', [-1.30, 1.8, 0.025]],
  ['UpperArm_R', 'Spine', [0.34, 3.12, 0]],
  ['Forearm_R', 'UpperArm_R', [0.82, 2.46, 0.0125]],
  ['Hand_R', 'Forearm_R', [1.30, 1.8, 0.025]],
  ['Thigh_L', 'Hips', [-0.27, 1.53, 0]],
  ['Shin_L', 'Thigh_L', [-0.32, 0.85, 0.03]],
  ['Foot_L', 'Shin_L', [-0.37, 0.13, 0.07]],
  ['Thigh_R', 'Hips', [0.27, 1.53, 0]],
  ['Shin_R', 'Thigh_R', [0.32, 0.85, 0.03]],
  ['Foot_R', 'Shin_R', [0.37, 0.13, 0.07]],
  ['Tail_0', 'Hips', [0, 1.55, -0.25]],
  ['Tail_1', 'Tail_0', [0, 1.57, -0.60]],
  ['Tail_2', 'Tail_1', [0, 1.72, -0.94]],
  ['Tail_3', 'Tail_2', [0, 1.94, -1.10]],
  ['Tail_4', 'Tail_3', [0, 2.17, -1.13]],
];

const ARM_DETAIL = {
  original: { cap: 10, radial: 24, shaft: 28 },
  dreamcast: { cap: 4, radial: 12, shaft: 14 },
  ps1: { cap: 2, radial: 8, shaft: 10 },
  ps2: { cap: 5, radial: 16, shaft: 18 },
};

/**
 * Convert a procedural cat into a genuine, fully weighted skeletal character.
 * The silhouette and materials are retained. Arms use rigid shafts and a round
 * elbow joint so deep bends keep their volume in standard glTF skinning.
 * Geometry is baked into cat-local coordinates.
 */
export function rigCat(cat) {
  if (cat.userData.rig) return cat;

  const style = cat.userData.style ?? 'original';
  const sourceParts = cat.userData.parts ?? {};
  const membership = new Map();
  for (const [partName, part] of Object.entries(sourceParts)) {
    part.traverse((object) => {
      if (object.isMesh) membership.set(object, partName);
    });
  }

  cat.updateWorldMatrix(true, true);
  const inverseCat = cat.matrixWorld.clone().invert();
  const sources = [];
  cat.traverse((object) => {
    if (!object.isMesh) return;
    sources.push({
      object,
      part: membership.get(object),
      matrix: new THREE.Matrix4().multiplyMatrices(inverseCat, object.matrixWorld),
    });
  });

  const bones = {};
  const boneIndices = {};
  const bindPositions = {};
  BONE_LAYOUT.forEach(([name, parentName, position], index) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bindPositions[name] = new THREE.Vector3(...position);
    bone.position.copy(bindPositions[name]);
    if (parentName) {
      bone.position.sub(bindPositions[parentName]);
      bones[parentName].add(bone);
    }
    bones[name] = bone;
    boneIndices[name] = index;
  });

  const parts = {};
  const meshes = [];
  cat.clear();
  // Keep bones first in traversal so name-based animation tracks such as
  // Head.quaternion resolve to the bone rather than the similarly named mesh.
  cat.add(bones.Root);
  for (const [name, source] of Object.entries(sourceParts)) {
    if (source.isMesh) continue;
    const group = new THREE.Group();
    group.name = source.name;
    group.visible = source.visible;
    parts[name] = group;
    cat.add(group);
  }

  for (const { object: source, part, matrix } of sources) {
    const isArm = part === 'leftArm' || part === 'rightArm';
    let geometry = isArm ? armGeometry(source.geometry, style, part === 'leftArm' ? 'L' : 'R') : source.geometry.clone();
    geometry.applyMatrix4(matrix);

    // Original PS2 colors are preserved on every other part. New arm vertices
    // use the same model-space Gouraud bake as the procedural source.
    if (isArm && source.geometry.hasAttribute('color')) bakeArmColors(geometry);

    const position = geometry.attributes.position;
    const indices = new Uint16Array(position.count * 4);
    const weights = new Float32Array(position.count * 4);
    const point = new THREE.Vector3();
    const armSections = isArm ? Object.values(geometry.userData.armSections) : null;
    let sectionIndex = 0;
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i);
      if (armSections) while (i >= armSections[sectionIndex].start + armSections[sectionIndex].count) sectionIndex++;
      const influences = armSections ? [[armSections[sectionIndex].bone, 1]] : weightsForPart(part, source.name, point, bindPositions);
      let sum = 0;
      for (const [, weight] of influences) sum += weight;
      influences.forEach(([boneName, weight], j) => {
        weights[i * 4 + j] = weight / sum;
        // glTF requires an unused influence to name joint zero. Read back the
        // Float32 value so even a rounded-to-zero weight has a clean index.
        indices[i * 4 + j] = weights[i * 4 + j] === 0 ? 0 : boneIndices[boneName];
      });
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));

    const skinned = new THREE.SkinnedMesh(geometry, source.material);
    skinned.name = source.name;
    skinned.visible = source.visible;
    skinned.castShadow = source.castShadow;
    skinned.receiveShadow = source.receiveShadow;
    skinned.renderOrder = source.renderOrder;
    skinned.layers.mask = source.layers.mask;
    // Bone-driven limbs and ears may move beyond their original bounds.
    skinned.frustumCulled = false;
    skinned.normalizeSkinWeights();
    meshes.push(skinned);

    if (part && parts[part]) {
      parts[part].add(skinned);
    } else {
      cat.add(skinned);
      if (part) parts[part] = skinned;
    }
    source.geometry.dispose();
  }

  cat.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(BONE_LAYOUT.map(([name]) => bones[name]));
  skeleton.calculateInverses();
  for (const mesh of meshes) mesh.bind(skeleton, cat.matrixWorld);

  const rest = {};
  for (const [name, bone] of Object.entries(bones)) {
    rest[name] = {
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone(),
      worldPosition: bone.getWorldPosition(new THREE.Vector3()),
    };
  }

  cat.userData.parts = parts;
  cat.userData.triangles = meshes.reduce((sum, mesh) => sum +
    (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3, 0);
  cat.userData.rig = {
    skeleton,
    bones,
    rest,
    meshes,
    resetPose() {
      for (const [name, bone] of Object.entries(bones)) {
        bone.position.copy(rest[name].position);
        bone.quaternion.copy(rest[name].quaternion);
        bone.scale.copy(rest[name].scale);
      }
      cat.updateMatrixWorld(true);
      skeleton.update();
    },
  };
  skeleton.update();
  return cat;
}

function armGeometry(source, style, side) {
  const detail = ARM_DETAIL[style] ?? ARM_DETAIL.original;
  const parameters = source.parameters ?? {};
  const radius = parameters.radius ?? 0.155;
  const shoulder = new THREE.Vector3(0.34, 3.12, 0);
  const hand = new THREE.Vector3(1.30, 1.8, 0.025);
  const fullLength = (parameters.height ?? shoulder.distanceTo(hand) - radius * 2) + radius * 2;
  const capSegments = parameters.capSegments ?? detail.cap;
  const radialSegments = parameters.radialSegments ?? detail.radial;
  const shaftSegments = Math.max(2, Math.ceil(detail.shaft / 2));
  const halfLength = fullLength / 2;
  const upperRings = [];
  const forearmRings = [];

  // Source capsule local -Y is the shoulder, +Y is the paw. The joint is at
  // zero. Neither shaft has a curved cap at that joint: a single full sphere
  // fills its exposed bend and meets both open shaft equators tangentially.
  for (let i = 0; i <= capSegments; i++) {
    const angle = i / capSegments * Math.PI / 2;
    upperRings.push({ y: -halfLength + radius - radius * Math.cos(angle), radius: radius * Math.sin(angle), normalY: -Math.cos(angle), normalR: Math.sin(angle) });
  }
  for (let i = 1; i <= shaftSegments; i++) {
    upperRings.push({ y: THREE.MathUtils.lerp(-halfLength + radius, 0, i / shaftSegments), radius, normalY: 0, normalR: 1 });
  }
  for (let i = 0; i <= shaftSegments; i++) {
    forearmRings.push({ y: (halfLength - radius) * i / shaftSegments, radius, normalY: 0, normalR: 1 });
  }
  for (let i = 1; i <= capSegments; i++) {
    const angle = i / capSegments * Math.PI / 2;
    forearmRings.push({ y: halfLength - radius + radius * Math.sin(angle), radius: radius * Math.cos(angle), normalY: Math.sin(angle), normalR: Math.cos(angle) });
  }
  const jointDetail = { original: [32, 20], dreamcast: [20, 12], ps2: [24, 16], ps1: [12, 8] }[style] ?? [32, 20];
  const pieces = [
    { name: 'upper', bone: `UpperArm_${side}`, geometry: armSurface(upperRings, radialSegments) },
    { name: 'forearm', bone: `Forearm_${side}`, geometry: armSurface(forearmRings, radialSegments) },
    { name: 'elbow', bone: `Forearm_${side}`, geometry: new THREE.SphereGeometry(radius, ...jointDetail) },
  ];
  const sections = {};
  let offset = 0;
  for (const piece of pieces) {
    if (style === 'ps1') {
      const indexed = piece.geometry;
      piece.geometry = indexed.toNonIndexed();
      indexed.dispose();
      piece.geometry.computeVertexNormals();
    }
    const count = piece.geometry.attributes.position.count;
    sections[piece.name] = { start: offset, count, bone: piece.bone };
    offset += count;
  }
  const geometry = mergeGeometries(pieces.map(piece => piece.geometry));
  for (const piece of pieces) piece.geometry.dispose();
  geometry.userData.armConstruction = 'rigid-shafts-and-round-elbow';
  geometry.userData.armRadius = radius;
  geometry.userData.armSections = sections;
  return geometry;
}

function armSurface(rings, radialSegments) {
  const positions = [], normals = [], uvs = [], indices = [];
  const row = radialSegments + 1;
  const height = rings.at(-1).y - rings[0].y;
  for (const ring of rings) {
    for (let j = 0; j <= radialSegments; j++) {
      const angle = j / radialSegments * Math.PI * 2;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      positions.push(ring.radius * cosine, ring.y, ring.radius * sine);
      normals.push(ring.normalR * cosine, ring.normalY, ring.normalR * sine);
      uvs.push(j / radialSegments, (ring.y - rings[0].y) / height);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * row + j, b = a + row;
      if (rings[i + 1].radius > 1e-8) indices.push(a, b, b + 1);
      if (rings[i].radius > 1e-8) indices.push(a, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function bakeArmColors(geometry) {
  const keyDirection = new THREE.Vector3(-0.50, 0.85, 0.80).normalize();
  const normal = new THREE.Vector3();
  const normals = geometry.attributes.normal;
  const colors = new Float32Array(normals.count * 3);
  for (let i = 0; i < normals.count; i++) {
    normal.fromBufferAttribute(normals, i).normalize();
    const key = Math.max(0, normal.dot(keyDirection));
    const sky = 0.5 + 0.5 * normal.y;
    const diffuse = 0.61 + 0.27 * key + 0.12 * sky;
    const cool = 1 - key;
    colors[i * 3] = diffuse * (1 - 0.035 * cool);
    colors[i * 3 + 1] = diffuse * (1 - 0.012 * cool);
    colors[i * 3 + 2] = diffuse;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

function weightsForPart(part, meshName, point, bindPositions) {
  switch (part) {
    case 'head': return [['Head', 1]];
    case 'ears': return [[meshName.startsWith('Left') ? 'Ear_L' : 'Ear_R', 1]];
    case 'face':
      if (meshName.startsWith('Left')) return [['Eye_L', 1]];
      if (meshName.startsWith('Right')) return [['Eye_R', 1]];
      return [['Mouth', 1]];
    case 'body': {
      const t = smoothstep(point.y, 1.72, 2.82);
      return [['Hips', 1 - t], ['Spine', t]];
    }
    case 'leftArm': return limbWeights(point, 'UpperArm_L', 'Forearm_L', 'Hand_L', bindPositions, false);
    case 'rightArm': return limbWeights(point, 'UpperArm_R', 'Forearm_R', 'Hand_R', bindPositions, false);
    case 'leftLeg': return limbWeights(point, 'Thigh_L', 'Shin_L', 'Foot_L', bindPositions, true);
    case 'rightLeg': return limbWeights(point, 'Thigh_R', 'Shin_R', 'Foot_R', bindPositions, true);
    case 'tail': return tailWeights(point, bindPositions);
    default: return [['Root', 1]];
  }
}

function limbWeights(point, upper, middle, end, bindPositions, leg) {
  const start = bindPositions[upper];
  const axis = new THREE.Vector3().subVectors(bindPositions[end], start);
  const t = new THREE.Vector3().subVectors(point, start).dot(axis) / axis.lengthSq();
  if (t < 0.62) {
    const blend = smoothstep(t, 0.38, 0.62);
    return [[upper, 1 - blend], [middle, blend]];
  }
  const blend = smoothstep(t, leg ? 0.84 : 0.88, leg ? 1.02 : 1.0);
  return [[middle, 1 - blend], [end, blend]];
}

function tailWeights(point, bindPositions) {
  let bestDistance = Infinity;
  let bestSegment = 0;
  let bestT = 0;
  for (let i = 0; i < 4; i++) {
    const start = bindPositions[`Tail_${i}`];
    const axis = new THREE.Vector3().subVectors(bindPositions[`Tail_${i + 1}`], start);
    const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(point, start).dot(axis) / axis.lengthSq(), 0, 1);
    const distance = point.distanceToSquared(axis.multiplyScalar(t).add(start));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSegment = i;
      bestT = t;
    }
  }
  return [[`Tail_${bestSegment}`, 1 - bestT], [`Tail_${bestSegment + 1}`, bestT]];
}

function smoothstep(value, low, high) {
  const t = THREE.MathUtils.clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
}
