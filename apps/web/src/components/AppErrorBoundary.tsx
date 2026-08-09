/**
 * APP ERROR BOUNDARY
 * ==================
 * Root-level boundary wrapped around the whole app in main.tsx. Without
 * it, any uncaught render error unmounts the React tree and leaves a
 * blank white page. With it, crashes land on the neon ErrorScreen — a
 * thrown ApiError keeps its HTTP status; anything else renders as a
 * client-side crash.
 *
 * Distinct from SafeErrorBoundary, which intentionally renders nothing
 * so decorative 3D/WebGL subtrees can fail silently.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { ApiError } from "../lib/api";
import { ErrorScreen } from "./ErrorScreen";

interface Props {
  children?: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  public state: State = { error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("AppErrorBoundary caught a fatal render error:", error, errorInfo);
  }

  private handleRetry = () => {
    // Re-render the tree in place; if the crash is persistent the screen
    // comes right back and the player can fall back to a full reload.
    this.setState({ error: null });
  };

  private handleHome = () => {
    // Hard reset to the landing view — clears whatever state crashed.
    window.location.assign("/");
  };

  public render() {
    const { error } = this.state;
    if (error) {
      return (
        <ErrorScreen
          status={error instanceof ApiError ? error.status : undefined}
          message={error instanceof ApiError ? error.message : undefined}
          onRetry={this.handleRetry}
          onHome={this.handleHome}
        />
      );
    }

    return this.props.children;
  }
}
