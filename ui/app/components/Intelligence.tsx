// INTELLIGENCE — the page's own questions, answered on the page.
//
// Every screen in this app measures something a reader then has to interpret:
// an Apdex that moved, a route that loses people, a layer that went quiet.
// "Explain this page" answered the generic version of that in a side panel.
// This answers the SPECIFIC versions, in place, and the questions are written
// per page by someone who knows what that page can and cannot prove.
//
// Grounding is the whole point. Each starter carries the page's measured
// facts as supplementary context and an instruction that forbids inventing a
// number — an answer that cites a figure this app never measured is worse than
// no answer, because it arrives wearing the app's credibility.
//
// Built on the platform's own parts: listAvailableSkills gates it (Gen AI can
// be off, or the user may lack permission), recommenderConversation answers
// inline, AiResponse renders it, and IntentButton hands the same prompt to
// Assist when the reader wants to keep pulling the thread.
import React from "react";
import { publicClient } from "@dynatrace-sdk/client-davis-copilot";
import { AiLoadingIndicator, AiResponse } from "@dynatrace/strato-components/content";
import { Button, IntentButton } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
/* AiIcon, not the signet: the signet is a solid badge and at 20px beside
 * 11px text it reads as a blob. The sparkle is the mark the platform's
 * own Intelligence surfaces use, and it survives being small. */
import { AiIcon, ChevronDownIcon, ChevronUpIcon } from "@dynatrace/strato-icons";
import { useAssistState } from "../hooks/useAssist";

/** One question this page is equipped to answer. */
export interface Starter {
  /** What the chip says — short, the reader's words, no jargon. */
  label: string;
  /** What is actually asked. May be longer and more precise than the label. */
  ask: string;
}

/** The platform's documented ceilings for a conversation starter. */
const PROMPT_MAX = 10_000;
const SUPP_MAX = 100_000;
const INSTR_MAX = 2_500;

const GROUND =
  "Answer only from the measured facts supplied with this question. Every "
  + "number you cite must appear there — never invent one, never estimate, and "
  + "say plainly when something was not measured rather than filling the gap. "
  + "Name the specific actions, screens, routes, states, countries or services "
  + "involved instead of giving generic advice. The application's status is "
  + "its Apdex alone; Davis problems and error shares are context, not the "
  + "colour. Treat any line marked SIGNAL as evidence that part of a figure "
  + "may be a measurement artefact and say so before recommending work on "
  + "it. When a figure comes from a sample, keep its shares and say counts "
  + "are estimates. Lead with what the reader should act on, name who owns "
  + "it, and give the number on the page that proves it was done. Keep it to "
  + "a few short bullets.";

