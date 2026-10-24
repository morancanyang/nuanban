const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const maxFileBytes = 50 * 1024 * 1024;
const maxDecodedBytes = 256 * 1024 * 1024;
const supportedExtensions = new Set(['KHR_materials_unlit', 'KHR_texture_transform', 'KHR_mesh_quantization', 'KHR_lights_punctual',
  'KHR_materials_emissive_strength', 'KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_materials_transmission',
  'KHR_materials_volume', 'KHR_materials_ior', 'KHR_materials_specular', 'VRM', 'VRMC_vrm', 'VRMC_materials_mtoon',
  'VRMC_springBone', 'VRMC_node_constraint', 'VRMC_materials_hdr_emissiveMultiplier']);

function inspectImage(bytes) {
  let width = 0;
  let height = 0;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if ([216, 217, 1].includes(marker) || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    else if (kind === 'VP8L' && bytes[20] === 47) { width = 1 + (bytes.readUInt32LE(21) & 16383); height = 1 + ((bytes.readUInt32LE(21) >>> 14) & 16383); }
  }
  if (!width || !height || width > 2048 || height > 2048) throw new Error('模型纹理无法识别或超过 2048 × 2048，请缩小纹理后重试');
  return width * height * 8;
}

function inspectModelContainer(input, format) {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > maxFileBytes) throw new Error('模型必须是非空且不超过 50 MiB 的本地文件');
  if (!['glb', 'vrm', 'fbx'].includes(format)) throw new Error('仅支持 GLB、VRM 和 FBX 模型');
  if (format === 'fbx') {
    if (bytes.toString('ascii', 0, 20) === 'Kaydara FBX Binary  ' && bytes[20] === 0 && bytes[21] === 26 && bytes[22] === 0) {
      if (bytes.length < 27) throw new Error('FBX 头部不完整');
      const version = bytes.readUInt32LE(23);
      if (version < 7400 || version > 7500) throw new Error('FBX 目前支持 7.4 / 7.5，请重新导出或转换为 GLB');
      const wide = version >= 7500;
      const headerSize = wide ? 25 : 13;
      let nodes = 0;
      let decoded = bytes.length;
      const readOffset = offset => {
        if (offset + (wide ? 8 : 4) > bytes.length) throw new Error('FBX 结构不完整');
        const value = wide ? Number(bytes.readBigUInt64LE(offset)) : bytes.readUInt32LE(offset);
        if (!Number.isSafeInteger(value)) throw new Error('FBX 偏移无效');
        return value;
      };
      function parseNode(start, limit, depth) {
        if (depth > 96 || ++nodes > 30000 || start + headerSize > limit) throw new Error('FBX 结构过于复杂或不完整');
        const end = readOffset(start);
        if (end === 0) return limit;
        const properties = readOffset(start + (wide ? 8 : 4));
        const propertyBytes = readOffset(start + (wide ? 16 : 8));
        const nodeName = bytes.toString('utf8', start + headerSize, start + headerSize + bytes[start + headerSize - 1]);
        let offset = start + headerSize + bytes[start + headerSize - 1];
        const propertyEnd = offset + propertyBytes;
        if (end <= start || end > limit || propertyEnd > end || properties > 1000000) throw new Error('FBX 属性长度无效');
        for (let property = 0; property < properties; property++) {
          const kind = String.fromCharCode(bytes[offset++]);
          const scalarSizes = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };
          const arraySizes = { f: 4, d: 8, l: 8, i: 4, b: 1, c: 1 };
          if (scalarSizes[kind]) offset += scalarSizes[kind];
          else if (kind === 'S' || kind === 'R') {
            if (offset + 4 > propertyEnd) throw new Error('FBX 属性不完整');
            const length = bytes.readUInt32LE(offset);
            if (offset + 4 + length > propertyEnd) throw new Error('FBX 图片或字符串越界');
            if (nodeName === 'Content' && kind === 'R' && length > 0) decoded += inspectImage(bytes.subarray(offset + 4, offset + 4 + length));
            if (decoded > maxDecodedBytes) throw new Error('FBX 图片解码资源超限');
            offset += 4 + length;
          } else if (arraySizes[kind]) {
            if (offset + 12 > propertyEnd) throw new Error('FBX 数组不完整');
            const count = bytes.readUInt32LE(offset);
            const encoding = bytes.readUInt32LE(offset + 4);
            const stored = bytes.readUInt32LE(offset + 8);
            const expanded = count * arraySizes[kind];
            decoded += expanded;
            if (decoded > maxDecodedBytes || expanded > 100 * Math.max(1, stored) || ![0, 1].includes(encoding)) throw new Error('FBX 解压资源超限，请简化模型');
            offset += 12;
            if (offset + stored > propertyEnd) throw new Error('FBX 压缩数组不完整');
            if (encoding === 1) {
              let inflated;
              try { inflated = inflateSync(bytes.subarray(offset, offset + stored), { maxOutputLength: Math.max(1, expanded) }); }
              catch { throw new Error('FBX 压缩数组损坏或超出声明大小'); }
              if (inflated.length !== expanded) throw new Error('FBX 解压大小与声明不一致');
            } else if (stored !== expanded) throw new Error('FBX 数组大小与声明不一致');
            offset += stored;
          } else throw new Error('FBX 包含不支持的属性');
          if (offset > propertyEnd) throw new Error('FBX 属性越界');
        }
        if (offset !== propertyEnd) throw new Error('FBX 属性长度不一致');
        while (offset + headerSize <= end && readOffset(offset) !== 0) offset = parseNode(offset, end, depth + 1);
        return end;
      }
      let offset = 27;
      while (offset + headerSize <= bytes.length && readOffset(offset) !== 0) offset = parseNode(offset, bytes.length, 0);
      if (!nodes) throw new Error('FBX 没有有效模型节点');
    } else {
      const text = bytes.toString('utf8');
      if (!/^\s*;\s*FBX\s+7\.[45]\.\d+\s+project file/i.test(text) || !/FBXVersion\s*:\s*7[45]00\b/.test(text)) throw new Error('不是受支持的 FBX 7.4 / 7.5 文件');
      if ((text.match(/\{/g) ?? []).length > 30000 || /\*([0-9]{10,})\s*\{/.test(text)) throw new Error('FBX 结构超出安全预算');
      let decoded = bytes.length;
      for (const content of text.matchAll(/Content\s*:[\s\r\n]*,?[\s\r\n]*"([A-Za-z0-9+/=]+)"/g)) decoded += inspectImage(Buffer.from(content[1], 'base64'));
      if (decoded > maxDecodedBytes) throw new Error('FBX 图片解码资源超限');
    }
    return { format };
  }
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('不是完整的 glTF 2.0 二进制模型');
  let document;
  let binaryBytes = 0;
  let binary = Buffer.alloc(0);
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('GLB 数据块不完整');
    const length = bytes.readUInt32LE(offset);
    const kind = bytes.readUInt32LE(offset + 4);
    if (length % 4 || offset + 8 + length > bytes.length) throw new Error('GLB 数据块越界');
    if (kind === 0x4e4f534a) {
      if (document || offset !== 12 || length > 4 * 1024 * 1024) throw new Error('GLB 描述过大或结构无效');
      try { document = JSON.parse(bytes.toString('utf8', offset + 8, offset + 8 + length)); } catch { throw new Error('GLB 描述损坏'); }
    } else if (kind === 0x004e4942 && binaryBytes === 0) { binaryBytes = length; binary = bytes.subarray(offset + 8, offset + 8 + length); }
    else throw new Error('GLB 包含不支持的数据块');
    offset += 8 + length;
  }
  if (!document || document.asset?.version !== '2.0') throw new Error('只支持 glTF 2.0');
  if (format === 'vrm' && !document.extensions?.VRM && !document.extensions?.VRMC_vrm) throw new Error('文件没有 VRM 0.x / 1.0 人形描述');
  let entries = 0;
  function scan(value, depth = 0) {
    if (depth > 80 || ++entries > 200000) throw new Error('模型描述过于复杂');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['script', 'scripts', 'shader', 'shaders'].includes(key.toLowerCase())) throw new Error('模型不得携带脚本或自定义着色器');
      if (key === 'uri' && (typeof child !== 'string' || !/^data:(?:image\/(?:png|jpeg|webp)|application\/octet-stream);base64,[A-Za-z0-9+/=]+$/.test(child))) throw new Error('模型引用了外部资源，请将纹理和网格内嵌后再导入');
      scan(child, depth + 1);
    }
  }
  scan(document);
  if ([...(document.extensionsUsed ?? []), ...(document.extensionsRequired ?? [])].some(extension => !supportedExtensions.has(extension))) throw new Error('模型包含未支持的压缩或材质扩展，请导出未压缩 GLB / VRM');
  if ((document.nodes?.length ?? 0) > 2048 || (document.meshes?.length ?? 0) > 512 || (document.materials?.length ?? 0) > 256 || (document.animations?.length ?? 0) > 64) throw new Error('模型节点、材质或动画数量超限');
  let decoded = binaryBytes;
  for (const accessor of document.accessors ?? []) {
    if (!Number.isInteger(accessor.count) || accessor.count < 0 || accessor.count > 1000000 || accessor.sparse) throw new Error('模型顶点访问器无效或不支持稀疏数据');
    decoded += accessor.count * 64;
  }
  for (const buffer of document.buffers ?? []) {
    if (!Number.isInteger(buffer.byteLength) || buffer.byteLength < 0 || buffer.byteLength > maxFileBytes) throw new Error('模型缓冲区超限');
    if (buffer.uri || buffer.byteLength > binaryBytes || document.buffers.length !== 1) throw new Error('请将模型缓冲区内嵌到同一个 GLB / VRM 文件');
  }
  for (const mesh of document.meshes ?? []) for (const primitive of mesh.primitives ?? []) if ((primitive.mode ?? 4) !== 4) throw new Error('模型只支持三角网格，不支持线段或点云');
  for (const view of document.bufferViews ?? []) {
    if (view.buffer !== 0 || !Number.isInteger(view.byteLength) || view.byteLength < 0 || !Number.isInteger(view.byteOffset ?? 0) || (view.byteOffset ?? 0) < 0 || (view.byteOffset ?? 0) + view.byteLength > binaryBytes) throw new Error('模型缓冲区范围无效');
  }
  if ((document.images?.length ?? 0) > 128) throw new Error('模型纹理数量超过 128 张');
  for (const image of document.images ?? []) {
    let imageBytes;
    if (typeof image.uri === 'string') imageBytes = Buffer.from(image.uri.slice(image.uri.indexOf(',') + 1), 'base64');
    else {
      const view = document.bufferViews?.[image.bufferView];
      if (!view) throw new Error('模型纹理缺少内嵌数据');
      imageBytes = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    }
    decoded += inspectImage(imageBytes);
  }
  if (decoded > maxDecodedBytes) throw new Error('模型解码内存超限，请减少网格细节');
  return { format };
}

