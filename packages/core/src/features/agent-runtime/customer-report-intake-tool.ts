import {
  customerReportIntakeStartSchema,
  type CustomerReportIntake,
  type CustomerReportIntakeField,
  type CustomerReportIntakeStart,
} from "../plugins/customer-report-intake";
import type { ToolResult } from "./types";

/** The host side of the tool: it reads the engineer's messages for the quote check and keeps the intake per conversation. */
export interface CustomerReportIntakePort {
  start(start: CustomerReportIntakeStart): Promise<{ kind: "asking" | "closed"; intake: CustomerReportIntake }>;
}

export const requestCustomerReportInputSchema = customerReportIntakeStartSchema.describe(
  "origin: customer when the engineer relays what a customer or end user said or sent; unsure for a pasted message whose sender is not clear. " +
  "extracted: values the conversation already gives, each with the exact words it came from (channel is whatsapp, email, phone or other; receivedAt is ISO 8601 with offset; subject only from an email's own Subject line; reportText is the customer's own words copied exactly, without the engineer's instructions or email headers). " +
  "newReport: true only when a different, named customer reports something after an earlier report in this conversation was saved or dismissed.",
);

/** The question as the agent asks it. The engineer's panel shows the same question with its options. */
const QUESTIONS: Record<CustomerReportIntakeField, string> = {
  origin: "Is this a message from a customer?",
  channel: "How did the customer send it?",
  sender: "Who sent it?",
  subject: "What is the email subject?",
  receivedAt: "When did it arrive?",
  reportText: "What did the customer write or say? (they can keep what they wrote)",
  confirm: "Shall I save this customer report?",
};

/** The system prompt rule both Desktop and the Dashboard give the agent; the tool description holds the details. */
export const CUSTOMER_REPORT_INTAKE_PROMPT = "When the engineer relays what a customer or end user said or sent, in any language or wording and even without the words \"customer report\", call request_customer_report_input before investigating so the report and its source are recorded. Never call it for the engineer's own observations, alerts or logs.";

export const REQUEST_CUSTOMER_REPORT_INPUT_DESCRIPTION = [
  "Start collecting a customer report in this conversation. Decide from the meaning of the engineer's message, in any language or wording, not from keywords:",
  "call it when the engineer relays what a customer or end user said, sent or reported (by WhatsApp, email, phone, chat or in person), forwards or pastes a customer's message, or summarises a customer's call, even without the words \"customer report\".",
  "Do not call it for the engineer's own observations, monitoring alerts, log lines, metrics or internal requests from colleagues.",
  "If a pasted message might be from a customer but you are not sure, call it with origin unsure; the engineer is then asked \"Is this a message from a customer?\".",
  "Pass every value the conversation already gives in extracted, with the exact words as quote; a value without its words in the conversation is dropped and asked instead. Never guess a sender, time or channel, and never write a subject: take it only from an email's Subject line.",
  "For a forwarded or pasted customer message, pass the customer's own words as reportText, copied exactly, leaving out your instructions to the agent and the From/Subject/Date header lines.",
  "The engineer answers one question at a time in a panel above the composer. Answers come back as messages that start with [customer-report-answer]: acknowledge the answer in one short sentence and, when its next field is not null, ask only that next question; do not call this tool again for it.",
  "When an answer has next null and a customerReportId, the report is saved: continue the incident, and use the newest customerReportId when a ticket is created for it.",
  "A message that starts with [customer-report-dismissed] means the engineer closed the report: say you will continue without it and never ask about that report again.",
].join(" ");

function asking(intake: CustomerReportIntake): ToolResult {
  const question = intake.question;
  if (question === null) return closed(intake);
  return {
    output: JSON.stringify({
      status: "asking",
      intakeId: intake.id,
      question: { field: question, text: QUESTIONS[question] },
      known: intake.answers,
      instructions: `In the engineer's language, say in one short sentence that you will log the customer report first, then ask only this question: "${QUESTIONS[question]}". End your turn after it. Do not list answer options; the panel shows them. Continue the investigation after the report is saved or dismissed.`,
    }),
  };
}

function closed(intake: CustomerReportIntake): ToolResult {
  return {
    output: JSON.stringify({
      status: intake.status,
      intakeId: intake.id,
      ...(intake.customerReportId === null ? {} : { customerReportId: intake.customerReportId }),
      instructions: intake.status === "dismissed"
        ? "The engineer dismissed the customer report in this conversation. Do not ask about it again; continue the incident. Only a report from a different, named customer starts a new one (newReport true with the sender's words quoted)."
        : "This customer report is already saved. Do not ask for it again; continue the incident. Only a report from a different, named customer starts a new one (newReport true with the sender's words quoted).",
    }),
  };
}

export async function requestCustomerReportInput(port: CustomerReportIntakePort | undefined, start: CustomerReportIntakeStart): Promise<ToolResult> {
  if (port === undefined) {
    return { error: JSON.stringify({ code: "CUSTOMER_REPORT_INTAKE_UNAVAILABLE", message: "Customer reports cannot be collected in this conversation. Continue the incident without one." }) };
  }
  const result = await port.start(start);
  return result.kind === "asking" ? asking(result.intake) : closed(result.intake);
}
