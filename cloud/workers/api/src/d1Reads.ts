export async function readD1FirstRow<T>(
  statement: D1PreparedStatement,
): Promise<T | null> {
  const result = await statement.all<T>();
  return result.results[0] ?? null;
}