function validateModelSummary(summary) {
  if (!summary || typeof summary !== 'object' || !Number.isInteger(summary.triangles) || summary.triangles < 1 || summary.triangles > 100000
    || !Number.isInteger(summary.meshes) || summary.meshes < 1 || summary.meshes > 512
    || !Number.isInteger(summary.bones) || summary.bones < 0 || summary.bones > 512
    || !Number.isInteger(summary.animations) || summary.animations < 0 || summary.animations > 64
    || !Number.isInteger(summary.decodedBytes) || summary.decodedBytes < 1 || summary.decodedBytes > maxDecodedBytes
    || !Array.isArray(summary.textures) || summary.textures.length > 128
    || !summary.textures.every(size => Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0 && size.width <= 2048 && size.height <= 2048)) throw new Error('模型解析结果无效或超出资源预算');
  return { triangles: summary.triangles, meshes: summary.meshes, bones: summary.bones, animations: summary.animations,
    decodedBytes: summary.decodedBytes, textures: summary.textures.map(size => ({ width: size.width, height: size.height })) };
}

function createLocalModelStore({ databasePath, now = Date.now }) {
  if (!path.isAbsolute(databasePath)) throw new Error('模型仓储必须使用固定本机路径');
  let database;
  let pending;
  function open(create = false) {
    if (database) return database;
    if (!create && !fs.existsSync(databasePath)) return null;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS active_model (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, file_name TEXT NOT NULL, format TEXT NOT NULL, bytes BLOB NOT NULL, summary TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;');
    return database;
  }
  function read() {
    const row = open()?.prepare('SELECT * FROM active_model WHERE singleton=1').get();
    if (!row) return { kind: 'none' };
    inspectModelContainer(row.bytes, row.format);
    const summary = validateModelSummary(JSON.parse(row.summary));
    if (createHash('sha256').update(row.bytes).digest('hex') !== row.id) throw new Error('本机模型校验失败，请重新导入；原画稿仍保留');
    return { kind: 'model', id: row.id, fileName: row.file_name, format: row.format, bytes: new Uint8Array(row.bytes), summary, updatedAt: row.updated_at };
  }
  function stage({ fileName, format, bytes, summary }) {
    inspectModelContainer(bytes, format);
    const validated = validateModelSummary(summary);
    pending = { token: randomUUID(), id: createHash('sha256').update(bytes).digest('hex'), fileName: path.basename(fileName).slice(0, 120), format,
      bytes: Buffer.from(bytes), summary: validated, expiresAt: now() + 10 * 60 * 1000 };
    return { token: pending.token, id: pending.id, fileName: pending.fileName, format, bytes: new Uint8Array(pending.bytes), summary: validated };
  }
  function apply(token) {
    if (typeof token !== 'string' || !pending || pending.token !== token || pending.expiresAt < now()) throw new Error('模型预览已过期，请重新选择文件并预览');
    const updatedAt = new Date(now()).toISOString();
    try {
      open(true).prepare('INSERT INTO active_model VALUES(1, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET id=excluded.id, file_name=excluded.file_name, format=excluded.format, bytes=excluded.bytes, summary=excluded.summary, updated_at=excluded.updated_at')
        .run(pending.id, pending.fileName, pending.format, pending.bytes, JSON.stringify(pending.summary), updatedAt);
    } catch { throw new Error('模型保存失败，上一套桌宠未替换；请检查本机可用空间后重试'); }
    pending = undefined;
    return read();
  }
  function clear() {
    open()?.prepare('DELETE FROM active_model WHERE singleton=1').run();
    return { kind: 'none' };
  }
  return { read, stage, apply, clear, discard: () => { pending = undefined; }, close: () => { pending = undefined; database?.close(); database = undefined; } };
}

function registerLocalModelBridge({ ipcMain, dialog, store, validate, isManagementTrusted, getManagementWindow, getToolWindow = () => undefined, getPetWindow,
  builtinModelsPath = path.join(__dirname, 'ui', 'models'), activate = async () => {} }) {
  const petUrl = pathToFileURL(path.join(__dirname, 'pet.html')).href;
  const channels = ['nuanban:model:read', 'nuanban:model:choose', 'nuanban:model:apply', 'nuanban:model:clear', 'nuanban:model:discard', 'nuanban:model:apply-builtin', 'nuanban:model:read-builtin'];
  let choosing = false;
  let applyingBuiltin = false;
  let disposed = false;
  function trustedPet(event) {
    const window = getPetWindow();
    return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.split('#')[0] === petUrl;
  }
  function publish(model) {
    for (const window of [getManagementWindow(), getToolWindow(), getPetWindow()]) {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('nuanban:model:changed', model);
    }
    return model;
  }
  const requireManagement = event => { if (!isManagementTrusted(event)) throw new Error('只有本人管理窗口可以导入或更换 3D 模型'); };
  function readBuiltin(id) {
    if (id !== 'lumi' && id !== 'lili' && id !== 'lili-natural-v4') throw new Error('未知的内置三维伙伴');
    const builtin = {
      lumi: { fileName: 'Lumi_Magical_Kitten.glb', bytes: 10887504, sha256: '4cee02df06e168eb99612ab5d807a3efe6025d14c7dfec516616ff8825b0e9b3' },
      lili: { fileName: 'Lili_Independent_Deer.glb', bytes: 7171212, sha256: '8b5b3adce1d8995a0c754aed5d89360ec56fb35f7cf6d570052594de508fb35c' },
      'lili-natural-v4': { fileName: 'Lili_Natural_v4.glb', bytes: 9863528, sha256: '331f66f6748bf78a390f60a2092c8ce884113698418087d0881cbe1f6feacd8f' },
    }[id];
    const { fileName } = builtin;
    const filePath = path.join(builtinModelsPath, id, fileName);
    if (!path.isAbsolute(builtinModelsPath) || !fs.existsSync(filePath)) throw new Error('客户端缺少内置伙伴资源，请重新构建或安装后重试');
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== builtin.bytes) throw new Error('内置伙伴文件无效，请重新构建或安装客户端');
    const bytes = fs.readFileSync(filePath);
    if (createHash('sha256').update(bytes).digest('hex') !== builtin.sha256) throw new Error('内置伙伴资源校验失败，原桌宠未替换');
    inspectModelContainer(bytes, 'glb');
    return { fileName, format: 'glb', bytes: new Uint8Array(bytes) };
  }
  ipcMain.handle(channels[0], event => {
    if (!isManagementTrusted(event) && !trustedPet(event)) throw new Error('不可信模型读取来源');
    return store.read();
  });
  ipcMain.handle(channels[1], async event => {
    requireManagement(event);
    if (choosing) throw new Error('已有模型正在选择或检查，请稍候');
    choosing = true;
    store.discard();
    try {
      const origin = [getManagementWindow(), getToolWindow()].find(window => window && !window.isDestroyed() && window.webContents === event.sender);
      const selected = await dialog.showOpenDialog(origin, { title: '选择本地 3D 桌宠模型', properties: ['openFile'], filters: [{ name: '3D 模型（纹理须内嵌）', extensions: ['glb', 'vrm', 'fbx'] }] });
      if (selected.canceled || selected.filePaths.length !== 1) return null;
      const selectedPath = selected.filePaths[0];
      if (!path.isAbsolute(selectedPath) || selectedPath.startsWith('\\')) throw new Error('只接受这台电脑上的本地模型文件');
      const metadata = fs.lstatSync(selectedPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maxFileBytes) throw new Error('请选择不超过 50 MiB 的本地模型文件');
      const descriptor = fs.openSync(selectedPath, 'r');
      let bytes;
      try {
        bytes = Buffer.alloc(metadata.size);
        if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length || fs.fstatSync(descriptor).size !== bytes.length) throw new Error('文件在读取时发生变化，请重新选择');
      } finally { fs.closeSync(descriptor); }
      const format = path.extname(selectedPath).slice(1).toLowerCase();
      inspectModelContainer(bytes, format);
      const summary = await validate({ bytes: new Uint8Array(bytes), format });
      if (disposed || !isManagementTrusted(event)) throw new Error('管理窗口已关闭，模型未应用');
      return store.stage({ fileName: path.basename(selectedPath), format, bytes, summary });
    } finally { choosing = false; }
  });
  const requireAvailable = () => { if (applyingBuiltin) throw new Error('正在调用内置伙伴，请等待完成后再更换模型'); };
  ipcMain.handle(channels[2], (event, token) => { requireManagement(event); requireAvailable(); return publish(store.apply(token)); });
  ipcMain.handle(channels[3], event => { requireManagement(event); requireAvailable(); return publish(store.clear()); });
  ipcMain.handle(channels[4], event => { requireManagement(event); requireAvailable(); store.discard(); return true; });
  ipcMain.handle(channels[5], async (event, id, ...extra) => {
    requireManagement(event);
    if ((id !== 'lumi' && id !== 'lili' && id !== 'lili-natural-v4') || extra.length) throw new Error('未知的内置三维伙伴');
    if (choosing) throw new Error('已有模型正在选择或检查，请稍候');
    choosing = true;
    applyingBuiltin = true;
    try {
      const source = readBuiltin(id);
      const summary = validateModelSummary(await validate({ bytes: source.bytes, format: source.format }));
      if (disposed || !isManagementTrusted(event)) throw new Error('管理窗口已关闭，内置伙伴未应用');
      await activate();
      if (disposed || !isManagementTrusted(event)) throw new Error('管理窗口已关闭，内置伙伴未应用');
      const staged = store.stage({ ...source, summary });
      return publish(store.apply(staged.token));
    } finally { choosing = false; applyingBuiltin = false; }
  });
  ipcMain.handle(channels[6], (event, id, ...extra) => {
    requireManagement(event);
    if (extra.length) throw new Error('内置三维伙伴读取不接受额外参数');
    const { format, bytes } = readBuiltin(id);
    return { format, bytes };
  });
  return { deactivate: () => publish(store.clear()), dispose: () => { disposed = true; channels.forEach(channel => ipcMain.removeHandler(channel)); store.close(); } };
}

module.exports = { inspectModelContainer, validateModelSummary, createLocalModelStore, registerLocalModelBridge };
