import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * 渲染异常兜底：只把错误打到控制台，不采集、不上报，也不清理本机资料。
 * 长辈用户看到的是一个能自己恢复的页面，而不是白屏。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[微光指引] 页面渲染失败', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="loading-screen" role="alert" aria-label="页面出错">
        <h1>页面出了点问题</h1>
        <p>本机的笔记、待办和画稿没有被删除。可以重新加载再试一次。</p>
        <button className="button primary" type="button" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </main>
    );
  }
}
