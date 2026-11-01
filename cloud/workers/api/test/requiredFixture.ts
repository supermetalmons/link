export function requiredFixture<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("missing-required-test-fixture");
  return value;
}
