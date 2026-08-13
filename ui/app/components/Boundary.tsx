// Keeps one broken panel from taking the whole screen with it, and shows what
// actually failed instead of a blank page. React swallows the message
// otherwise, which makes a render error very hard to chase.
import React from "react";

interface State { error: Error | null }

export class Boundary extends React.Component<
  { children: React.ReactNode; label?: string }, State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="banner" role="alert">
        <b>{this.props.label ?? "This view"} failed to render:</b>{" "}
        <span className="num">{error.message}</span>
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer" }}>stack</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, margin: "6px 0 0" }}>
            {error.stack}
          </pre>
        </details>
      </div>
    );
  }
}
