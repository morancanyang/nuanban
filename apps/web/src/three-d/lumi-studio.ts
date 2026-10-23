import { AgXToneMapping, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial, PMREMGenerator } from 'three';
import type { Object3D, Scene, WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const sourceHash = 'ffe061fc3b5a4e72e18373823063d71bc239b8440b6a888f69af53a0743a9ada';

export function isOriginalLumi(root: Object3D): boolean {
  return root.getObjectByName('Microglow_Original_Cat')?.userData.source_blend_sha256 === sourceHash;
}

export function createLumiStudio(scene: Scene, renderer: WebGLRenderer, root: Object3D): { dispose(): void } | undefined {
  if (!isOriginalLumi(root)) return;
  scene.traverse(object => {
    if (object instanceof HemisphereLight) object.intensity = 0.32;
    if (object instanceof DirectionalLight) {
      object.intensity = 1.6;
      object.color.set(0xfff3e5);
      object.position.set(-3, 4, 5);
    }
  });
  const environment = new RoomEnvironment();
  const generator = new PMREMGenerator(renderer);
  let target: ReturnType<PMREMGenerator['fromScene']>;
  try { target = generator.fromScene(environment, 0.035); }
  finally { environment.dispose(); generator.dispose(); }
  scene.environment = target.texture;
  scene.environmentIntensity = 0.42;
  renderer.toneMapping = AgXToneMapping;
  const fill = new DirectionalLight(0xd8e8ff, 0.32);
  fill.position.set(4, 1, 3);
  const rim = new DirectionalLight(0xffedda, 0.8);
  rim.position.set(2, 3, -4);
  scene.add(fill, rim);
  const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof MeshStandardMaterial)) continue;
      for (const texture of [material.map, material.normalMap, material.aoMap]) {
        if (!texture || texture.anisotropy === anisotropy) continue;
        texture.anisotropy = anisotropy;
        texture.needsUpdate = true;
      }
    }
  });
  renderer.domElement.dataset.appearanceProfile = 'lumi-original-detail-v2.1';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  let disposed = false;
  return { dispose() {
    if (disposed) return;
    disposed = true;
    if (scene.environment === target.texture) scene.environment = null;
    target.dispose();
    scene.remove(fill, rim);
  } };
}
