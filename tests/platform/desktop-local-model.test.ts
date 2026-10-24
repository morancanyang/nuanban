import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { createBinaryFbx, createModelFbx, createModelGlb, createModelVrm, modelDocument } from '../fixtures/local-models';
import { inspectRenderedModel } from '../../apps/web/src/three-d/viewer';

const require = createRequire(import.meta.url);
const { inspectModelContainer, validateModelSummary, createLocalModelStore, registerLocalModelBridge } = require('../../apps/desktop/local-model.cjs');
const temporaryDirectories: string[] = [];
const stores: { close(): void }[] = [];
const summary = { triangles: 6, meshes: 1, bones: 0, animations: 0, decodedBytes: 200, textures: [] };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nuanban-model-unit-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'models.sqlite');
  const store = createLocalModelStore({ databasePath }); stores.push(store);
  return { directory, databasePath, store };
}
const candidate = () => ({ fileName: '我的伙伴.glb', format: 'glb', bytes: createModelGlb(), summary });
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('本地 3D 模型安全预检', () => {
  it('接受真实结构的 GLB、VRM 0/1、ASCII 和压缩二进制 FBX', () => {
    for (const [bytes, format] of [[createModelGlb(), 'glb'], [createModelVrm('0'), 'vrm'], [createModelVrm('1'), 'vrm'], [createModelFbx(), 'fbx'], [createBinaryFbx(), 'fbx'], [createBinaryFbx(false), 'fbx']]) expect(inspectModelContainer(bytes, format)).toEqual({ format });
  });
  it('不相信扩展名，拒绝截断和错误版本的模型', () => {
    expect(() => inspectModelContainer(Buffer.from('not a model'), 'glb')).toThrow();
    expect(() => inspectModelContainer(createModelGlb().subarray(0, 24), 'glb')).toThrow();
    expect(() => inspectModelContainer(createModelGlb(), 'vrm')).toThrow('没有 VRM');
    expect(() => inspectModelContainer(createModelGlb(), 'exe')).toThrow('仅支持');
    const bytes = createBinaryFbx(); bytes.writeUInt32LE(7600, 23);
    expect(() => inspectModelContainer(bytes, 'fbx')).toThrow('7.4 / 7.5');
  });
  it.each(['https://example.invalid/texture.png', 'file:///C:/secret.png', '../texture.png', 'data:text/html;base64,YQ=='])('拒绝资源引用 %s', uri => {
    const document = modelDocument(); document.images = [{ uri }];
    expect(() => inspectModelContainer(createModelGlb(document), 'glb')).toThrow('外部资源');
  });
  it('拒绝未知压缩、脚本、点云和巨型访问器', () => {
    for (const extra of [{ extensionsRequired: ['KHR_draco_mesh_compression'] }, { scripts: ['evil'] }, { accessors: [{ count: 100000000 }] }, { meshes: [{ primitives: [{ mode: 0 }] }] }]) expect(() => inspectModelContainer(createModelGlb({ ...modelDocument(), ...extra }), 'glb')).toThrow();
  });
  it('解码前拒绝超大 PNG 纹理', () => {
    const image = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image); image.writeUInt32BE(8192, 16); image.writeUInt32BE(8192, 20);
    const document = modelDocument(); document.images = [{ uri: 'data:image/png;base64,' + image.toString('base64') }];
    expect(() => inspectModelContainer(createModelGlb(document), 'glb')).toThrow('2048');
  });
  it('拒绝伪造的 FBX 数组展开声明', () => {
    const bytes = createBinaryFbx(); const index = bytes.indexOf(Buffer.from('Vertices')) + 'Vertices'.length;
    bytes.writeUInt32LE(100000000, index + 1);
    expect(() => inspectModelContainer(bytes, 'fbx')).toThrow('解压资源超限');
  });
  it('仅接受预算内的真实解析摘要', () => {
    expect(validateModelSummary({ ...summary, extra: 'not forwarded' })).toEqual(summary);
    for (const extra of [{ triangles: 0 }, { triangles: 100001 }, { bones: 513 }, { animations: -1 }, { textures: [{ width: 4096, height: 1 }] }, { decodedBytes: NaN }]) expect(() => validateModelSummary({ ...summary, ...extra })).toThrow();
  });
  it('实际网格统计不把静态几何伪报成骨骼动作', () => {
    const root = new Group(); const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial()); root.add(mesh);
    expect(inspectRenderedModel(root, [])).toMatchObject({ triangles: 12, meshes: 1, bones: 0, animations: 0 });
    mesh.geometry.getAttribute('position').setX(0, NaN);
    expect(() => inspectRenderedModel(root, [])).toThrow('无效');
    mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose();
  });
});

