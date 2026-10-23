// 独立桌宠悬浮层的实时 3D 页面脚本（spike b：受控 WebView + three.js）。
//
// 与桌面端保持一致的部分：同一 three.js 版本（0.186.1，随包内嵌）、同一 GLTFLoader、
// 同一份随包 GLB 与 SHA-256 摘要，以及和 apps/web/src/three-d/viewer.ts 相同的加载策略
// （LoadingManager 只允许 blob:/data: 本地资源，出现外部贴图即失败）与渲染设置
// （alpha 透明、antialias、low-power、pixelRatio 上限 1.5、SRGB + ACESFilmic、Box 归一化取景）。
//
// 与 Android 侧的契约：全局 nuanbanPet3d 桥只有三个方法 —— ready(摘要) / failed(短代码) / stats(...)。
// 页面不做任何网络访问：模型与脚本都来自合成 https 源，且本文件内不出现外部主机名。

import {
  ACESFilmicToneMapping, AnimationMixer, Box3, DirectionalLight, Group, HemisphereLight,
  LoadingManager, LoopRepeat, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from './loaders/GLTFLoader.js';

const MODEL_URL = new URL('../models/lumi/Lumi_Magical_Kitten.glb', import.meta.url);
const MODEL_SHA256 = '3ec165a265d28d00bec78c6262d4909542d9d5e8759759cc00cdb07fd7f95f90';
const MODEL_ID = 'lumi';
const STATS_WINDOW_MS = 5000;

const bridge = globalThis.nuanbanPet3d;
let reported = false;

function reportFailure(code) {
  if (reported) return;
  reported = true;
  try { bridge?.failed(code); } catch { /* 桥不可用时只能静默失败，Android 侧还有 watchdog */ }
}

function hexDigest(buffer) {
  return crypto.subtle.digest('SHA-256', buffer).then(digest =>
    Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''));
}

async function loadModelBytes() {
  const response = await fetch(MODEL_URL, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error('page_model_http_' + response.status);
  return response.arrayBuffer();
}

function createManager() {
  const manager = new LoadingManager();
  let failed = false;
  manager.setURLModifier(url => {
    if (url.startsWith('blob:')) return url;
    if (/^data:(?:image\/(?:png|jpeg|webp)|application\/octet-stream);base64,/.test(url)) return url;
    failed = true;
    throw new Error('page_external_texture_rejected');
  });
  return { manager, hasFailed: () => failed };
}

function frameLoop(renderer, scene, camera, mixer, onFirstFrame, onContextLost) {
  const deltas = [];
  const startedAt = performance.now();
  let windowStart = startedAt;
  let previous = startedAt;
  let frames = 0;
  let worstFrameMs = 0;
  let first = true;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function tick(now) {
    const deltaMs = Math.min(now - previous, 100);
    previous = now;
    worstFrameMs = Math.max(worstFrameMs, deltaMs);
    deltas.push(deltaMs);
    frames += 1;
    try {
      mixer?.update(Math.min(deltaMs / 1000, 0.1));
      renderer.render(scene, camera);
    } catch {
      onContextLost('page_render_failed');
      return;
    }
    if (first) {
      first = false;
      onFirstFrame();
    }
    if (now - windowStart >= STATS_WINDOW_MS) {
      const sorted = [...deltas].sort((a, b) => a - b);
      const span = sorted.reduce((sum, value) => sum + value, 0);
      const averageFps = span > 0 ? (sorted.length * 1000) / span : 0;
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      try { bridge?.stats(frames, Number(averageFps.toFixed(1)), Number(p95.toFixed(1)), Number(worstFrameMs.toFixed(1))); } catch { /* 忽略 */ }
      frames = 0;
      worstFrameMs = 0;
      deltas.length = 0;
      windowStart = now;
    }
    requestAnimationFrame(tick);
  }

  if (!reducedMotion) requestAnimationFrame(tick);
  return { reducedMotion };
}

async function start() {
  const { manager, hasFailed } = createManager();
  const bytes = await loadModelBytes();
  const digest = await hexDigest(bytes);
  if (digest !== MODEL_SHA256) throw new Error('page_model_digest_mismatch');

  const loader = new GLTFLoader(manager);
  const gltf = await loader.parseAsync(bytes, '');
  if (hasFailed()) throw new Error('page_external_texture_rejected');

  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  let shaderFailed = false;
  renderer.debug.onShaderError = () => { shaderFailed = true; };

  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.01, 100);
  const group = new Group();
  const root = gltf.scene;
  const bounds = new Box3().setFromObject(root);
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (![center.x, center.y, center.z, longest].every(Number.isFinite) || longest < 0.000001) throw new Error('page_model_bounds_invalid');
  group.add(root);
  group.scale.setScalar(2 / longest);
  group.position.copy(center).multiplyScalar(-2 / longest);
  scene.add(group, new HemisphereLight(0xfff4e2, 0x746861, 2.8));
  const light = new DirectionalLight(0xffffff, 3.2);
  light.position.set(3, 4, 5);
  scene.add(light);

  const mixer = new AnimationMixer(root);
  const clips = gltf.animations ?? [];
  const clip = clips.find(item => item.name === 'idle') ?? clips[0];
  if (clip) {
    mixer.clipAction(clip).reset().setLoop(LoopRepeat, Infinity).play();
  }
  let meshCount = 0;
  root.traverse(object => { if (object.isMesh) meshCount += 1; });

  const stage = document.getElementById('pet3d-stage');
  stage.replaceWith(renderer.domElement);
  renderer.domElement.id = 'pet3d-stage';

  function resize() {
    const width = Math.max(1, window.innerWidth || 88);
    const height = Math.max(1, window.innerHeight || 123);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.position.set(0, 0.3, Math.max(4.4, 4.4 / camera.aspect));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  let stopped = false;
  const stop = reason => {
    if (stopped) return;
    stopped = true;
    reportFailure(reason);
  };
  renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); stop('page_context_lost'); });
  window.addEventListener('unhandledrejection', () => stop('page_promise_rejection'));
  window.addEventListener('error', () => stop('page_uncaught_error'));

  const loop = frameLoop(renderer, scene, camera, mixer, () => {
    if (shaderFailed) { stop('page_shader_failed'); return; }
    // 就绪判据不只看"页面加载完成"：再确认这一帧真的画出了不透明像素。
    try {
      const context = renderer.getContext();
      const pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
      context.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      let visible = false;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 0) { visible = true; break; }
      }
      if (!visible) { stop('page_blank_frame'); return; }
    } catch {
      stop('page_frame_probe_failed');
      return;
    }
    if (reported) return;
    reported = true;
    const summary = 'model_' + MODEL_ID + '_bytes_' + bytes.byteLength + '_meshes_' + meshCount +
      '_clips_' + clips.length + '_clip_' + (clip ? clip.name : 'none') + '_motion_' + (loop.reducedMotion ? 'reduced' : 'full');
    try { bridge?.ready(summary); } catch { /* 忽略 */ }
  }, stop);

  if (loop.reducedMotion && !reported) {
    // 系统要求减少动态效果时只渲染一帧静态形象，并如实说明没有循环动画。
    renderer.render(scene, camera);
    reported = true;
    try { bridge?.ready('model_' + MODEL_ID + '_bytes_' + bytes.byteLength + '_meshes_' + meshCount + '_clips_' + clips.length + '_motion_reduced'); } catch { /* 忽略 */ }
  }
}

start().catch(error => {
  const code = typeof error?.message === 'string' && /^page_[a-z0-9_]+$/.test(error.message) ? error.message : 'page_start_failed';
  reportFailure(code);
});