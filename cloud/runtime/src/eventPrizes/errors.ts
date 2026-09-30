export class EventPrizeWithdrawalError extends Error {
  declare readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EventPrizeWithdrawalError";
    this.code = code;
  }
}
