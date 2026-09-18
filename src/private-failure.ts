import { PrivateTransportError } from "./private-transport.js";

export type ClassifiedFailure =
  | "authentication"
  | "forbidden"
  | "rate-limited"
  | "cancelled"
  | "timeout"
  | "attribution-rejected"
  | "protocol-drift"
  | "response-limit"
  | "request-limit"
  | "upstream"
  | "network"
  | "failed";

export function classifyPrivateFailure(error: unknown): ClassifiedFailure {
  if (!(error instanceof PrivateTransportError)) return "failed";
  switch (error.code) {
    case "authentication":
      return "authentication";
    case "forbidden":
      return "forbidden";
    case "rate-limited":
      return "rate-limited";
    case "cancelled":
      return "cancelled";
    case "attribution-rejected":
      return "attribution-rejected";
    case "protocol-drift":
    case "invalid-response":
      return "protocol-drift";
    case "response-too-large":
    case "frame-too-large":
      return "response-limit";
    case "request-too-large":
      return "request-limit";
    case "upstream":
      return "upstream";
    case "offline":
      return "network";
  }
}
