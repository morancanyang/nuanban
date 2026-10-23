import { AgXToneMapping, BoxGeometry, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial, Scene, Texture } from 'three';
import type { WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLumiStudio, isOriginalLumi } from '../../apps/web/src/three-d/lumi-studio';

const gpu = vi.hoisted(() => ({ fromScene: vi.fn(), dispose: vi.fn() }));
vi.mock('three', async importOriginal => {
  const original = await importOriginal<typeof import('three')>();
  return { ...original, PMREMGenerator: class { fromScene = gpu.fromScene; dispose = gpu.dispose; } };
});

function originalCat() {
  const root = new Group();
  root.name = 'Microglow_Original_Cat';
  root.userData.source_blend_sha256 = 'ffe061fc3b5a4e72e18373823063d71bc239b8440b6a888f69af53a0743a9ada';
  return root;
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe('原版小猫的透明实时材质预览', () => {
  it('仅识别原版工程来源，不凭同名套用到个人模型或其他角色', () => {
    const root = new Group();
    root.name = 'Microglow_Original_Cat';
    expect(isOriginalLumi(root)).toBe(false);
    expect(isOriginalLumi(originalCat())).toBe(true);
    expect(createLumiStudio(new Scene(), {} as WebGLRenderer, root)).toBeUndefined();
    expect(gpu.fromScene).not.toHaveBeenCalled();
  });

  it('匹配原版 AgX、眼睛反射与柔和主辅光，不启用产生毛卡闪点的覆盖混合或添加背景', () => {
    vi.stubGlobal('window', { devicePixelRatio: 3 });
    const texture = new Texture();
    const release = vi.fn();
    gpu.fromScene.mockReturnValue({ texture, dispose: release });
    const scene = new Scene();
    const hemisphere = new HemisphereLight(0xffffff, 0x444444, 2.8);
    const key = new DirectionalLight(0xffffff, 3.2);
    scene.add(hemisphere, key);
    const root = originalCat();
    const irisMap = new Texture();
    const groom = new MeshStandardMaterial({ name: 'Microglow real-time groom cards', map: irisMap });
    const other = new MeshStandardMaterial();
    root.add(new Mesh(new BoxGeometry(), [groom, other]));
    const renderer = { domElement: { dataset: {} }, toneMapping: 0, setPixelRatio: vi.fn(), capabilities: { getMaxAnisotropy: () => 16 } };
    const studio = createLumiStudio(scene, renderer as unknown as WebGLRenderer, root);
    expect(studio).toBeDefined();
    expect(scene.background).toBeNull();
    expect(scene.environment).toBe(texture);
    expect(scene.environmentIntensity).toBe(0.42);
    expect(renderer.toneMapping).toBe(AgXToneMapping);
    expect(scene.children.every(object => object instanceof DirectionalLight || object instanceof HemisphereLight)).toBe(true);
    expect(hemisphere.intensity).toBe(0.32);
    expect(key.intensity).toBe(1.6);
    expect(groom.alphaToCoverage).toBe(false);
    expect(irisMap.anisotropy).toBe(8);
    expect(other.alphaToCoverage).toBe(false);
    expect(renderer.domElement.dataset).toMatchObject({ appearanceProfile: 'lumi-original-detail-v2.1' });
    expect(renderer.setPixelRatio).toHaveBeenCalledWith(2);
    expect(gpu.dispose).toHaveBeenCalledOnce();
    studio!.dispose();
    studio!.dispose();
    expect(release).toHaveBeenCalledOnce();
    expect(scene.environment).toBeNull();
    expect(scene.children).toEqual([hemisphere, key]);
    root.traverse(object => { if (object instanceof Mesh) object.geometry.dispose(); });
    groom.dispose(); other.dispose(); texture.dispose(); irisMap.dispose();
  });

  it('反射贴图生成失败时仍释放临时 GPU 生成器', () => {
    gpu.fromScene.mockImplementation(() => { throw new Error('GPU allocation failed'); });
    const scene = new Scene();
    expect(() => createLumiStudio(scene, {} as WebGLRenderer, originalCat())).toThrow('GPU allocation failed');
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(scene.environment).toBeNull();
  });
});
