import type { AdapterBehavior, Connector } from "@/lib/types.ts"

// Every label a connector's buttons carry, chosen by what running it COSTS.
// Named for the consequence ("Run — writes to Hubspot"), not the mechanism
// ("Fetch rows"), because the mechanism is what misled people: an actuator's
// pull performs its action, so a button promising a read was lying.

type Wording = {
  /** Verb for the button that runs the connector and lands its rows. */
  pull: (system: string) => string
  /** Extra paragraph in the pull confirmation. Empty = the generic copy is enough. */
  pullWarning: (system: string) => string
  /** Label for the diagnostics button, or null when no honest read-only run exists. */
  test: string | null
  /** Sentence under the diagnostics heading. */
  testHint: (system: string) => string
  /** What the schedule panel says each tick does. */
  tick: (system: string) => string
}

const COST_NOTE = "Every run pays that cost again, including scheduled ones."

const WORDING: Record<AdapterBehavior, Wording> = {
  sync: {
    pull: () => "Fetch rows",
    pullWarning: () => "",
    test: "Test (dry run)",
    testHint: () =>
      "Check the live source is reachable, and dry-run a pull to grade the data against the model — without writing anything.",
    tick: () => "Fetch rows — changed rows are updated, unchanged rows are skipped, and new domain events are derived automatically.",
  },
  generator: {
    pull: () => "Generate rows",
    pullWarning: () => `This connector computes each row at a real cost — an AI call or a paid API. ${COST_NOTE}`,
    test: "Test (dry run)",
    testHint: () =>
      "Check the live source is reachable, and dry-run a pull to grade the data against the model. Nothing is written, but generating the sample rows costs what a real run costs.",
    tick: () => `Generate rows — new rows are computed and landed, unchanged ones are skipped. Each computed row costs money. ${COST_NOTE}`,
  },
  actuator: {
    pull: (system) => `Run — writes to ${system}`,
    pullWarning: (system) =>
      `This connector PERFORMS ACTIONS in ${system} — it creates records there for real, then records what it did. Running it again repeats those actions unless its own code checks first.`,
    test: null,
    testHint: (system) =>
      `Verify checks the connection only. There is no dry run for this connector: its pull is what performs the action, so any "test" writes to ${system} for real.`,
    tick: (system) => `Run — each tick performs real actions in ${system} and records them. A schedule here acts on its own, unattended.`,
  },
  extractor: {
    pull: () => "Extract rows",
    pullWarning: () => `This connector interprets an unstructured source with AI. ${COST_NOTE}`,
    test: "Test (dry run)",
    testHint: () =>
      "Check the live source is reachable, and dry-run an extraction to grade the data against the model. Nothing is written, but the extraction costs what a real run costs.",
    tick: () => `Extract rows — new items are interpreted and landed, ones already extracted are skipped. ${COST_NOTE}`,
  },
}

const wordingFor = (behavior?: AdapterBehavior) => WORDING[behavior ?? "sync"]

export const performsActions = (c: { behavior?: AdapterBehavior } | null | undefined) => c?.behavior === "actuator"

export const pullLabel = (c: Pick<Connector, "behavior" | "boundedContext">) =>
  wordingFor(c.behavior).pull(c.boundedContext)

export const testLabel = (c: Pick<Connector, "behavior">) => wordingFor(c.behavior).test

export const testHint = (c: Pick<Connector, "behavior" | "boundedContext">) =>
  wordingFor(c.behavior).testHint(c.boundedContext)

export const scheduleTickText = (c: Pick<Connector, "behavior" | "boundedContext">) =>
  wordingFor(c.behavior).tick(c.boundedContext)

/** The whole confirm() body for running a connector, warning first so it is read
 * before the mechanics. */
export const pullConfirmText = (c: Pick<Connector, "id" | "behavior" | "boundedContext">) => {
  const warning = wordingFor(c.behavior).pullWarning(c.boundedContext)
  const mechanics =
    "New rows are inserted; changed rows are updated in place; unchanged rows are skipped."
  const head = performsActions(c)
    ? `Run connector "${c.id}"?`
    : `Fetch rows from the data source via connector "${c.id}"?`
  return warning ? `${head}\n\n${warning}\n\n${mechanics}` : `${head}\n\n${mechanics}`
}

/** Shown where the result of a suppressed-write run is reported. An actuator's
 * run wrote nothing HERE, but it did act over there. */
export const nothingWrittenText = (c: Pick<Connector, "behavior" | "boundedContext">) =>
  performsActions(c) ? `nothing landed here — the actions in ${c.boundedContext} were real` : "nothing written"
