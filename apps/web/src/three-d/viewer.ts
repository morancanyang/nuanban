import { ACESFilmicToneMapping, AnimationMixer, Bone, Box3, DirectionalLight, Group, HemisphereLight, LoadingManager,
  Mesh, PerspectiveCamera, Scene, SRGBColorSpace, Texture, Vector3, WebGLRenderer } from 'three';
import type { AnimationClip, BufferAttribute, InterleavedBufferAttribute, Material, Object3D, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import type { ModelSource, ModelSummary } from '../local-model';
import { createModelAnimationController } from './animation-controller';
import type { ProceduralModelSource } from './lumi-model';

export type DisplayModelSource = ModelSource | ProceduralModelSource;
interface LoadedModel { root: Object3D; animations: AnimationClip[]; vrm?: VRM; summary: ModelSummary; urls: Set<string>; }

function materialTextures(material: Material): Texture[] {
  const result = new Set<Texture>();
  for (const value of Object.values(material)) if (value instanceof Texture) result.add(value);
  const uniforms = (material as Material & { uniforms?: Record<string, { value?: unknown }> }).uniforms;
  for (const uniform of Object.values(uniforms ?? {})) if (uniform.value instanceof Texture) result.add(uniform.value);
  return [...result];
}

function disposeRoot(root: Object3D) {
  const textures = new Set<Texture>();
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const texture of materialTextures(material)) textures.add(texture);
      material.dispose();
    }
    (object as SkinnedMesh).skeleton?.dispose();
  });
  for (const texture of textures) { texture.dispose(); (texture.source.data as { close?: () => void } | undefined)?.close?.(); }
}

export function inspectRenderedModel(root: Object3D, animations: AnimationClip[]): ModelSummary {
  let triangles = 0;
  let meshes = 0;
  let bones = 0;
  let decodedBytes = 1;
  let nodes = 0;
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const arrays = new Set<ArrayBufferLike>();
  const addAttribute = (attribute: BufferAttribute | InterleavedBufferAttribute) => {
    const array = 'data' in attribute ? attribute.data.array : attribute.array;
    if (!arrays.has(array.buffer)) { arrays.add(array.buffer); decodedBytes += array.buffer.byteLength; }
    for (const value of array) if (!Number.isFinite(value)) throw new Error('模型包含无效的顶点或骨骼数值');
  };
  root.traverse(object => {
    if (++nodes > 2048) throw new Error('模型节点超过 2048 个，请简化层级');
    if (object instanceof Bone) bones++;
    if (!(object instanceof Mesh)) return;
    meshes++;
    const position = object.geometry.getAttribute('position');
    if (!position) throw new Error('模型网格缺少顶点');
    triangles += (object.geometry.index?.count ?? position.count) / 3;
    for (const attribute of Object.values(object.geometry.attributes) as (BufferAttribute | InterleavedBufferAttribute)[]) addAttribute(attribute);
    for (const attributes of Object.values(object.geometry.morphAttributes) as (BufferAttribute | InterleavedBufferAttribute)[][]) for (const attribute of attributes ?? []) addAttribute(attribute);
    if (object.geometry.index) addAttribute(object.geometry.index);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const texture of materialTextures(material)) textures.add(texture);
    }
  });
  const dimensions = [...textures].map(texture => {
    const image = texture.image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | undefined;
    const width = image?.width ?? image?.naturalWidth ?? 0;
    const height = image?.height ?? image?.naturalHeight ?? 0;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error('模型纹理未能读取或超过 2048 × 2048');
    decodedBytes += width * height * 4 * 2;
    return { width, height };
  });
  for (const clip of animations) {
    if (!Number.isFinite(clip.duration) || clip.duration < 0 || clip.duration > 3600 || clip.tracks.length > 4096) throw new Error('模型动画长度或轨道数量超限');
    for (const track of clip.tracks) {
      if (track.times.length > 1000000 || track.values.length > 4000000) throw new Error('模型动画关键帧超限');
      for (const value of track.times) if (!Number.isFinite(value)) throw new Error('模型动画时间无效');
      for (const value of track.values) if (!Number.isFinite(value)) throw new Error('模型动画数值无效');
      decodedBytes += track.times.byteLength + track.values.byteLength;
    }
  }
  if (!Number.isInteger(triangles) || triangles < 1 || triangles > 100000 || meshes > 512 || bones > 512 || materials.size > 256 || dimensions.length > 128 || animations.length > 64 || decodedBytes > 256 * 1024 * 1024) throw new Error('模型面数、骨骼或解码资源超限，请简化后重试');
  return { triangles, meshes, bones, animations: animations.length, decodedBytes, textures: dimensions };
}