export function Intelligence({ subject, starters, facts, scope, className }: {
  /** What this page IS, in the reader's words — it goes into every prompt. */
  subject: string;
  /** The questions this page can answer, most useful first. */
  starters: Starter[];
  /** The page's measured facts, built by the caller from what it renders. */
  facts: () => string;
  /** WHAT THE ANSWER IS ABOUT. An answer is only true of the application and
   *  window whose facts produced it, and this section lives at the top of a
   *  page the reader keeps re-scoping: switching application left the old
   *  reply sitting under the new selection, and a request still in flight
   *  could land after the switch and describe the application the reader had
   *  just left. Pass anything that identifies the scope — the caller knows
   *  what it is — and the answer is dropped the moment it changes, along with
   *  any reply that arrives for a scope that is no longer on screen. */
  scope?: string;
  className?: string;
}) {
  const { available, agentic } = useAssistState();
  const [asked, setAsked] = React.useState<string | null>(null);
  const [answer, setAnswer] = React.useState<string | null>(null);
  const [state, setState] = React.useState<"idle" | "asking" | "failed">("idle");
  /* FOLDED AWAY WHEN IT IS NOT WANTED. The section sits at the top of the
   * page, which is right for the questions and wrong for a long answer: an
   * eight-line reply pushes every measurement below the fold, on every page,
   * for a reader who may only have wanted one of them. So it folds — and
   * opening a question unfolds it, because asking is the one moment you
   * certainly want to see it. */
  const [open, setOpen] = React.useState(true);
  /* the scope the visible answer belongs to, and the one in flight */
  const inFlight = React.useRef<string | null>(null);
  React.useEffect(() => {
    inFlight.current = null;
    setAsked(null);
    setAnswer(null);
    setState("idle");
  }, [scope]);

  // a conversation starter that cannot run is worse than none at all
  if (!available || !starters.length) return null;

  /* WHAT TRAVELS WITH THE QUESTION. In agentic mode the operator can query the
   * platform itself, so repeating what it could fetch is wasted payload that
   * may conflict with fresher numbers — but this app's OWN state (the window on
   * screen, the reader's selection, the mined journeys) is not reachable by any
   * query, so it always goes. */
  const contexts = () => [
    { type: "supplementary" as const,
      value: (`What is on screen in ${subject}${agentic
        ? " — this is the app's own state, which you cannot query for yourself"
        : ""}:\n\n${facts()}`).slice(0, SUPP_MAX) },
    { type: "instruction" as const, value: GROUND.slice(0, INSTR_MAX) },
    { type: "origin-app" as const, value: "my.deliverychain.ux" },
  ];

  const promptFor = (s: Starter) =>
    `${s.ask}\n\nThis is about ${subject} in the UX Delivery Chain app.`
      .slice(0, PROMPT_MAX);

  const ask = async (s: Starter) => {
    const mine = scope ?? "";
    inFlight.current = mine;
    setOpen(true);
    setAsked(s.label);
    setAnswer(null);
    setState("asking");
    try {
      const r = await publicClient.recommenderConversation({
        body: {
          text: promptFor(s),
          context: contexts()
            .filter((c) => c.type !== "origin-app")
            .map((c) => ({ type: c.type as "supplementary" | "instruction", value: c.value })),
        },
      });
      /* The endpoint answers in two shapes — one object carrying the finished
       * text, or the stream of events it was assembled from. Which arrives
       * depends on a live estate's negotiated accept type, so read both rather
       * than assume: a union handled on one branch is a blank panel on the
       * other. */
      const text = Array.isArray(r)
        ? r.map((e) => {
            const d = (e as { data?: unknown }).data as { text?: unknown } | undefined;
            return typeof d?.text === "string" ? d.text : "";
          }).join("")
        : ((r as { text?: unknown }).text as string | undefined) ?? "";
      /* the reader may have moved on while this was in flight; an answer
         about the application they left is worse than no answer */
      if (inFlight.current !== mine) return;
      setAnswer(text);
      setState(text ? "idle" : "failed");
    } catch {
      if (inFlight.current !== mine) return;
      setState("failed");
    }
  };

  const current = starters.find((s) => s.label === asked) ?? starters[0];

  return (
    <section className={className ? `intel ${className}` : "intel"}>
      <header className="intel__hd">
        <AiIcon />
        <span>Intelligence</span>
        {(answer || state === "failed") && (
          <button className="intel__fold" type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            title={open ? "Fold the answer away — the questions stay"
              : "Show the answer again"}>
            {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </button>
        )}
      </header>

      <Flex flexWrap="wrap" gap={8} className="intel__row">
        {starters.map((s) => (
          /* All default variant: "emphasized" fills, and a chosen question is
             not a verdict. Which one was asked is already said by the answer
             underneath it. */
          <Button key={s.label} variant="default"
            onClick={() => void ask(s)}
            disabled={state === "asking"}>
            <Button.Prefix><AiIcon /></Button.Prefix>
            {s.label}
          </Button>
        ))}
      </Flex>

      {state === "asking" && (
        <AiLoadingIndicator>reading what this page measured…</AiLoadingIndicator>
      )}

      {/* ONLY THE ANSWER FOLDS. The starters are the section's table of
          contents — what this page can be asked — and folding them away left
          a header that announced a feature and offered none of it. What costs
          the reader height is the generated text, so that is what folds. */}
      <div hidden={!open}>

      {state === "failed" && (
        <p className="intel__failed">
          Dynatrace Intelligence could not answer that one. The facts behind it
          are still on the page, and “continue in Assist” carries the same
          question across.
        </p>
      )}

      {answer && state !== "asking" && (
        <div className="intel__answer"><AiResponse>{answer}</AiResponse></div>
      )}

      {/* THE HAND-OFF FOLLOWS THE ANSWER. It used to stand in a permanent
          footer, so "Continue in Assist" was offered before anything had been
          said — continuing a conversation that had not started. It belongs
          after the text, where a reader who wants to keep pulling the thread
          actually arrives. The attribution rides with it, because it is a
          statement about the answer above, not about the section. */}
      {(answer || state === "failed") && state !== "asking" && (
      <footer className="intel__ft">
        <span>Dynatrace Intelligence uses AI. Always verify important information and decisions.</span>
        <IntentButton
          payload={{ prompt: promptFor(current), execute: false, contexts: contexts() }}
          options={{ recommendedAppId: "dynatrace.davis.copilot",
            recommendedIntentId: "ask-question" }}>
          <Button.Prefix><AiIcon /></Button.Prefix>
          Continue in Assist
        </IntentButton>
      </footer>
      )}
      </div>
    </section>
  );
}
