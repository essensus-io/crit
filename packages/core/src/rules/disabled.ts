type KvStore = {
  kv: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
  };
};

const keyFor = (repoId: string) => `disabled-rules:${repoId}`;

export async function getDisabledRules(store: KvStore, repoId: string): Promise<string[]> {
  const raw = await store.kv.get(keyFor(repoId));
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function setRuleDisabled(
  store: KvStore,
  repoId: string,
  ruleKey: string,
  disabled: boolean,
): Promise<string[]> {
  const set = new Set(await getDisabledRules(store, repoId));
  if (disabled) set.add(ruleKey);
  else set.delete(ruleKey);
  const list = [...set].sort();
  await store.kv.set(keyFor(repoId), JSON.stringify(list));
  return list;
}
