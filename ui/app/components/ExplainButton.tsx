// "Explain this page" — the screen's own numbers, read back in words.
//
// The chain's investigation routes ask Assist about ONE element. A reader
// looking at the whole diagram or the whole board asks something else — "what
// is this telling me" — so this hands Assist the facts the page is already
// showing and asks for them in plain language.
//
// It renders only when Assist can actually answer: Gen AI can be disabled on
// the account, an admin may not have allowed it, or the user may lack the
// permission (useAssist asks first). A button that cannot do anything is worse
// than no button — the same rule the routes follow.
import React from "react";
import { useAssist } from "../hooks/useAssist";
import { explainStep, intentsAvailable, open } from "../utils/links";

export function ExplainButton({ subject, facts, className }: {
  /** What the page IS, in the reader's words: "journey diagram", "board". */
  subject: string;
  /** The measured facts, built by the caller from what it renders. Assist is
   *  told to cite nothing that is not here. */
  facts: () => string;
  className?: string;
}) {
  const assist = useAssist();
  if (!assist || !intentsAvailable()) return null;
  return (
    <button
      className={className ?? "explain-btn"}
      title={`Ask Assist to read this ${subject} back in plain language — `
        + "it receives the numbers on screen and is told to cite no others"}
      onClick={() => open(explainStep(subject, facts()))}>
      ✦ explain this page
    </button>
  );
}
