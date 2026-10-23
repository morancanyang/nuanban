import { BufferGeometry, CatmullRomCurve3, Color, ExtrudeGeometry, Float32BufferAttribute, Group,
  Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Shape, SphereGeometry, TorusGeometry,
  TubeGeometry, Vector3 } from 'three';
import type { Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ProceduralModelSource } from './lumi-model';

type Point = [number, number, number];

function sphere(parent: Group, name: string, material: Material, position: Point, scale: Point, segments = 28) {
  const mesh = new Mesh(new SphereGeometry(1, segments, Math.round(segments * 0.7)), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  parent.add(mesh);
  return mesh;
}

function curveGeometry(points: Point[], radius: number, segments = 20, sides = 7) {
  return new TubeGeometry(new CatmullRomCurve3(points.map(point => new Vector3(...point))), segments, radius, sides, false);
}

function tube(parent: Group, name: string, material: Material, points: Point[], radius: number, segments = 20) {
  const mesh = new Mesh(curveGeometry(points, radius, segments), material);
  mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function extrude(parent: Group, name: string, shape: Shape, material: Material, position: Point, depth: number, bevel = 0.018) {
  const mesh = new Mesh(new ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: bevel,
    bevelThickness: bevel, curveSegments: 16,
  }), material);
  mesh.name = name;
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

function antler(parent: Group, side: number, material: Material) {
  const group = new Group();
  group.name = side < 0 ? 'Antler_L' : 'Antler_R';
  group.position.set(side * 0.31, 0.52, -0.12);
  parent.add(group);
  const branches: Point[][] = [
    [[0, 0, 0], [side * 0.02, 0.23, 0], [side * 0.04, 0.49, -0.015], [side * 0.015, 0.82, -0.025]],
    [[side * 0.025, 0.3, 0], [side * 0.17, 0.4, 0.015], [side * 0.29, 0.57, 0.015]],
    [[side * 0.035, 0.46, -0.01], [-side * 0.085, 0.52, 0.025], [-side * 0.15, 0.65, 0.03]],
  ];
  branches.forEach((points, index) => {
    const curve = new CatmullRomCurve3(points.map(point => new Vector3(...point)));
    const geometry = new TubeGeometry(curve, 24, index === 0 ? 0.067 : 0.057, 10, false);
    const position = geometry.getAttribute('position');
    for (let ring = 0; ring <= 24; ring++) {
      const center = curve.getPointAt(ring / 24);
      const taper = 1 - ring / 24 * 0.65;
      for (let radial = 0; radial <= 10; radial++) {
        const vertex = ring * 11 + radial;
        position.setXYZ(vertex,
          center.x + (position.getX(vertex) - center.x) * taper,
          center.y + (position.getY(vertex) - center.y) * taper,
          center.z + (position.getZ(vertex) - center.z) * taper);
      }
    }
    geometry.computeVertexNormals();
    const mesh = new Mesh(geometry, material);
    mesh.name = `${group.name}_Branch_${index + 1}`;
    group.add(mesh);
    const radius = (index === 0 ? 0.067 : 0.057) * 0.35;
    sphere(group, `${group.name}_Tip_${index + 1}`, material, points[points.length - 1], [radius, radius, radius], 16);
  });
  sphere(group, `${group.name}_Root`, material, [0, 0.025, 0], [0.085, 0.07, 0.08], 20);
}

function ear(parent: Group, side: number, fur: Material, inner: Material, rim: Material) {
  const group = new Group();
  group.name = side < 0 ? 'Ear_L' : 'Ear_R';
  group.position.set(side * 0.58, 0.31, -0.055);
  group.rotation.z = -side * 0.87;
  group.rotation.y = side * 0.12;
  parent.add(group);
  const shell = new Shape();
  shell.moveTo(0, -0.035);
  shell.bezierCurveTo(-0.3, 0.025, -0.32, 0.43, 0, 0.78);
  shell.bezierCurveTo(0.32, 0.43, 0.3, 0.025, 0, -0.035);
  extrude(group, `${group.name}_Shell`, shell, fur, [0, 0, -0.035], 0.075, 0.035);
  const inset = new Shape();
  inset.moveTo(0, 0.07);
  inset.bezierCurveTo(-0.205, 0.11, -0.22, 0.38, 0, 0.66);
  inset.bezierCurveTo(0.22, 0.38, 0.205, 0.11, 0, 0.07);
  extrude(group, `${group.name}_Inner`, inset, inner, [0, 0, 0.05], 0.018, 0.018);
  tube(group, `${group.name}_Fold`, rim, [[0, 0.08, 0.079], [0.12, 0.2, 0.078], [0.11, 0.39, 0.076]], 0.009, 14);
}

function irisFibers(parent: Group, material: Material) {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const gold = new Color(0xe7ad48);
  const brown = new Color(0x98602d);
  for (let fiber = 0; fiber < 40; fiber++) {
    const color = fiber % 3 === 0 ? brown : gold;
    const start = positions.length / 3;
    for (let step = 0; step <= 3; step++) {
      const radius = 0.5 + step / 3 * 0.44;
      for (const edge of [-1, 1]) {
        const angle = fiber / 40 * Math.PI * 2 + edge * 0.012 + Math.sin(fiber * 2) * step * 0.004;
        positions.push(Math.cos(angle) * 0.127 * radius, Math.sin(angle) * 0.17 * radius,
          0.115 + 0.045 * Math.sqrt(1 - radius * radius) + 0.002);
        colors.push(color.r, color.g, color.b);
      }
      if (step < 3) {
        const vertex = start + step * 2;
        indices.push(vertex, vertex + 2, vertex + 1, vertex + 1, vertex + 2, vertex + 3);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new Mesh(geometry, material);
  mesh.name = `${parent.name}_Iris_Fibers`;
  parent.add(mesh);
}

function scarf(parent: Group) {
  const gold = new MeshStandardMaterial({ color: 0xeeb550, roughness: 0.92 });
  const orange = new MeshStandardMaterial({ color: 0xd87b32, roughness: 0.92 });
  const thread = new MeshStandardMaterial({ color: 0xc38d43, roughness: 1 });
  const collarMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const collar = new Group();
  collar.name = 'Scarf_Collar';
  collar.position.set(0, 1.47, 0.005);
  collar.scale.set(1.08, 1, 0.76);
  parent.add(collar);
  const geometry = new TorusGeometry(0.48, 0.115, 20, 64);
  const colors: number[] = [];
  const position = geometry.getAttribute('position');
  const yellow = new Color(0xf3be5b);
  const rust = new Color(0xd77c35);
  for (let vertex = 0; vertex < position.count; vertex++) {
    const height = position.getZ(vertex);
    const color = Math.abs(height) < 0.041 || height > 0.09 ? yellow : rust;
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const wrap = new Mesh(geometry, collarMaterial);
  wrap.name = 'Scarf_Soft_Wrap';
  wrap.rotation.x = Math.PI / 2;
  collar.add(wrap);
  const ribs: BufferGeometry[] = [];
  for (let stitch = 0; stitch < 64; stitch++) {
    const angle = stitch / 64 * Math.PI * 2;
    ribs.push(curveGeometry([-0.76, -0.35, 0, 0.35, 0.76].map((latitude, index) => {
      const radius = 0.48 + 0.117 * Math.cos(latitude);
      const offset = angle + (index % 2 ? 0.008 : -0.008);
      return [Math.cos(offset) * radius, Math.sin(latitude) * 0.117, Math.sin(offset) * radius];
    }), 0.003, 6, 4));
  }
  const ribGeometry = mergeGeometries(ribs)!;
  ribs.forEach(value => value.dispose());
  const ribMesh = new Mesh(ribGeometry, thread);
  ribMesh.name = 'Scarf_Collar_Knit';
  collar.add(ribMesh);
  const tail = new Group();
  tail.name = 'Scarf_Tail';
  tail.position.set(0.26, 1.43, 0.365);
  tail.rotation.z = -0.065;
  parent.add(tail);
  const outline = new Shape();
  outline.moveTo(-0.105, 0);
  outline.quadraticCurveTo(0, 0.035, 0.105, 0);
  outline.lineTo(0.102, -0.79);
  outline.quadraticCurveTo(0, -0.83, -0.105, -0.79);
  outline.closePath();
  const clothDepth = 0.075;
  const clothBevel = 0.018;
  const clothFront = clothDepth + clothBevel;
  extrude(tail, 'Scarf_Draped_Cloth', outline, gold, [0, 0, 0], clothDepth, clothBevel);
  for (let stripe = 0; stripe < 3; stripe++) {
    const shape = new Shape();
    shape.moveTo(-0.105, 0);
    shape.lineTo(0.105, 0);
    shape.lineTo(0.105, -0.09);
    shape.lineTo(-0.105, -0.09);
    shape.closePath();
    extrude(tail, `Scarf_Stripe_${stripe + 1}`, shape, orange, [0, -0.08 - stripe * 0.26, clothFront + 0.004], 0.002, 0.003);
  }
  const stitches: BufferGeometry[] = [];
  for (let row = 0; row < 28; row++) {
    for (let column = 0; column < 7; column++) {
      const centerX = (column - 3) * 0.027;
      const centerY = -0.025 - row * 0.028;
      stitches.push(curveGeometry([[centerX - 0.01, centerY, clothFront + 0.015],
        [centerX, centerY - 0.016, clothFront + 0.018], [centerX + 0.01, centerY, clothFront + 0.015]], 0.002, 4, 4));
    }
  }
  const stitchGeometry = mergeGeometries(stitches)!;
  stitches.forEach(value => value.dispose());
  const knit = new Mesh(stitchGeometry, thread);
  knit.name = 'Scarf_Tail_Knit';
  tail.add(knit);
  for (let fringe = 0; fringe < 9; fringe++) {
    const positionX = (fringe - 4) * 0.024;
    tube(tail, `Scarf_Fringe_${fringe + 1}`, gold,
      [[positionX, -0.795, 0.04], [positionX + 0.003, -0.84, 0.045], [positionX - 0.003, -0.875, 0.04]], 0.0055, 8);
  }
}

export function createLiliModel(): ProceduralModelSource {
  const root = new Group();
  root.name = 'LiliDeer';
  const fur = new MeshStandardMaterial({ color: 0xc48750, roughness: 0.86 });
  const cream = new MeshStandardMaterial({ color: 0xf4e3c6, roughness: 0.94 });
  const innerEar = new MeshStandardMaterial({ color: 0xe6bc90, roughness: 0.9 });
  const tan = new MeshStandardMaterial({ color: 0xbd9167, roughness: 0.76 });
  const brown = new MeshStandardMaterial({ color: 0x69462d, roughness: 0.72 });
  const hoof = new MeshStandardMaterial({ color: 0xa36a40, roughness: 0.82 });
  const nose = new MeshPhysicalMaterial({ color: 0x573627, roughness: 0.27, clearcoat: 0.45 });
  const socket = new MeshStandardMaterial({ color: 0x67452b, roughness: 0.65 });
  const eyeWhite = new MeshStandardMaterial({ color: 0xe9d3a6, roughness: 0.4 });
  const amber = new MeshPhysicalMaterial({ color: 0xb88332, roughness: 0.3, clearcoat: 0.6 });
  const pupil = new MeshPhysicalMaterial({ color: 0x1b1714, roughness: 0.12, clearcoat: 1 });
  const fibers = new MeshStandardMaterial({ vertexColors: true, roughness: 0.48 });
  const cornea = new MeshPhysicalMaterial({ color: 0xfff4dd, roughness: 0.05, clearcoat: 1,
    transparent: true, opacity: 0.1, depthWrite: false });
  const highlight = new MeshStandardMaterial({ color: 0xfffbef, emissive: 0x756e58, roughness: 0.16 });
  const blush = new MeshStandardMaterial({ color: 0xd89771, roughness: 1 });

  const body = sphere(root, 'Body', fur, [0, 0.97, 0], [0.51, 0.67, 0.375], 40);
  const bodyPosition = body.geometry.getAttribute('position');
  for (let vertex = 0; vertex < bodyPosition.count; vertex++) {
    const height = bodyPosition.getY(vertex);
    const width = 1 - Math.max(0, height) * 0.22;
    bodyPosition.setX(vertex, bodyPosition.getX(vertex) * width);
    bodyPosition.setZ(vertex, bodyPosition.getZ(vertex) * width);
  }
  body.geometry.computeVertexNormals();
  sphere(root, 'Belly_Cream', cream, [0, 0.94, 0.285], [0.325, 0.47, 0.108], 36);
  for (const side of [-1, 1]) {
    const label = side < 0 ? 'L' : 'R';
    const arm = sphere(root, `Arm_${label}`, fur, [side * 0.445, 1.06, 0.015], [0.155, 0.345, 0.165]);
    arm.rotation.z = side * 0.16;
    sphere(root, `Hand_${label}`, fur, [side * 0.495, 0.81, 0.065], [0.162, 0.185, 0.18]);
    tube(root, `Hand_${label}_Crease`, hoof,
      [[side * 0.48, 0.753, 0.225], [side * 0.5, 0.735, 0.224], [side * 0.52, 0.74, 0.216]], 0.0045, 10);
    sphere(root, `Leg_${label}`, fur, [side * 0.245, 0.34, 0.015], [0.19, 0.225, 0.185]);
    sphere(root, `Hoof_${label}`, hoof, [side * 0.245, 0.155, 0.105], [0.212, 0.126, 0.217]);
    tube(root, `Hoof_${label}_Split`, brown,
      [[side * 0.245, 0.227, 0.281], [side * 0.245, 0.167, 0.322], [side * 0.245, 0.091, 0.292]], 0.006, 12);
    for (let spot = 0; spot < 3; spot++) {
      const patch = sphere(root, `Back_Spot_${label}_${spot + 1}`, cream,
        [side * (0.235 + (spot % 2) * 0.065), 1.21 - spot * 0.145, -0.29], [0.039, 0.055, 0.017], 16);
      patch.rotation.y = -side * 0.5;
    }
  }
  const tail = new Group();
  tail.name = 'Tail';
  tail.position.set(0.02, 0.78, -0.33);
  tail.rotation.x = -0.28;
  root.add(tail);
  sphere(tail, 'Tail_Fur', fur, [0, 0.045, -0.1], [0.15, 0.19, 0.225]);
  sphere(tail, 'Tail_Cream_Tip', cream, [0, 0.095, -0.25], [0.112, 0.127, 0.098], 24);

  const head = new Group();
  head.name = 'LiliHead';
  head.position.set(0, 1.98, 0);
  root.add(head);
  sphere(head, 'Head_Fur', fur, [0, 0, 0], [0.76, 0.655, 0.52], 48);
  sphere(head, 'Muzzle_Cream', cream, [0, -0.31, 0.435], [0.325, 0.224, 0.156], 36);
  sphere(head, 'Nose', nose, [0, -0.225, 0.578], [0.096, 0.072, 0.061], 32);
  tube(head, 'Mouth_Center', brown, [[0, -0.28, 0.61], [0, -0.32, 0.597], [0, -0.355, 0.591]], 0.008, 10);
  for (const side of [-1, 1]) {
    const label = side < 0 ? 'L' : 'R';
    ear(head, side, fur, innerEar, tan);
    antler(head, side, tan);
    tube(head, `Smile_${label}`, brown,
      [[0, -0.355, 0.591], [side * 0.052, -0.386, 0.581], [side * 0.112, -0.37, 0.571]], 0.008, 18);
    const eye = new Group();
    eye.name = `Eye_${label}`;
    eye.position.set(side * 0.285, 0.025, 0.475);
    eye.rotation.y = side * 0.12;
    head.add(eye);
    sphere(eye, `${eye.name}_Socket`, socket, [0, 0, 0.012], [0.172, 0.218, 0.084], 32);
    sphere(eye, `${eye.name}_Globe`, eyeWhite, [0, 0, 0.052], [0.145, 0.19, 0.076], 32);
    sphere(eye, `${eye.name}_Amber_Iris`, amber, [0, 0, 0.115], [0.127, 0.17, 0.045], 36);
    irisFibers(eye, fibers);
    sphere(eye, `${eye.name}_Pupil`, pupil, [0, -0.003, 0.151], [0.071, 0.113, 0.025], 32);
    sphere(eye, `${eye.name}_Cornea`, cornea, [0, 0, 0.108], [0.14, 0.186, 0.073], 32);
    const catchlight = sphere(eye, `${eye.name}_Catchlight`, highlight, [-0.045, 0.095, 0.172], [0.025, 0.046, 0.009], 20);
    catchlight.rotation.z = -0.28;
    sphere(eye, `${eye.name}_Highlight`, highlight, [0.04, 0.04, 0.179], [0.011, 0.014, 0.006], 16);
    tube(eye, `${eye.name}_Soft_Lid`, fur,
      [[-0.157, -0.033, 0.051], [-0.14, 0.13, 0.043], [0, 0.211, 0.027], [0.14, 0.13, 0.043], [0.157, -0.033, 0.051]], 0.014, 28);
    tube(head, `Brow_${label}`, brown,
      [[side * 0.18, 0.293, 0.457], [side * 0.275, 0.322, 0.449], [side * 0.38, 0.285, 0.425]], 0.015, 20);
    sphere(head, `Cheek_${label}`, blush, [side * 0.475, -0.19, 0.403], [0.09, 0.036, 0.018], 24);
  }
  scarf(root);
  return { format: 'procedural-lili', id: 'lili', root, animations: [] };
}