describe('模型预览确认、事务保存和重启恢复', () => {
  it('选择、预览和取消均不替换当前桌宠，不提前建库', () => {
    const { store, databasePath } = fixture();
    expect(store.read()).toEqual({ kind: 'none' });
    const staged = store.stage(candidate());
    expect(store.read()).toEqual({ kind: 'none' }); expect(existsSync(databasePath)).toBe(false);
    store.discard(); expect(() => store.apply(staged.token)).toThrow('过期');
  });
  it('只有预览令牌能应用，模型复制到本机后与源文件独立', () => {
    const { store, databasePath } = fixture();
    const staged = store.stage(candidate()); expect(() => store.apply('arbitrary path')).toThrow('过期');
    const applied = store.apply(staged.token); expect(applied).toMatchObject({ kind: 'model', fileName: '我的伙伴.glb', format: 'glb', summary });
    expect(Buffer.from(applied.bytes)).toEqual(createModelGlb()); expect(() => store.apply(staged.token)).toThrow('过期');
    store.close(); const restarted = createLocalModelStore({ databasePath }); stores.push(restarted);
    expect(restarted.read()).toEqual(applied); expect(restarted.clear()).toEqual({ kind: 'none' }); expect(restarted.read()).toEqual({ kind: 'none' });
  });
  it('数据库写入失败保持上一套模型', () => {
    const { store, databasePath } = fixture(); const first = store.apply(store.stage(candidate()).token);
    const lock = new DatabaseSync(databasePath); lock.exec('BEGIN EXCLUSIVE');
    const second = store.stage({ ...candidate(), fileName: 'second.glb' });
    try { expect(() => store.apply(second.token)).toThrow('上一套桌宠未替换'); } finally { lock.exec('ROLLBACK'); lock.close(); }
    expect(store.read()).toEqual(first);
  });
  it('过期和替换后的旧预览均不能应用', () => {
    const { databasePath } = fixture(); let time = 1000000; const store = createLocalModelStore({ databasePath, now: () => time }); stores.push(store);
    const first = store.stage(candidate()); const second = store.stage(candidate()); expect(() => store.apply(first.token)).toThrow('过期');
    time += 600001; expect(() => store.apply(second.token)).toThrow('过期'); expect(store.read()).toEqual({ kind: 'none' });
  });
});

