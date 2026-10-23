import { createModelView } from './viewer';
import type { LocalModel } from '../local-model';
import { isBuiltinLumi, liliModel, loadLiliModel, loadLumiModel, lumiModel } from './builtin-models';

const validationStage = document.getElementById('model-validation-stage');
if (validationStage && window.nuanbanModelValidator) {
  const bridge = window.nuanbanModelValidator;
  validationStage.style.width = '320px';
  validationStage.style.height = '320px';
  void bridge.read().then(async source => {
    const view = await createModelView(validationStage, source, { animate: false });
    const summary = view.summary;
    view.dispose();
    await bridge.complete({ summary });
  }).catch(error => bridge.complete({ error: error instanceof Error ? error.message : '模型解析失败，请检查文件格式' }).catch(() => {}));
}

const modelStage = document.getElementById('model-pet');
if (modelStage && window.nuanbanModel) {
  const bridge = window.nuanbanModel;
  const status = document.getElementById('model-status');
  let revision = 0;
  let disposed = false;
  let cloudVisible = false;
  let selectedModel: LocalModel | undefined;
  let currentView: Awaited<ReturnType<typeof createModelView>> | undefined;
  const visibility = (visible: boolean) => window.dispatchEvent(new CustomEvent('nuanban:model-visibility', { detail: { visible } }));
  const message = (text: string) => { if (status) { status.textContent = text; status.hidden = !text; } };
  function reset() {
    currentView?.dispose();
    currentView = undefined;
    modelStage!.replaceChildren();
    modelStage!.hidden = true;
    visibility(false);
  }
  async function show(model: LocalModel) {
    if (disposed) return;
    selectedModel = model;
    const currentRevision = ++revision;
    if (cloudVisible) { reset(); message(''); return; }
    if (model.kind === 'none') { reset(); message(''); return; }
    const stage = document.createElement('span');
    stage.className = 'model-surface';
    modelStage!.append(stage);
    modelStage!.hidden = false;
    try {
      const source = isBuiltinLumi(model.id) && model.id !== lumiModel.sha256 ? await loadLumiModel()
        : model.id === liliModel.previousSha256 ? await loadLiliModel() : model;
      const view = await createModelView(stage, source, { onError: text => {
        if (disposed || currentRevision !== revision) return;
        reset(); message(text);
      } });
      if (disposed || currentRevision !== revision) { view.dispose(); stage.remove(); return; }
      currentView?.dispose();
      for (const child of [...modelStage!.children]) if (child !== stage) child.remove();
      currentView = view;
      modelStage!.dataset.modelId = model.id;
      modelStage!.dataset.format = model.format;
      modelStage!.dataset.renderSource = source.format;
      visibility(true);
      message('');
    } catch (error) {
      stage.remove();
      if (disposed || currentRevision !== revision) return;
      if (!currentView) reset();
      message(error instanceof Error ? error.message : '模型显示失败，已保留原桌宠');
    }
  }
  const unsubscribe = bridge.onChanged(model => { void show(model); });
  const initialRevision = revision;
  void bridge.read().then(model => { if (!disposed && (initialRevision === revision || !selectedModel)) return show(model); })
    .catch(() => message('本机 3D 模型读取失败，暂用原画或内置桌宠；请重新导入'));
  const onCloudVisibility = (event: Event) => {
    const visible = (event as CustomEvent<{ visible: boolean }>).detail?.visible === true;
    if (visible === cloudVisible || disposed) return;
    cloudVisible = visible;
    revision++;
    if (cloudVisible) reset();
    else if (selectedModel) void show(selectedModel);
  };
  window.addEventListener('nuanban:avatar-visibility', onCloudVisibility);
  window.addEventListener('pagehide', () => { disposed = true; revision++; unsubscribe(); window.removeEventListener('nuanban:avatar-visibility', onCloudVisibility); reset(); }, { once: true });
}
