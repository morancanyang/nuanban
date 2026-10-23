import { AnimationClip, BoxGeometry, CatmullRomCurve3, CylinderGeometry, DoubleSide, ExtrudeGeometry,
  Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, NumberKeyframeTrack, Shape, SphereGeometry,
  TorusGeometry, TubeGeometry, Vector3 } from 'three';
import type { Material } from 'three';

type Point = [number, number, number];

export interface ProceduralModelSource {
  format: 'procedural-lumi';
  id: 'lumi';
  root: Group;
  animations: AnimationClip[];
}

function material(color: number, roughness = 0.68, metalness = 0) {
  return new MeshStandardMaterial({ color, roughness, metalness });
}

function sphere(parent: Group, name: string, materialValue: Material, position: Point, scale: Point, segments = 24) {
  const mesh = new Mesh(new SphereGeometry(1, segments, Math.round(segments * 0.7)), materialValue);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function tube(parent: Group, name: string, materialValue: Material, points: Point[], radius: number, segments = 32) {
  const curve = new CatmullRomCurve3(points.map(point => new Vector3(...point)));
  const mesh = new Mesh(new TubeGeometry(curve, segments, radius, 8, false), materialValue);
  mesh.name = name;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function box(parent: Group, name: string, materialValue: Material, position: Point, scale: Point) {
  const mesh = new Mesh(new BoxGeometry(...scale), materialValue);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function extruded(parent: Group, name: string, shape: Shape, materialValue: Material, position: Point, depth: number, bevel = 0.02) {
  const mesh = new Mesh(new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSegments: 3,
    steps: 1,
    bevelSize: bevel,
    bevelThickness: bevel * 0.7,
    curveSegments: 12,
  }), materialValue);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function starShape(outerRadius: number, innerRadius: number) {
  const shape = new Shape();
  for (let index = 0; index < 10; index++) {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function makePaw(parent: Group, name: string, materialValue: Material, scaleValue = 1) {
  const paw = new Group();
  paw.name = name;
  parent.add(paw);
  sphere(paw, `${name}_Pad`, materialValue, [0, 0, 0], [0.145 * scaleValue, 0.125 * scaleValue, 0.14 * scaleValue]);
  for (let toe = 0; toe < 3; toe++) {
    const x = (toe - 1) * 0.082 * scaleValue;
    sphere(paw, `${name}_Toe_${toe + 1}`, materialValue, [x, -0.07 * scaleValue, 0.035 * scaleValue], [0.052 * scaleValue, 0.065 * scaleValue, 0.075 * scaleValue], 16);
  }
  return paw;
}

function clip(name: string, duration: number, tracks: NumberKeyframeTrack[]) {
  return new AnimationClip(name, duration, tracks);
}

function track(path: string, times: number[], values: number[]) {
  return new NumberKeyframeTrack(path, times, values);
}

function makeEar(parent: Group, name: string, fur: Material, inner: Material, side: number) {
  const ear = new Group();
  ear.name = name;
  ear.position.set(side * 0.45, 0.42, -0.02);
  ear.rotation.z = side * -0.08;
  parent.add(ear);
  const outerShape = new Shape();
  outerShape.moveTo(-0.25, -0.17);
  outerShape.quadraticCurveTo(-0.28, 0.03, -0.08, 0.46);
  outerShape.quadraticCurveTo(0, 0.59, 0.09, 0.45);
  outerShape.quadraticCurveTo(0.28, 0.05, 0.25, -0.17);
  outerShape.quadraticCurveTo(0, -0.27, -0.25, -0.17);
  extruded(ear, `${name}_Outer`, outerShape, fur, [0, 0, 0], 0.1, 0.035);
  const innerShape = new Shape();
  innerShape.moveTo(-0.15, -0.1);
  innerShape.quadraticCurveTo(-0.17, 0.05, -0.06, 0.35);
  innerShape.quadraticCurveTo(0, 0.45, 0.06, 0.34);
  innerShape.quadraticCurveTo(0.17, 0.05, 0.15, -0.1);
  innerShape.quadraticCurveTo(0, -0.17, -0.15, -0.1);
  extruded(ear, `${name}_Inner`, innerShape, inner, [0, 0, 0.115], 0.025, 0.015);
  return ear;
}

function makeEye(parent: Group, name: string, materials: { socket: Material; white: Material; irisOuter: Material; iris: Material; pupil: Material; highlight: Material }, side: number) {
  const eye = new Group();
  eye.name = name;
  eye.position.set(side * 0.27, 0.07, 0.49);
  parent.add(eye);
  sphere(eye, `${name}_Socket`, materials.socket, [0, 0, 0], [0.185, 0.225, 0.09], 24);
  sphere(eye, `${name}_White`, materials.white, [0, 0, 0.04], [0.153, 0.194, 0.075], 28);
  sphere(eye, `${name}_Iris_Outer`, materials.irisOuter, [-side * 0.012, -0.005, 0.1], [0.092, 0.139, 0.043], 24);
  sphere(eye, `${name}_Iris`, materials.iris, [-side * 0.012, -0.003, 0.128], [0.073, 0.114, 0.032], 24);
  sphere(eye, `${name}_Pupil`, materials.pupil, [-side * 0.012, -0.003, 0.151], [0.033, 0.086, 0.021], 20);
  sphere(eye, `${name}_Glint`, materials.highlight, [-0.027, 0.052, 0.172], [0.024, 0.032, 0.012], 14);
  sphere(eye, `${name}_Glint_Small`, materials.highlight, [0.031, -0.042, 0.168], [0.011, 0.014, 0.008], 12);
  return eye;
}

function createAnimations(): AnimationClip[] {
  const idleTimes = [0, 0.8, 1.6];
  const shortTimes = [0, 0.45, 0.9];
  const longTimes = [0, 1, 2];
  return [
    clip('idle', 1.6, [
      track('Body.position[y]', idleTimes, [1.25, 1.275, 1.25]),
      track('LumiHead.rotation[z]', idleTimes, [0, 0.018, 0]),
      track('Tail.rotation[z]', idleTimes, [0, 0.08, 0]),
    ]),
    clip('walk', 1.1, [
      track('Body.position[y]', [0, 0.275, 0.55, 0.825, 1.1], [1.25, 1.285, 1.25, 1.285, 1.25]),
      track('Leg_L.rotation[z]', [0, 0.275, 0.55, 0.825, 1.1], [0.1, -0.18, 0.1, -0.18, 0.1]),
      track('Leg_R.rotation[z]', [0, 0.275, 0.55, 0.825, 1.1], [-0.18, 0.1, -0.18, 0.1, -0.18]),
      track('Arm_L.rotation[z]', [0, 0.275, 0.55, 0.825, 1.1], [-0.18, -0.02, -0.18, -0.02, -0.18]),
      track('Arm_R.rotation[z]', [0, 0.275, 0.55, 0.825, 1.1], [0.18, 0.02, 0.18, 0.02, 0.18]),
    ]),
    clip('wave', 1.4, [
      track('Arm_L.rotation[z]', [0, 0.35, 0.7, 1.05, 1.4], [-0.18, -0.62, -0.38, -0.68, -0.18]),
      track('LumiHead.rotation[z]', [0, 0.7, 1.4], [0, -0.025, 0]),
    ]),
    clip('happy', 1.2, [
      track('Body.position[y]', [0, 0.3, 0.6, 0.9, 1.2], [1.25, 1.31, 1.25, 1.31, 1.25]),
      track('LumiHead.rotation[z]', [0, 0.6, 1.2], [0, 0.035, 0]),
    ]),
    clip('think', 2, [
      track('LumiHead.rotation[z]', longTimes, [0, 0.12, 0]),
      track('Arm_L.rotation[z]', longTimes, [-0.18, -0.46, -0.18]),
    ]),
    clip('cast', 1.2, [
      track('Staff.rotation[z]', [0, 0.35, 0.7, 1.2], [-0.08, 0.24, -0.18, -0.08]),
      track('Arm_R.rotation[z]', [0, 0.35, 0.7, 1.2], [0.18, 0.42, 0.28, 0.18]),
      track('Gem.scale[x]', [0, 0.35, 0.7, 1.2], [1, 1.18, 1.04, 1]),
      track('Gem.scale[y]', [0, 0.35, 0.7, 1.2], [1, 1.18, 1.04, 1]),
      track('Gem.scale[z]', [0, 0.35, 0.7, 1.2], [1, 1.18, 1.04, 1]),
    ]),
    clip('surprise', 0.9, [
      track('LumiHead.scale[y]', [0, 0.2, 0.45, 0.9], [1, 1.08, 1.04, 1]),
      track('Body.position[y]', [0, 0.2, 0.45, 0.9], [1.25, 1.33, 1.29, 1.25]),
    ]),
    clip('sleep', 2.4, [
      track('LumiHead.rotation[z]', [0, 1.2, 2.4], [0, 0.16, 0]),
      track('Body.position[y]', [0, 1.2, 2.4], [1.25, 1.22, 1.25]),
    ]),
    clip('tap_react', 0.9, [
      track('LumiHead.position[y]', [0, 0.2, 0.45, 0.9], [2.18, 2.25, 2.2, 2.18]),
      track('LumiHead.rotation[z]', [0, 0.45, 0.9], [0, -0.08, 0]),
    ]),
    clip('blink', 0.2, [
      track('Eye_L.scale[y]', [0, 0.08, 0.2], [1, 0.2, 1]),
      track('Eye_R.scale[y]', [0, 0.08, 0.2], [1, 0.2, 1]),
    ]),
    clip('face_happy', 1.2, [track('LumiHead.scale[y]', [0, 0.6, 1.2], [1, 1.035, 1])]),
    clip('face_cast', 1.2, [track('Gem.rotation[z]', [0, 0.6, 1.2], [0, 0.15, 0])]),
    clip('face_sleep', 2.4, [
      track('Eye_L.scale[y]', [0, 1.2, 2.4], [1, 0.42, 0.42]),
      track('Eye_R.scale[y]', [0, 1.2, 2.4], [1, 0.42, 0.42]),
    ]),
    clip('face_surprise', 0.9, [
      track('Eye_L.scale[y]', [0, 0.2, 0.9], [1, 1.12, 1]),
      track('Eye_R.scale[y]', [0, 0.2, 0.9], [1, 1.12, 1]),
    ]),
    clip('face_tap_react', 0.9, [track('LumiHead.scale[x]', [0, 0.45, 0.9], [1, 1.025, 1])]),
    clip('face_think', 2, [track('LumiHead.rotation[z]', longTimes, [0, 0.05, 0])]),
  ];
}

export function createLumiModel(): ProceduralModelSource {
  const fur = material(0xf1e2ca, 0.86);
  const furLight = material(0xfff2dc, 0.92);
  const furShade = material(0xd5bea1, 0.86);
  const pink = material(0xd8898d, 0.55);
  const noseMaterial = material(0xe99a9b, 0.42);
  const mouthMaterial = material(0x76574b, 0.76);
  const eyeSocket = material(0x44383c, 0.42);
  const eyeWhite = material(0xfffbf2, 0.24);
  const irisOuter = material(0x176895, 0.26);
  const iris = material(0x4dc2e1, 0.24);
  const pupil = material(0x122a3a, 0.16);
  const highlight = material(0xffffff, 0.12);
  const cape = new MeshPhysicalMaterial({ color: 0x584a9b, roughness: 0.56, metalness: 0.08, clearcoat: 0.16, side: DoubleSide });
  const capeLight = material(0x8173c4, 0.58);
  const gold = new MeshStandardMaterial({ color: 0xe0bd71, roughness: 0.3, metalness: 0.72 });
  const teal = new MeshPhysicalMaterial({ color: 0x37bda7, roughness: 0.2, metalness: 0.16, clearcoat: 0.8, clearcoatRoughness: 0.18 });
  const bag = material(0x9b7660, 0.74);
  const bagLight = material(0xc39a74, 0.68);
  const staffWood = material(0x72594c, 0.7);

  const root = new Group();
  root.name = 'Lumi_Root';

  const head = new Group();
  head.name = 'LumiHead';
  head.position.y = 2.17;
  root.add(head);
  sphere(head, 'Head_Fur', fur, [0, 0, 0], [0.72, 0.63, 0.57], 32);
  makeEar(head, 'Ear_L', fur, pink, -1);
  makeEar(head, 'Ear_R', fur, pink, 1);
  sphere(head, 'Cheek_L', furLight, [-0.31, -0.19, 0.42], [0.31, 0.23, 0.19], 24);
  sphere(head, 'Cheek_R', furLight, [0.31, -0.19, 0.42], [0.31, 0.23, 0.19], 24);
  const eyeMaterials = { socket: eyeSocket, white: eyeWhite, irisOuter, iris, pupil, highlight };
  makeEye(head, 'Eye_L', eyeMaterials, -1);
  makeEye(head, 'Eye_R', eyeMaterials, 1);
  for (const side of [-1, 1]) {
    tube(head, `UpperLid_${side < 0 ? 'L' : 'R'}`, furShade,
      [[side * 0.12, 0.16, 0.55], [side * 0.27, 0.24, 0.56], [side * 0.41, 0.16, 0.53]], 0.018, 20);
    tube(head, `Brow_${side < 0 ? 'L' : 'R'}`, furShade,
      [[side * 0.16, 0.32, 0.49], [side * 0.27, 0.36, 0.51], [side * 0.38, 0.32, 0.48]], 0.014, 18);
  }
  const noseShape = new Shape();
  noseShape.moveTo(-0.075, 0.025);
  noseShape.quadraticCurveTo(-0.09, 0.09, -0.035, 0.085);
  noseShape.quadraticCurveTo(0, 0.075, 0.035, 0.085);
  noseShape.quadraticCurveTo(0.09, 0.09, 0.075, 0.025);
  noseShape.quadraticCurveTo(0, -0.055, -0.075, 0.025);
  extruded(head, 'Nose', noseShape, noseMaterial, [0, -0.12, 0.665], 0.045, 0.012);
  tube(head, 'Mouth_Center', mouthMaterial, [[0, -0.16, 0.7], [0, -0.215, 0.715]], 0.012, 10);
  for (const side of [-1, 1]) {
    tube(head, `Mouth_${side < 0 ? 'L' : 'R'}`, mouthMaterial,
      [[0, -0.205, 0.715], [side * 0.055, -0.265, 0.705], [side * 0.13, -0.245, 0.68]], 0.012, 14);
    for (let whisker = 0; whisker < 3; whisker++) {
      const y = -0.15 - whisker * 0.075;
      tube(head, `Whisker_${side}_${whisker}`, furShade,
        [[side * 0.33, y, 0.545], [side * 0.51, y + (whisker - 1) * 0.045, 0.57], [side * 0.66, y + (whisker - 1) * 0.075, 0.55]], 0.006, 18);
    }
  }
  for (let tuft = 0; tuft < 3; tuft++) {
    const plume = new Group();
    plume.name = `Forelock_${tuft + 1}`;
    plume.position.set((tuft - 1) * 0.12, 0.48 - Math.abs(tuft - 1) * 0.045, 0.22);
    plume.rotation.z = (tuft - 1) * -0.22;
    head.add(plume);
    const plumeShape = new Shape();
    plumeShape.moveTo(-0.085, -0.08);
    plumeShape.quadraticCurveTo(-0.09, 0.06, -0.015, 0.22);
    plumeShape.quadraticCurveTo(0.025, 0.3, 0.055, 0.18);
    plumeShape.quadraticCurveTo(0.11, 0.02, 0.085, -0.08);
    plumeShape.quadraticCurveTo(0, -0.12, -0.085, -0.08);
    extruded(plume, `${plume.name}_Fur`, plumeShape, furLight, [0, 0, 0], 0.055, 0.025);
  }

  const body = new Group();
  body.name = 'Body';
  body.position.y = 1.25;
  root.add(body);
  sphere(body, 'Torso_Fur', fur, [0, 0, 0], [0.44, 0.59, 0.34], 28);
  sphere(body, 'Chest_Bib', furLight, [0, 0.02, 0.27], [0.31, 0.48, 0.12], 24);
  sphere(body, 'Belly_Fur', furLight, [0, -0.19, 0.29], [0.29, 0.31, 0.09], 24);

  const legPositions: Point[] = [[-0.22, 0.49, 0.02], [0.22, 0.49, 0.02]];
  for (const [index, position] of legPositions.entries()) {
    const leg = new Group();
    leg.name = index === 0 ? 'Leg_L' : 'Leg_R';
    leg.position.set(...position);
    root.add(leg);
    sphere(leg, `${leg.name}_Fur`, fur, [0, 0, 0], [0.17, 0.38, 0.18], 22);
    const paw = makePaw(leg, `${leg.name}_Paw`, furLight, 1.05);
    paw.position.set(0, -0.33, 0.08);
  }

  const armPositions: Point[] = [[-0.43, 1.35, 0.02], [0.43, 1.35, 0.02]];
  for (const [index, position] of armPositions.entries()) {
    const arm = new Group();
    arm.name = index === 0 ? 'Arm_L' : 'Arm_R';
    arm.position.set(...position);
    arm.rotation.z = index === 0 ? -0.14 : 0.14;
    root.add(arm);
    sphere(arm, `${arm.name}_Upper`, fur, [0, -0.18, 0], [0.15, 0.29, 0.15], 22);
    sphere(arm, `${arm.name}_Cuff`, furLight, [0, -0.39, 0], [0.145, 0.1, 0.15], 20);
    const paw = makePaw(arm, `${arm.name}_Paw`, furLight, 0.94);
    paw.position.set(0, -0.5, 0.03);
  }

  const capeShape = new Shape();
  capeShape.moveTo(-0.29, 0.53);
  capeShape.quadraticCurveTo(-0.53, 0.41, -0.52, 0.04);
  capeShape.lineTo(-0.66, -0.58);
  capeShape.quadraticCurveTo(-0.32, -0.72, -0.08, -0.58);
  capeShape.quadraticCurveTo(0.17, -0.72, 0.65, -0.56);
  capeShape.lineTo(0.51, 0.04);
  capeShape.quadraticCurveTo(0.55, 0.41, 0.29, 0.53);
  capeShape.quadraticCurveTo(0, 0.66, -0.29, 0.53);
  extruded(root, 'Cape_Back', capeShape, cape, [0, 1.24, -0.31], 0.11, 0.035);
  const leftCapeShape = new Shape();
  leftCapeShape.moveTo(-0.29, 0.48);
  leftCapeShape.lineTo(-0.04, 0.4);
  leftCapeShape.lineTo(-0.1, -0.36);
  leftCapeShape.lineTo(-0.51, -0.5);
  leftCapeShape.lineTo(-0.48, 0.02);
  leftCapeShape.quadraticCurveTo(-0.48, 0.35, -0.29, 0.48);
  extruded(root, 'Cape_Front_L', leftCapeShape, capeLight, [-0.01, 1.31, 0.31], 0.06, 0.022);
  const rightCapeShape = new Shape();
  rightCapeShape.moveTo(0.29, 0.48);
  rightCapeShape.lineTo(0.04, 0.4);
  rightCapeShape.lineTo(0.1, -0.36);
  rightCapeShape.lineTo(0.51, -0.5);
  rightCapeShape.lineTo(0.48, 0.02);
  rightCapeShape.quadraticCurveTo(0.48, 0.35, 0.29, 0.48);
  extruded(root, 'Cape_Front_R', rightCapeShape, cape, [0.01, 1.31, 0.315], 0.06, 0.022);
  tube(root, 'Cape_Hem', gold,
    [[-0.59, 0.7, -0.18], [-0.38, 0.62, -0.18], [-0.08, 0.7, -0.18], [0.2, 0.62, -0.18], [0.6, 0.7, -0.18]], 0.014, 36);
  tube(root, 'Cape_Collar', gold, [[-0.29, 1.77, 0.2], [0, 1.84, 0.25], [0.29, 1.77, 0.2]], 0.014, 24);

  const gem = new Group();
  gem.name = 'Gem';
  gem.position.set(0, 1.46, 0.46);
  root.add(gem);
  const gemShape = new Shape();
  gemShape.moveTo(0, 0.16);
  gemShape.lineTo(0.14, 0.02);
  gemShape.lineTo(0.09, -0.17);
  gemShape.lineTo(0, -0.25);
  gemShape.lineTo(-0.09, -0.17);
  gemShape.lineTo(-0.14, 0.02);
  gemShape.closePath();
  extruded(gem, 'Gem_Stone', gemShape, teal, [0, 0, 0], 0.12, 0.018);
  const gemFrame = new Mesh(new TorusGeometry(0.15, 0.018, 8, 24), gold);
  gemFrame.name = 'Gem_Setting';
  gemFrame.position.z = -0.01;
  gem.add(gemFrame);

  const staff = new Group();
  staff.name = 'Staff';
  staff.position.set(0.66, 1.62, 0.22);
  staff.rotation.z = -0.15;
  root.add(staff);
  const shaft = new Mesh(new CylinderGeometry(0.026, 0.038, 1.32, 12), staffWood);
  shaft.name = 'Staff_Shaft';
  shaft.position.y = -0.43;
  shaft.castShadow = true;
  staff.add(shaft);
  const star = extruded(staff, 'Staff_Star', starShape(0.23, 0.1), gold, [0, 0.3, 0], 0.075, 0.018);
  const starGlow = new Mesh(new SphereGeometry(0.07, 16, 10), teal);
  starGlow.name = 'Staff_Star_Gem';
  starGlow.position.set(0, 0.3, 0.065);
  staff.add(starGlow);
  sphere(staff, 'Staff_Grip', bagLight, [0, -1.08, 0], [0.06, 0.08, 0.06], 16);

  const bagGroup = new Group();
  bagGroup.name = 'ShoulderBag';
  bagGroup.position.set(-0.44, 1.35, 0.26);
  root.add(bagGroup);
  tube(bagGroup, 'Bag_Strap', bagLight,
    [[0.35, 0.54, 0.06], [0.16, 0.32, 0.04], [-0.12, -0.08, 0.04], [-0.08, -0.34, 0.04]], 0.035, 28);
  const bagBody = new Group();
  bagBody.name = 'Bag_Body';
  bagBody.position.set(-0.03, -0.33, 0.08);
  bagGroup.add(bagBody);
  sphere(bagBody, 'Bag_SoftBody', bag, [0, 0, 0], [0.25, 0.22, 0.12], 22);
  box(bagBody, 'Bag_Flap', bagLight, [0, 0.15, 0.11], [0.39, 0.08, 0.06]);
  const buckle = new Mesh(new TorusGeometry(0.045, 0.012, 8, 16), gold);
  buckle.name = 'Bag_Buckle';
  buckle.position.set(0, 0.1, 0.16);
  bagBody.add(buckle);

  const tail = new Group();
  tail.name = 'Tail';
  tail.position.set(0.34, 0.93, -0.26);
  root.add(tail);
  tube(tail, 'Tail_Fur', furShade,
    [[0, 0, 0], [0.34, -0.05, -0.02], [0.52, 0.18, -0.03], [0.43, 0.47, 0.02], [0.2, 0.58, 0.08]], 0.13, 32);
  sphere(tail, 'Tail_Tip', furLight, [0.2, 0.58, 0.08], [0.14, 0.13, 0.14], 20);

  const animations = createAnimations();
  return { format: 'procedural-lumi', id: 'lumi', root, animations };
}