describe('模型 IPC 权限与通知', () => {
  function bridgeFixture(overrides: Record<string, unknown> = {}) {
    const { directory, store } = fixture(); const handlers = new Map<string, (...argumentsList: any[]) => any>();
    const management = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn(), mainFrame: {} } };
    const tool = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn(), mainFrame: {} } };
    const pet = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn(), mainFrame: { url: pathToFileURL(join(process.cwd(), 'apps/desktop/pet.html')).href } } };
    const managementEvent = { sender: management.webContents, senderFrame: management.webContents.mainFrame };
    const toolEvent = { sender: tool.webContents, senderFrame: tool.webContents.mainFrame };
    const petEvent = { sender: pet.webContents, senderFrame: pet.webContents.mainFrame };
    const filePath = join(directory, 'sample.glb'); writeFileSync(filePath, createModelGlb());
    const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [filePath] })) };
    const validate = vi.fn(async () => summary);
    const activate = vi.fn(async () => {});
    const bridge = registerLocalModelBridge({ ipcMain: { handle: (channel: string, handler: (...argumentsList: any[]) => any) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
      dialog, store, validate, activate, builtinModelsPath: join(process.cwd(), 'apps/web/public/models'),
      isManagementTrusted: (event: unknown) => event === managementEvent || event === toolEvent, getManagementWindow: () => management, getToolWindow: () => tool, getPetWindow: () => pet, ...overrides });
    return { bridge, handlers, dialog, validate, activate, managementEvent, toolEvent, petEvent, management, tool, pet, store };
  }
  it.each([
    { id: 'lumi', bytes: 10887504, fileName: 'Lumi_Magical_Kitten.glb', sha256: '4cee02df06e168eb99612ab5d807a3efe6025d14c7dfec516616ff8825b0e9b3' },
    { id: 'lili', bytes: 7171212, fileName: 'Lili_Independent_Deer.glb', sha256: '8b5b3adce1d8995a0c754aed5d89360ec56fb35f7cf6d570052594de508fb35c' },
    { id: 'lili-natural-v4', bytes: 9863528, fileName: 'Lili_Natural_v4.glb', sha256: '331f66f6748bf78a390f60a2092c8ce884113698418087d0881cbe1f6feacd8f' },
  ])('内置 $id 只读预览不暂存、不改当前伙伴；确认后验证并持久化', async builtin => {
    const current = bridgeFixture();
    const first = current.store.stage(candidate());
    const source = current.handlers.get('nuanban:model:read-builtin')!(current.managementEvent, builtin.id);
    expect(source).toMatchObject({ format: 'glb', bytes: expect.any(Uint8Array) });
    expect(source.bytes.byteLength).toBe(builtin.bytes);
    expect(createHash('sha256').update(source.bytes).digest('hex')).toBe(builtin.sha256);
    expect(current.store.read()).toEqual({ kind: 'none' });
    expect(current.validate).not.toHaveBeenCalled();
    expect(current.store.apply(first.token)).toMatchObject({ kind: 'model' });
    const model = await current.handlers.get('nuanban:model:apply-builtin')!(current.managementEvent, builtin.id);
    expect(model).toMatchObject({ kind: 'model', id: builtin.sha256, fileName: builtin.fileName });
    expect(current.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(current.validate).toHaveBeenCalledOnce();
    expect(current.validate.mock.calls[0]).toHaveLength(1);
    expect(current.activate).toHaveBeenCalledOnce();
    expect(current.pet.webContents.send).toHaveBeenCalledWith('nuanban:model:changed', expect.objectContaining({ id: model.id }));
    expect(current.store.read()).toMatchObject({ id: model.id, fileName: model.fileName });
    expect(Buffer.from(current.store.read().bytes).equals(Buffer.from(source.bytes))).toBe(true);
    current.bridge.dispose();
  });
  it('内置白名单不接收路径、额外参数或桌宠写入请求', async () => {
    const current = bridgeFixture();
    for (const id of ['../lumi', '../lili', '../lili-natural-v4', '__proto__', 'C:\\secret.glb', null, {}, 'https://example.com/model.glb']) {
      expect(() => current.handlers.get('nuanban:model:read-builtin')!(current.managementEvent, id)).toThrow('未知');
      await expect(current.handlers.get('nuanban:model:apply-builtin')!(current.managementEvent, id)).rejects.toThrow('未知');
    }
    for (const id of ['lumi', 'lili', 'lili-natural-v4']) {
      expect(() => current.handlers.get('nuanban:model:read-builtin')!(current.petEvent, id)).toThrow('只有本人');
      await expect(current.handlers.get('nuanban:model:apply-builtin')!(current.petEvent, id)).rejects.toThrow('只有本人');
      expect(() => current.handlers.get('nuanban:model:read-builtin')!(current.managementEvent, id, 'extra')).toThrow('额外');
      await expect(current.handlers.get('nuanban:model:apply-builtin')!(current.managementEvent, id, 'extra')).rejects.toThrow('未知');
    }
    expect(current.activate).not.toHaveBeenCalled();
    current.bridge.dispose();
  });
  it.each([
    { id: 'lili', fileName: 'Lili_Independent_Deer.glb' },
    { id: 'lili-natural-v4', fileName: 'Lili_Natural_v4.glb' },
  ])('$id 文件大小或摘要不匹配时拒绝应用，保留先前模型', async builtin => {
    const directory = mkdtempSync(join(tmpdir(), 'nuanban-builtin-lili-'));
    temporaryDirectories.push(directory);
    mkdirSync(join(directory, builtin.id));
    const filePath = join(directory, builtin.id, builtin.fileName);
    const current = bridgeFixture({ builtinModelsPath: directory });
    const previous = current.store.apply(current.store.stage(candidate()).token);
    writeFileSync(filePath, Buffer.from([1, 2, 3]));
    await expect(current.handlers.get('nuanban:model:apply-builtin')!(current.managementEvent, builtin.id)).rejects.toThrow('文件无效');
    const bytes = readFileSync(join(process.cwd(), 'apps/web/public/models', builtin.id, builtin.fileName));
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(filePath, bytes);
    await expect(current.handlers.get('nuanban:model:apply-builtin')!(current.managementEvent, builtin.id)).rejects.toThrow('校验失败');
    expect(current.activate).not.toHaveBeenCalled();
    expect(current.validate).not.toHaveBeenCalled();
    expect(current.store.read()).toEqual(previous);
    current.bridge.dispose();
  });
  it('缺失、解析失败和角色停止失败时保留先前模型', async () => {
    const missing = bridgeFixture({ builtinModelsPath: join(process.cwd(), '.cache/missing-lumi-models') });
    await expect(missing.handlers.get('nuanban:model:apply-builtin')!(missing.managementEvent, 'lumi')).rejects.toThrow('缺少');
    expect(missing.activate).not.toHaveBeenCalled();
    missing.bridge.dispose();
    const current = bridgeFixture();
    const previous = current.store.apply(current.store.stage(candidate()).token);
    current.validate.mockRejectedValueOnce(new Error('解析失败'));
    await expect(current.handlers.get('nuanban:model:apply-builtin')!(current.managementEvent, 'lumi')).rejects.toThrow('解析失败');
    expect(current.activate).not.toHaveBeenCalled();
    expect(current.store.read()).toEqual(previous);
    current.activate.mockRejectedValueOnce(new Error('原角色未停止'));
    await expect(current.handlers.get('nuanban:model:apply-builtin')!(current.managementEvent, 'lumi')).rejects.toThrow('原角色未停止');
    expect(current.store.read()).toEqual(previous);
    current.bridge.dispose();
  });
  it('验证期间拒绝并发改写，窗口失去信任后不调用、不保存', async () => {
    let complete!: (value: typeof summary) => void;
    const current = bridgeFixture();
    current.validate.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const applying = current.handlers.get('nuanban:model:apply-builtin')!(current.managementEvent, 'lumi');
    await expect(current.handlers.get('nuanban:model:apply-builtin')!(current.toolEvent, 'lumi')).rejects.toThrow('请稍候');
    for (const channel of ['apply', 'clear', 'discard']) expect(() => current.handlers.get(`nuanban:model:${channel}`)!(current.managementEvent, 'token')).toThrow('正在调用');
    current.bridge.dispose();
    complete(summary);
    await expect(applying).rejects.toThrow('管理窗口已关闭');
    expect(current.activate).not.toHaveBeenCalled();
  });
  it('只有受信主框架可写；桌宠只有读取能力', async () => {
    const { bridge, handlers, managementEvent, petEvent, store } = bridgeFixture();
    expect(handlers.get('nuanban:model:read')!(petEvent)).toEqual({ kind: 'none' });
    for (const channel of ['apply', 'clear', 'discard']) expect(() => handlers.get('nuanban:model:' + channel)!(petEvent, 'token')).toThrow('只有本人');
    await expect(handlers.get('nuanban:model:choose')!(petEvent)).rejects.toThrow('只有本人');
    expect(() => handlers.get('nuanban:model:read')!({})).toThrow('不可信');
    const staged = await handlers.get('nuanban:model:choose')!(managementEvent);
    expect(store.read()).toEqual({ kind: 'none' });
    expect(handlers.get('nuanban:model:apply')!(managementEvent, staged.token)).toMatchObject({ kind: 'model' }); bridge.dispose(); expect(handlers.size).toBe(0);
  });
  it('取消不调用解析器，失败不改变现有模型', async () => {
    const { bridge, handlers, managementEvent, dialog, validate, store } = bridgeFixture();
    const first = store.apply(store.stage(candidate()).token);
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await handlers.get('nuanban:model:choose')!(managementEvent)).toBeNull(); expect(validate).not.toHaveBeenCalled();
    validate.mockRejectedValueOnce(new Error('bad model')); await expect(handlers.get('nuanban:model:choose')!(managementEvent)).rejects.toThrow('bad model');
    expect(store.read()).toEqual(first); bridge.dispose();
  });
  it('桌宠工具选择模型时对话框只归属工具，不阻塞客户端主窗口', async () => {
    const { bridge, handlers, toolEvent, dialog, tool, management } = bridgeFixture();
    await handlers.get('nuanban:model:choose')!(toolEvent);
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(tool, expect.objectContaining({ title: '选择本地 3D 桌宠模型' }));
    expect(dialog.showOpenDialog).not.toHaveBeenCalledWith(management, expect.anything());
    bridge.dispose();
  });
  it('应用和停用通知客户端、独立工具及桌宠，切换不会删除画稿', () => {
    const { bridge, handlers, managementEvent, store, management, tool, pet } = bridgeFixture();
    handlers.get('nuanban:model:apply')!(managementEvent, store.stage(candidate()).token);
    expect(management.webContents.send).toHaveBeenCalledWith('nuanban:model:changed', expect.objectContaining({ kind: 'model' }));
    expect(tool.webContents.send).toHaveBeenCalledWith('nuanban:model:changed', expect.objectContaining({ kind: 'model' }));
    expect(pet.webContents.send).toHaveBeenCalledWith('nuanban:model:changed', expect.objectContaining({ kind: 'model' }));
    bridge.deactivate(); expect(pet.webContents.send).toHaveBeenLastCalledWith('nuanban:model:changed', { kind: 'none' });
    expect(tool.webContents.send).toHaveBeenLastCalledWith('nuanban:model:changed', { kind: 'none' }); bridge.dispose();
  });
});
