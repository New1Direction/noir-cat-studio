import * as THREE from 'three';

/**
 * A toy-like cat, built from geometry in Three.js. No imported models or textures.
 * Ground: y = 0. Front: +Z. Total height approximately 6.1 arbitrary units.
 */
export function createCat(options = {}) {
  const style = ['original', 'dreamcast', 'ps1', 'ps2'].includes(options.style) ? options.style : 'original';
  const detail = {
    original: { head: [88, 112], ear: [64, 72], body: [100, 72], leg: [84, 40], arm: [10, 24], tail: [48, 20], tip: [24, 16], stroke: [56, 12], cap: [16, 12] },
    dreamcast: { head: [24, 32], ear: [18, 20], body: [24, 20], leg: [20, 12], arm: [4, 12], tail: [18, 10], tip: [12, 8], stroke: [22, 6], cap: [8, 6] },
    ps2: { head: [32, 40], ear: [24, 24], body: [32, 24], leg: [26, 16], arm: [5, 16], tail: [24, 12], tip: [16, 10], stroke: [28, 8], cap: [10, 8] },
    ps1: { head: [10, 16], ear: [8, 10], body: [12, 10], leg: [12, 8], arm: [2, 8], tail: [10, 6], tip: [8, 5], stroke: [14, 4], cap: [6, 4] },
  }[style];
  const faceted = style === 'ps1';
  const glossy = style === 'dreamcast';
  const satin = style === 'ps2';
  const cat = new THREE.Group();
  cat.name = 'Noir the cat';
  const FurMaterial = glossy ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const fur = new FurMaterial({
    color: options.color ?? 0x202021,
    roughness: options.roughness ?? (glossy ? 0.30 : faceted ? 0.82 : satin ? 0.62 : 0.78),
    metalness: glossy ? 0.08 : 0,
    flatShading: faceted,
    vertexColors: satin,
    ...(glossy ? { clearcoat: 0.72, clearcoatRoughness: 0.18 } : {}),
  });
  const faceMaterial = new THREE.MeshStandardMaterial({
    color: 0xfffdf9,
    roughness: glossy ? 0.30 : 0.58,
    metalness: 0,
    flatShading: faceted,
    emissive: 0x33312e,
    emissiveIntensity: 0.12,
  });

  function mesh(geometry, material = fur, name = '') {
    // Flat normals are baked into the geometry so exported GLBs retain the
    // faceted look in viewers that do not understand Three.js flatShading.
    if (faceted) {
      const flatGeometry = geometry.index ? geometry.toNonIndexed() : geometry;
      if (flatGeometry !== geometry) geometry.dispose();
      geometry = flatGeometry;
      geometry.computeVertexNormals();
    }
    const object = new THREE.Mesh(geometry, material);
    object.name = name;
    object.castShadow = true;
    object.receiveShadow = true;
    return object;
  }

  // Horizontal rings give the head its broad cheeks and gently flattened chin.
  // A slightly squared ellipse leaves enough depth for the applied face.
  const headY = 4.17;
  const headTop = 5.42;
  const headBottom = 3.10;
  function headSection(y) {
    const t = y >= headY ? (y - headY) / (headTop - headY) : (y - headY) / (headY - headBottom);
    const power = t < 0 ? 2.85 : 2.05;
    const radius = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), power)), 1 / power);
    return { x: 1.58 * radius, z: 0.94 * radius };
  }
  const headGeometry = ringGeometry((v, angle) => {
    const y = THREE.MathUtils.lerp(headBottom, headTop, v);
    const radius = headSection(y);
    return new THREE.Vector3(
      radius.x * signedPower(Math.cos(angle), 2 / 2.2),
      y,
      radius.z * signedPower(Math.sin(angle), 2 / 2.2),
    );
  }, ...detail.head);
  const head = mesh(headGeometry, fur, 'Head');
  cat.add(head);

  const ears = new THREE.Group();
  ears.name = 'Ears';
  for (const sign of [-1, 1]) {
    const geometry = ringGeometry((v, angle) => {
      // An oval cross section narrows into a softly rounded triangular tip.
      const y = 4.30 + 1.78 * v;
      const roundedTip = Math.pow(Math.max(0, 1 - v), 0.55);
      const lowerRound = Math.min(1, Math.sqrt(v / 0.055));
      const width = 0.52 * roundedTip * lowerRound;
      const depth = 0.35 * Math.pow(Math.max(0, 1 - v), 0.48) * lowerRound;
      const x = sign * (0.99 + 0.04 * Math.sin(v * Math.PI) - 0.03 * v);
      return new THREE.Vector3(x + width * Math.cos(angle), y, -0.12 + depth * Math.sin(angle));
    }, ...detail.ear);
    ears.add(mesh(geometry, fur, sign < 0 ? 'Left ear' : 'Right ear'));
  }
  cat.add(ears);

  const bodyGeometry = ringGeometry((v, angle) => {
    const y = style === 'original'
      ? THREE.MathUtils.lerp(1.36, 3.20, v)
      : 1.36 + capDistributedHeight(v, detail.body[0], 1.84, 0.13, 0.16, style === 'ps1' ? 3 : 4);
    const heightRatio = style === 'original' ? v : (y - 1.36) / 1.84;
    // The taper is continuous. Elliptical end caps meet it tangentially,
    // avoiding the horizontal ripples a chain of eased profile bands creates.
    const bottomCap = y < 1.49 ? Math.sqrt(Math.max(0, 1 - Math.pow((y - 1.49) / 0.13, 2))) : 1;
    const topCap = y > 3.04 ? Math.sqrt(Math.max(0, 1 - Math.pow((y - 3.04) / 0.16, 2))) : 1;
    const cap = bottomCap * topCap;
    const width = (0.505 - 0.11 * heightRatio) * cap;
    const depth = (0.35 - 0.065 * heightRatio) * cap;
    return new THREE.Vector3(width * signedPower(Math.cos(angle), 2 / 2.8), y, depth * signedPower(Math.sin(angle), 2 / 2.8));
  }, ...detail.body);
  const body = mesh(bodyGeometry, fur, 'Body');
  cat.add(body);

  function capsuleBetween(start, end, radius, name) {
    const distance = start.distanceTo(end);
    const object = mesh(new THREE.CapsuleGeometry(radius, Math.max(0.001, distance - radius * 2), ...detail.arm), fur, name);
    object.position.copy(start).add(end).multiplyScalar(0.5);
    object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
    return object;
  }
  function arm(sign) {
    const pivot = new THREE.Group();
    pivot.name = sign < 0 ? 'Left arm pivot' : 'Right arm pivot';
    pivot.position.set(sign * 0.34, 3.12, 0.0);
    pivot.add(capsuleBetween(new THREE.Vector3(0, 0, 0), new THREE.Vector3(sign * 0.96, -1.32, 0.025), 0.155, 'Arm'));
    cat.add(pivot);
    return pivot;
  }
  const leftArm = arm(-1);
  const rightArm = arm(1);

  function leg(sign) {
    const group = new THREE.Group();
    group.name = sign < 0 ? 'Left leg' : 'Right leg';
    // One continuous surface from the subtle rounded sole into the torso.
    // The top overlaps the body; there is no separate ankle or ball foot.
    const geometry = ringGeometry((v, angle) => {
      const y = style === 'original'
        ? v * 1.70
        : capDistributedHeight(v, detail.leg[0], 1.70, 0.13, 0.17, style === 'ps1' ? 3 : 4);
      const heightRatio = style === 'original' ? v : y / 1.70;
      const lower = y < 0.13 ? Math.sqrt(Math.max(0, 1 - Math.pow((y - 0.13) / 0.13, 2))) : 1;
      const upper = y > 1.53 ? Math.sqrt(Math.max(0, 1 - Math.pow((y - 1.53) / 0.17, 2))) : 1;
      const radius = 0.174 * lower * upper;
      const centerX = sign * THREE.MathUtils.lerp(0.37, 0.27, heightRatio);
      const centerZ = 0.015 + 0.055 * Math.exp(-y / 0.18);
      return new THREE.Vector3(centerX + radius * Math.cos(angle), y, centerZ + radius * 1.10 * Math.sin(angle));
    }, ...detail.leg);
    group.add(mesh(geometry, fur, 'Continuous leg and foot'));
    cat.add(group);
    return group;
  }
  const leftLeg = leg(-1);
  const rightLeg = leg(1);

  const tail = new THREE.Group();
  tail.name = 'Curled tail';
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 1.55, -0.25),
    new THREE.Vector3(0, 1.57, -0.60),
    new THREE.Vector3(0, 1.72, -0.94),
    new THREE.Vector3(0, 1.94, -1.10),
    new THREE.Vector3(0, 2.17, -1.13),
  ], false, 'centripetal');
  tail.add(mesh(new THREE.TubeGeometry(tailCurve, detail.tail[0], 0.145, detail.tail[1], false), fur, 'Tail curve'));
  const tailTip = mesh(new THREE.SphereGeometry(0.145, ...detail.tip), fur, 'Rounded tail tip');
  tailTip.position.copy(tailCurve.getPoint(1));
  tail.add(tailTip);
  cat.add(tail);

  // Curves are projected onto the actual head surface, rather than placed on a
  // flat plane. Their inner halves sit inside the head like raised white inlay.
  function faceZ(x, y) {
    const section = headSection(y);
    const ratio = Math.min(0.99999, Math.abs(x) / Math.max(0.0001, section.x));
    return section.z * Math.pow(1 - Math.pow(ratio, 2.2), 1 / 2.2) + 0.025;
  }
  const face = new THREE.Group();
  face.name = 'Smile';
  function faceStroke(points, radius, name) {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, y]) => new THREE.Vector3(x, y, faceZ(x, y))), false, 'centripetal');
    const stroke = mesh(new THREE.TubeGeometry(curve, detail.stroke[0], radius, detail.stroke[1], false), faceMaterial, name);
    stroke.castShadow = false;
    stroke.receiveShadow = false;
    face.add(stroke);
    for (const t of [0, 1]) {
      const cap = mesh(new THREE.SphereGeometry(radius, ...detail.cap), faceMaterial, `${name} cap`);
      cap.position.copy(curve.getPoint(t));
      cap.castShadow = false;
      cap.receiveShadow = false;
      face.add(cap);
    }
  }
  for (const sign of [-1, 1]) {
    const points = [];
    for (let i = 0; i <= 28; i++) {
      const angle = Math.PI - i / 28 * Math.PI;
      points.push([sign * 0.69 + 0.315 * Math.cos(angle), 4.12 + 0.30 * Math.sin(angle)]);
    }
    faceStroke(points, 0.066, sign < 0 ? 'Left smiling eye' : 'Right smiling eye');
  }
  faceStroke([
    [-0.22, 3.91], [-0.185, 3.855], [-0.12, 3.845], [-0.055, 3.875],
    [0, 3.96], [0.055, 3.875], [0.12, 3.845], [0.185, 3.855], [0.22, 3.91],
  ], 0.058, 'Little W smile');
  cat.add(face);

  if (satin) {
    // Mild per-vertex diffuse shading gives the PS2 profile a Gouraud-like
    // tonal gradient. Keep it separate from the editable material color and
    // leave the white face untouched. COLOR_0 survives standard GLB export.
    cat.updateMatrixWorld(true);
    const keyDirection = new THREE.Vector3(-0.50, 0.85, 0.80).normalize();
    const normal = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3();
    cat.traverse((object) => {
      if (!object.isMesh || object.material !== fur) return;
      normalMatrix.getNormalMatrix(object.matrixWorld);
      const normals = object.geometry.attributes.normal;
      const colors = new Float32Array(normals.count * 3);
      for (let i = 0; i < normals.count; i++) {
        normal.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
        const key = Math.max(0, normal.dot(keyDirection));
        const sky = 0.5 + 0.5 * normal.y;
        const diffuse = 0.61 + 0.27 * key + 0.12 * sky;
        const cool = 1 - key;
        colors[i * 3] = diffuse * (1 - 0.035 * cool);
        colors[i * 3 + 1] = diffuse * (1 - 0.012 * cool);
        colors[i * 3 + 2] = diffuse;
      }
      object.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    });
  }

  cat.userData.parts = { head, ears, face, body, leftArm, rightArm, leftLeg, rightLeg, tail };
  cat.userData.materials = { fur, face: faceMaterial };
  cat.userData.height = 6.08;
  cat.userData.style = style;
  cat.userData.triangles = 0;
  cat.traverse((object) => {
    if (object.isMesh) cat.userData.triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
  });
  return cat;
}

