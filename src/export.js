import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/** Capture a portable static pose as a normal animation, including solved IK. */
export function createPoseClip(cat) {
  const tracks = [];
  for (const bone of cat.userData.rig.skeleton.bones) {
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, [0, 1], [...bone.position, ...bone.position]));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0, 1], [...bone.quaternion, ...bone.quaternion]));
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.scale`, [0, 1], [...bone.scale, ...bone.scale]));
  }
  for (const name of ['NoirBlaster', 'NoirSmokeProp']) {
    const prop = cat.getObjectByName(name);
    if (!prop) continue;
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, [0, 1], [...prop.scale, ...prop.scale]));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], [...prop.quaternion, ...prop.quaternion]));
  }
  return new THREE.AnimationClip('Custom Pose', 1, tracks);
}

/** Clone a real skeleton without serializing the runtime controller references. */
export function cloneRigForExport(cat) {
  const savedData = new Map();
  cat.traverse(object => { savedData.set(object, object.userData); object.userData = {}; });
  let copy;
  try { copy = cloneSkeleton(cat); }
  finally { savedData.forEach((data, object) => { object.userData = data; }); }
  copy.position.set(0, 0, 0);
  copy.rotation.set(0, 0, 0);
  copy.scale.set(1, 1, 1);
  copy.visible = true;
  copy.updateMatrixWorld(true);
  copy.traverse(object => {
    if (object.isSkinnedMesh) object.skeleton.pose();
    if (object.name === 'NoirBlaster' || object.name === 'NoirSmokeProp') { object.scale.setScalar(0); object.quaternion.identity(); }
    if (object.isMesh) {
      object.material = object.material.clone();
      object.material.wireframe = false;
    }
  });
  copy.updateMatrixWorld(true);
  return copy;
}

/** Produce an optimized, validated GLB containing skins and baked animation. */
export async function exportAnimatedGLB(cat, animations, options = {}) {
  const copy = cloneRigForExport(cat);
  const clips = options.includePose ? [...animations, createPoseClip(cat)] : animations;
  // Put skinned meshes at scene roots, alongside their bone hierarchy. This
  // avoids ambiguous parent transforms and the validator's non-root warnings.
  const scene = new THREE.Scene();
  scene.name = 'Noir';
  scene.userData = { edition: cat.userData.style, rig: 'Noir26', procedural: true };
  const surfaces = [];
  copy.traverse(object => { if (object.isSkinnedMesh) surfaces.push(object); });
  scene.add(copy.children.find(object => object.isBone));
  for (const surface of surfaces) scene.attach(surface);
  scene.updateMatrixWorld(true);
  let raw;
  try {
    raw = await new GLTFExporter().parseAsync(scene, {
      binary: true, onlyVisible: true, animations: clips, trs: true,
    });
  } finally {
    scene.traverse(object => { if (object.isMesh) object.material.dispose(); });
  }
  let binary = new Uint8Array(raw);
  if (options.optimize !== false) {
    const [{ WebIO }, { ALL_EXTENSIONS }, { dedup, resample, prune }] = await Promise.all([
      import('@gltf-transform/core'), import('@gltf-transform/extensions'), import('@gltf-transform/functions'),
    ]);
    const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
    const document = await io.readBinary(binary);
    // Preserve the audited joint paths when reducing baked animation keys.
    await document.transform(dedup(), resample({ tolerance: 1e-6 }), prune({ keepLeaves: true }));
    binary = await io.writeBinary(document);
  }
  const validator = await import('gltf-validator');
  const report = await validator.validateBytes(binary, { maxIssues: 100 });
  if (report.issues.numErrors > 0) {
    const error = new Error(`GLB validation found ${report.issues.numErrors} errors.`);
    error.report = report;
    throw error;
  }
  return { binary, report, animations: clips.map(clip => clip.name), originalBytes: raw.byteLength };
}
