import * as THREE from 'three';
import { sampleActionTiming } from './actions.js';

const NAMES = ['NoirBlaster', 'NoirSmokeProp'];

function propMesh(geometry, material, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeBlaster() {
  const group = new THREE.Group();
  group.name = 'NoirBlaster';
  const orange = new THREE.MeshStandardMaterial({ color: '#f1a144', roughness: .54, metalness: 0 });
  const cream = new THREE.MeshStandardMaterial({ color: '#fff0cc', roughness: .58, metalness: 0 });
  const blue = new THREE.MeshStandardMaterial({ color: '#648ba5', roughness: .62, metalness: .04 });
  const body = propMesh(new THREE.SphereGeometry(1, 16, 12), orange, 'Toy blaster shell');
  body.scale.set(.145, .12, .25);
  body.position.set(0, .04, .075);
  group.add(body);
  const barrel = propMesh(new THREE.CylinderGeometry(.055, .067, .24, 12), cream, 'Soft toy muzzle');
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, .055, .31);
  group.add(barrel);
  const muzzle = propMesh(new THREE.TorusGeometry(.049, .011, 6, 14), blue, 'Muzzle ring');
  muzzle.position.set(0, .055, .435);
  group.add(muzzle);
  const grip = propMesh(new THREE.CapsuleGeometry(.053, .12, 4, 10), blue, 'Rounded toy grip');
  grip.position.set(0, -.105, -.035);
  grip.rotation.x = -.12;
  group.add(grip);
  const sight = propMesh(new THREE.BoxGeometry(.045, .035, .11), cream, 'Toy top stripe');
  sight.position.set(0, .16, .09);
  group.add(sight);
  return group;
}

function makeSmokeProp() {
  const group = new THREE.Group();
  group.name = 'NoirSmokeProp';
  const paper = new THREE.MeshStandardMaterial({ color: '#f1e8d5', roughness: .94 });
  const filter = new THREE.MeshStandardMaterial({ color: '#c69863', roughness: .88 });
  const ember = new THREE.MeshStandardMaterial({ color: '#e97c35', roughness: .90, emissive: '#df5d22', emissiveIntensity: .45 });
  const axis = new THREE.Vector3(-.10, .10, .03);
  const cigarette = propMesh(new THREE.CylinderGeometry(.013, .013, .32, 10), paper, 'Rolled paper');
  cigarette.rotation.x = Math.PI / 2;
  cigarette.position.copy(axis);
  group.add(cigarette);
  const tip = propMesh(new THREE.CylinderGeometry(.0132, .0132, .035, 10), ember, 'Orange ember');
  tip.rotation.x = Math.PI / 2;
  tip.position.copy(axis).add(new THREE.Vector3(0, 0, .17));
  group.add(tip);
  const heldEnd = propMesh(new THREE.CylinderGeometry(.0131, .0131, .07, 10), filter, 'Paper filter');
  heldEnd.rotation.x = Math.PI / 2;
  heldEnd.position.copy(axis).add(new THREE.Vector3(0, 0, -.13));
  group.add(heldEnd);
  const smokeMaterial = new THREE.MeshBasicMaterial({ color: '#d6e0e0', transparent: true, opacity: .20, depthWrite: false, toneMapped: false });
  for (const side of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-.10, .12, .215),
      new THREE.Vector3(-.10 + side * .035, .27, .23),
      new THREE.Vector3(-.10 - side * .04, .45, .24),
      new THREE.Vector3(-.10 + side * .055, .63, .23),
      new THREE.Vector3(-.10 + side * .025, .80, .21),
    ]);
    const wisp = propMesh(new THREE.TubeGeometry(curve, 22, side < 0 ? .008 : .005, 5, false), smokeMaterial, 'Gentle smoke wisp');
    wisp.castShadow = false;
    wisp.receiveShadow = false;
    group.add(wisp);
  }
  for (let i = 0; i < 3; i++) {
    const material = smokeMaterial.clone();
    material.opacity = .10 - i * .02;
    const particle = propMesh(new THREE.SphereGeometry(.019 + i * .008, 8, 6), material, 'Soft smoke particle');
    particle.position.set(-.08 + Math.sin(i * 2.5) * .025, .59 + i * .11, .22);
    particle.scale.set(1.3, 1.8, 1);
    particle.castShadow = particle.receiveShadow = false;
    group.add(particle);
  }
  return group;
}

/** Add exportable, hand-bound props without changing the skeletal joint count. */
export function attachActionProps(cat) {
  const rig = cat.userData.rig;
  if (!rig?.bones?.Hand_R) throw new Error('attachActionProps needs a cat created by rigCat().');
  const existing = Object.fromEntries(NAMES.map(name => [name, rig.bones.Hand_R.getObjectByName(name)]));
  const props = {
    NoirBlaster: existing.NoirBlaster ?? makeBlaster(),
    NoirSmokeProp: existing.NoirSmokeProp ?? makeSmokeProp(),
  };
  for (const group of Object.values(props)) {
    group.visible = true;
    group.scale.set(0, 0, 0);
    if (group.parent !== rig.bones.Hand_R) rig.bones.Hand_R.add(group);
  }
  cat.userData.actionProps = props;
  return props;
}

/**
 * Portable scale/quaternion tracks. The sampled skeleton is in model space;
 * cancelling the wrist's world rotation keeps each barrel/paper aligned +Z.
 */
export function sampleActionProps(rig, name, time, duration) {
  const result = Object.fromEntries(NAMES.map(prop => [prop, { scale: new THREE.Vector3(), quaternion: new THREE.Quaternion() }]));
  if (name !== 'Shoot' && name !== 'Smoke') return result;
  const root = rig.root ?? rig.bones.Root;
  root.updateMatrixWorld(true);
  const handRotation = rig.bones.Hand_R.getWorldQuaternion(new THREE.Quaternion());
  const modelRotation = root.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
  const timing = sampleActionTiming(name, time, duration);
  const key = name === 'Shoot' ? 'NoirBlaster' : 'NoirSmokeProp';
  const localAim = name === 'Shoot'
    ? new THREE.Quaternion().setFromEuler(new THREE.Euler(-.025 - .12 * timing.recoil, .025 * timing.aim, 0))
    : new THREE.Quaternion().setFromEuler(new THREE.Euler(-.035 * timing.lift, -.025 * timing.lift, 0));
  const desiredWorld = modelRotation.multiply(localAim);
  result[key].quaternion.copy(handRotation.invert().multiply(desiredWorld)).normalize();
  result[key].scale.setScalar(name === 'Shoot' ? timing.visible : 1);
  return result;
}
