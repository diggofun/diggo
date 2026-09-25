import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "./StatusViews";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Route screen failed", { error, componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="page-shell page-alert">
          <ErrorState title="This screen could not load." onRetry={() => window.location.reload()}>
            Your wallet is safe. Retry the page, or return home if the problem continues.
          </ErrorState>
        </div>
      );
    }
    return this.props.children;
  }
}
