// Production real-money outcomes must never be operator-forced.
//
// Test overrides are available only when BOTH conditions are true. NODE_ENV is
// checked independently so a leaked ALLOW_OUTCOME_OVERRIDES variable can never
// activate the feature in production.
export function outcomeOverridesEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_OUTCOME_OVERRIDES === 'true'
  );
}