/** Put several angularly spaced rings around each cap even at console detail. */
function capDistributedHeight(v, segments, height, bottomCap, topCap, capRings) {
  const ring = v * segments;
  if (ring <= capRings) {
    return bottomCap * (1 - Math.cos(ring / capRings * Math.PI / 2));
  }
  if (ring >= segments - capRings) {
    return height - topCap + topCap * Math.sin((ring - segments + capRings) / capRings * Math.PI / 2);
  }
  return bottomCap + (height - bottomCap - topCap) * (ring - capRings) / (segments - capRings * 2);
}

function signedPower(value, exponent) {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

/** A closed smooth surface from horizontal rings; duplicate seam normals agree. */
function ringGeometry(pointAt, verticalSegments, radialSegments) {
  const vertices = [];
  const indices = [];
  for (let i = 0; i <= verticalSegments; i++) {
    for (let j = 0; j <= radialSegments; j++) {
      const point = pointAt(i / verticalSegments, j / radialSegments * Math.PI * 2);
      vertices.push(point.x, point.y, point.z);
    }
  }
  const row = radialSegments + 1;
  for (let i = 0; i < verticalSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * row + j;
      const b = a + row;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal;
  for (let i = 0; i <= verticalSegments; i++) {
    const a = i * row;
    const b = a + radialSegments;
    const normal = new THREE.Vector3().fromBufferAttribute(normals, a).add(new THREE.Vector3().fromBufferAttribute(normals, b)).normalize();
    normals.setXYZ(a, normal.x, normal.y, normal.z);
    normals.setXYZ(b, normal.x, normal.y, normal.z);
  }
  // Avoid pinching highlights at the coincident vertices of closed poles.
  for (const i of [0, verticalSegments]) {
    const start = i * row;
    const first = new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, start);
    const last = new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, start + Math.floor(radialSegments / 2));
    if (first.distanceTo(last) < 0.0001) {
      const normal = new THREE.Vector3(0, i === 0 ? -1 : 1, 0);
      for (let j = 0; j <= radialSegments; j++) normals.setXYZ(start + j, normal.x, normal.y, normal.z);
    }
  }
  normals.needsUpdate = true;
  geometry.computeBoundingSphere();
  return geometry;
}
