import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A render exception must never produce a blank page.
 *
 * Without a boundary React unmounts the entire tree on the first uncaught error during
 * render, which looked exactly like "the page is empty" with nothing to say why. That is
 * what happened for real: one undefined field in the header blanked the whole dashboard.
 * This shows what failed, in the same terminal aesthetic, and offers a reload.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("dashboard render failed:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="wrap">
        <div className="panel crash" role="alert">
          <h3>The dashboard failed to render</h3>
          <p className="note">
            Something in the page threw while drawing it. The server is unaffected; this is a
            display fault. Reloading usually clears a transient one.
          </p>
          <pre className="snippet">{this.state.error.message}</pre>
          <button className="btn" onClick={() => window.location.reload()}>
            reload
          </button>
        </div>
      </div>
    );
  }
}
