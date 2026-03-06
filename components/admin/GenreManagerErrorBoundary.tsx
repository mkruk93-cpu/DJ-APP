"use client";

import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

class GenreManagerErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('GenreManager error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-red-800 bg-red-900/20 p-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Genre Management</h2>
            <button
              onClick={() => this.setState({ hasError: false, error: undefined })}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition hover:border-gray-600 hover:text-white"
            >
              Retry
            </button>
          </div>
          <div className="rounded-lg bg-red-900/20 border border-red-800 p-4">
            <p className="text-red-400 mb-2">Genre management component failed to load</p>
            <p className="text-sm text-red-300">
              Error: {this.state.error?.message || 'Unknown error'}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              This feature is temporarily unavailable. Other admin functions should still work.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default GenreManagerErrorBoundary;