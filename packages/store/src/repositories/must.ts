export const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`crit: ${what} not found`);
  return value;
};
