import {
  answerCustomerReportIntake,
  CustomerReportIntakeError,
  dismissCustomerReportIntake,
  markIntakeSaved,
  parseCustomerReportAnswerMessage,
  parseCustomerReportDismissMessage,
  startCustomerReportIntake,
  type CustomerReportIntake,
  type CustomerReportIntakeAnswerInput,
  type CustomerReportIntakeDismissInput,
  type CustomerReportIntakeStart,
  type CustomerReportIntakeStartResult,
  type CustomerReportIntakeStore,
} from "./customer-report-intake";
import {
  customerReportLinkDecision,
  parseCustomerReportMessage,
  type CustomerReport,
  type CustomerReportStore,
} from "./customer-reports";

type LinkedOperation = Parameters<typeof customerReportLinkDecision>[0];
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** Engineer messages without their header lines; answers and dismissals carry no customer words. */
export function intakeConversation(engineerMessages: readonly string[]): string[] {
  return engineerMessages.flatMap((text) => {
    if (parseCustomerReportAnswerMessage(text) !== null || parseCustomerReportDismissMessage(text) !== null) return [];
    return [parseCustomerReportMessage(text)?.body ?? text];
  }).filter((text) => text.trim().length > 0);
}

export interface CustomerReportIntakeResult {
  intake: CustomerReportIntake;
  /** The saved report, when this answer completed or corrected it. */
  report: CustomerReport | null;
}

/**
 * Keeps one conversation's customer report intake. Desktop and the Dashboard give it their own stores; the rules for
 * what is asked, kept, saved and corrected are the same for both.
 */
export class CustomerReportIntakeService {
  constructor(
    private readonly intakes: CustomerReportIntakeStore,
    private readonly reports: CustomerReportStore,
    private readonly options: {
      /** The ticket operation a saved report points to, so a report already used for a ticket is not corrected. */
      linkedOperation?: (operationId: string) => Promise<LinkedOperation | null>;
      newId?: () => string;
      now?: () => Date;
    } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  latest(threadId: string): Promise<CustomerReportIntake | null> {
    return this.intakes.latest(threadId);
  }

  /** Called by the agent tool. `engineerMessages` are this conversation's engineer messages, oldest first. */
  async start(threadId: string, request: { start: CustomerReportIntakeStart; timeZone: string; engineerMessages: readonly string[] }): Promise<CustomerReportIntakeStartResult> {
    const conversation = intakeConversation(request.engineerMessages);
    const quotes = (request.start.extracted ?? []).map((item) => normalize(item.quote)).filter((quote) => quote.length >= 2);
    // "Use what I wrote" offers the message the report came from: the newest one holding a quoted value, else the newest.
    const relayed = [...conversation].reverse().find((text) => quotes.some((quote) => normalize(text).includes(quote))) ?? conversation[conversation.length - 1] ?? "";
    const result = startCustomerReportIntake(await this.intakes.latest(threadId), {
      id: this.options.newId?.() ?? crypto.randomUUID(),
      threadId,
      timeZone: request.timeZone,
      start: request.start,
      conversation,
      relayedText: relayed,
      now: this.now(),
    });
    return result.kind === "asking" ? { kind: "asking", intake: await this.intakes.save(result.intake) } : result;
  }

  private async intake(threadId: string, id: string): Promise<CustomerReportIntake> {
    const intake = await this.intakes.get(threadId, id);
    if (intake === null) throw new CustomerReportIntakeError("INTAKE_NOT_FOUND", "This customer report was not found in this conversation.");
    return intake;
  }

  private async savedReport(intake: CustomerReportIntake): Promise<CustomerReport | null> {
    return intake.customerReportId === null ? null : await this.reports.get(intake.threadId, intake.customerReportId);
  }

  /** Applies the engineer's answer. A complete intake saves its report; a correction saves a new version. */
  async answer(input: CustomerReportIntakeAnswerInput, submittedBy: string): Promise<CustomerReportIntakeResult> {
    const current = await this.intake(input.threadId, input.intakeId);
    const result = answerCustomerReportIntake(current, input, this.now());
    if (result.kind === "unchanged") return { intake: current, report: await this.savedReport(current) };
    if (result.kind === "asking" || result.kind === "dismissed") return { intake: await this.intakes.save(result.intake), report: null };
    if (result.kind === "corrected") {
      const previous = await this.reports.get(input.threadId, result.replaces);
      const linked = previous?.operationId === null || previous === null ? null : await this.options.linkedOperation?.(previous.operationId) ?? null;
      if (previous?.operationId != null && (linked === null || customerReportLinkDecision(linked) !== "create")) {
        throw new CustomerReportIntakeError("INTAKE_REPORT_IN_USE", "A ticket already uses this customer report, so it cannot be changed. Add the correction to the ticket instead.");
      }
    }
    const report = await this.reports.save({ ...result.report, threadId: input.threadId, clientRequestId: input.clientRequestId }, submittedBy);
    if (result.kind === "corrected" && report.id !== result.replaces) await this.reports.supersede?.(input.threadId, result.replaces, report.id);
    return { intake: await this.intakes.save(markIntakeSaved(result.intake, report.id)), report };
  }

  /** Closes the open question. A new report closes for good; an unfinished correction keeps the saved report. */
  async dismiss(input: CustomerReportIntakeDismissInput): Promise<CustomerReportIntake> {
    const current = await this.intake(input.threadId, input.intakeId);
    const next = dismissCustomerReportIntake(current, await this.savedReport(current), this.now());
    return next === current ? current : await this.intakes.save(next);
  }
}
