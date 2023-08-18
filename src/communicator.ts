import { Span } from "@opentelemetry/sdk-trace-base";
import { OperonContext } from "./context";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type OperonCommunicator<T extends any[], R> = (ctxt: CommunicatorContext, ...args: T) => Promise<R>;

export interface CommunicatorConfig {
  retriesAllowed?: boolean; // Should failures be retried? (default true)
  intervalSeconds?: number; // Seconds to wait before the first retry attempt (default 1).
  maxAttempts?: number; // Maximum number of retry attempts (default 3). If the error occurs more times than this, return null.
  backoffRate?: number; // The multiplier by which the retry interval increases after every retry attempt (default 2).
}

export class CommunicatorContext extends OperonContext
{
  readonly functionID: number;
  readonly retriesAllowed: boolean;
  readonly intervalSeconds: number;
  readonly maxAttempts: number;
  readonly backoffRate: number;
  readonly span: Span;

  // TODO: Validate the parameters.
  constructor(functionID: number, span: Span, params: CommunicatorConfig)
  {
    super();
    this.functionID = functionID;
    this.span = span;
    this.retriesAllowed = params.retriesAllowed ?? true;
    this.intervalSeconds = params.intervalSeconds ?? 1;
    this.maxAttempts = params.maxAttempts ?? 3;
    this.backoffRate = params.backoffRate ?? 2;
  }
}