async function loadModel(source: DisplayModelSource): Promise<LoadedModel> {
  if (source.format === 'procedural-lumi' || source.format === 'procedural-lili') {
    try {
      return { root: source.root, animations: source.animations, summary: inspectRenderedModel(source.root, source.animations), urls: new Set() };
    } catch (error) { disposeRoot(source.root); throw error; }
  }
  const manager = new LoadingManager();
  const urls = new Set<string>();
  let failed = false;
  manager.setURLModifier(url => {
    if (url.startsWith('blob:')) { urls.add(url); return url; }
    if (/^data:(?:image\/(?:png|jpeg|webp)|application\/octet-stream);base64,/.test(url)) return url;
    throw new Error('模型引用了外部纹理或文件，请内嵌后重新导入');
  });
  const resourcesReady = new Promise<void>(resolve => { manager.onLoad = resolve; manager.onError = () => { failed = true; }; });
  manager.itemStart('nuanban-local-model');
  const bytes = new Uint8Array(source.bytes).buffer;
  let root: Object3D | undefined;
  try {
    let animations: AnimationClip[];
    let vrm: VRM | undefined;
    if (source.format === 'fbx') {
      root = new FBXLoader(manager).parse(bytes, '');
      animations = root.animations;
    } else {
      const loader = new GLTFLoader(manager);
      loader.register(parser => new VRMLoaderPlugin(parser));
      const result = await loader.parseAsync(bytes, '');
      root = result.scene;
      animations = result.animations;
      vrm = result.userData.vrm as VRM | undefined;
      if (source.format === 'vrm' && !vrm) throw new Error('VRM 人形描述未能加载，请检查版本和骨骼');
      if (vrm) VRMUtils.rotateVRM0(vrm);
    }
    manager.itemEnd('nuanban-local-model');
    await resourcesReady;
    if (failed) throw new Error('模型纹理加载失败，请将图片内嵌后重新导入');
    root.updateMatrixWorld(true);
    const summary = inspectRenderedModel(root, animations);
    return { root, animations, vrm, summary, urls };
  } catch (error) {
    if (root) disposeRoot(root);
    for (const url of urls) URL.revokeObjectURL(url);
    throw error;
  }
}

export async function createModelView(container: HTMLElement, source: DisplayModelSource, options: { interactive?: boolean; animate?: boolean; onError?: (message: string) => void; onAnimationChange?: (name: string) => void } = {}) {
  const loaded = await loadModel(source);
  let renderer: WebGLRenderer;
  try { renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); }
  catch { disposeRoot(loaded.root); for (const url of loaded.urls) URL.revokeObjectURL(url); throw new Error('这台电脑的 3D 渲染不可用，请更新显卡驱动或继续使用原画桌宠'); }
  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.01, 100);
  const group = new Group();
  const mixer = new AnimationMixer(loaded.root);
  const animations = createModelAnimationController(mixer, loaded.animations, name => {
    renderer.domElement.dataset.animation = name;
    options.onAnimationChange?.(name);
  });
  let disposed = false;
  let frame = 0;
  let previousTime = 0;
  let controls: OrbitControls | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let shaderFailed = false;
  renderer.debug.onShaderError = () => { shaderFailed = true; };
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.domElement.setAttribute('aria-label', '本地 3D 模型预览');
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.dataset.renderSource = source.format;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
    controls?.dispose();
    animations.dispose();
    mixer.stopAllAction();
    mixer.uncacheRoot(loaded.root);
    disposeRoot(loaded.root);
    for (const url of loaded.urls) URL.revokeObjectURL(url);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  try {
    const bounds = new Box3().setFromObject(loaded.root);
    const center = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    if (![center.x, center.y, center.z, longest].every(Number.isFinite) || longest < 0.000001) throw new Error('模型没有可见的有效尺寸');
    group.add(loaded.root);
    group.scale.setScalar(2 / longest);
    group.position.copy(center).multiplyScalar(-2 / longest);
    scene.add(group, new HemisphereLight(0xfff4e2, 0x746861, 2.8));
    const light = new DirectionalLight(0xffffff, 3.2);
    light.position.set(3, 4, 5);
    scene.add(light);
    camera.position.set(options.interactive ? 1.6 : 0, 0.3, 4.4);
    camera.lookAt(0, 0, 0);
    if (options.interactive) {
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.enablePan = false;
      controls.minDistance = 2.2;
      controls.maxDistance = 9;
    }
    if (animations.defaultName && options.animate !== false && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) animations.play(animations.defaultName);
    container.append(renderer.domElement);
    function resize() {
      const width = container.clientWidth || 300;
      const height = container.clientHeight || 320;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.position.z = Math.max(4.4, 4.4 / camera.aspect);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
    }
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();
    renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      if (!disposed) { options.onError?.('3D 显示已暂停，暂时使用原画或内置桌宠；请重新导入重试'); dispose(); }
    });
    loaded.vrm?.update(0);
    renderer.render(scene, camera);
    if (shaderFailed) throw new Error('模型材质未能在这台电脑渲染，请转换为标准材质后重试');
    const context = renderer.getContext();
    const pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
    context.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    let visible = false;
    for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset] > 8) { visible = true; break; }
    if (!visible) throw new Error('模型首帧没有可见图形，请检查材质透明度、网格和显卡支持');
    function draw(time: number) {
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      if (document.hidden || time - previousTime < 1000 / 30) return;
      const delta = previousTime ? Math.min((time - previousTime) / 1000, 0.1) : 0;
      previousTime = time;
      try { mixer.update(delta); loaded.vrm?.update(delta); controls?.update(); renderer.render(scene, camera); }
      catch { options.onError?.('3D 渲染未能继续，已保留原画和本机模型'); dispose(); }
    }
    if (options.animate !== false) frame = requestAnimationFrame(draw);
    return { summary: loaded.summary, canvas: renderer.domElement, animationNames: animations.names, playAnimation: animations.play, dispose };
  } catch (error) { dispose(); throw error; }
}
