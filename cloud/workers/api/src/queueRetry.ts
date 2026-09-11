export const MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS = 60;

export function infrastructureRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(6, attempts - 1));
  return Math.min(MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS, 2 ** exponent);
}
