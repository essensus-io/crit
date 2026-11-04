import {
  type ProviderProfile,
  ProviderProfile as ProviderProfileSchema,
  type ProviderProfileInput,
  type ProvidersFile,
  type Role,
} from "@crit/schema";

export class ProfileError extends Error {
  override name = "ProfileError";
}

export const emptyProvidersFile = (): ProvidersFile => ({
  default: null,
  providers: [],
  roles: {},
});

const find = (file: ProvidersFile, name: string) => file.providers.find((p) => p.name === name);

function need(file: ProvidersFile, name: string): ProviderProfile {
  const p = find(file, name);
  if (!p) {
    const names = file.providers.map((x) => x.name).join(", ") || "none";
    throw new ProfileError(`crit: no provider named "${name}" (have: ${names})`);
  }
  return p;
}

/** Add a profile. The first profile becomes the default. */
export function addProfile(
  file: ProvidersFile,
  input: ProviderProfileInput,
  opts: { makeDefault?: boolean } = {},
): ProvidersFile {
  const profile = ProviderProfileSchema.parse(input);
  if (find(file, profile.name))
    throw new ProfileError(`crit: a provider named "${profile.name}" already exists`);
  const providers = [...file.providers, profile];
  const def = opts.makeDefault || file.default === null ? profile.name : file.default;
  return { ...file, providers, default: def };
}

/** Update fields of a profile; renaming also updates the default and roles. */
export function updateProfile(
  file: ProvidersFile,
  name: string,
  patch: Partial<ProviderProfileInput>,
): ProvidersFile {
  const current = need(file, name);
  const next = ProviderProfileSchema.parse({ ...current, ...patch });
  if (next.name !== name && find(file, next.name)) {
    throw new ProfileError(`crit: a provider named "${next.name}" already exists`);
  }
  const rename = (n: string | null | undefined) => (n === name ? next.name : n);
  const roles = Object.fromEntries(Object.entries(file.roles).map(([r, n]) => [r, rename(n)]));
  return {
    ...file,
    providers: file.providers.map((p) => (p.name === name ? next : p)),
    default: rename(file.default) ?? null,
    roles,
  };
}

/**
 * Remove a profile and any roles pointing at it. Removing the default needs
 * `newDefault` when other profiles remain.
 */
export function removeProfile(
  file: ProvidersFile,
  name: string,
  newDefault?: string,
): ProvidersFile {
  need(file, name);
  const providers = file.providers.filter((p) => p.name !== name);
  let def = file.default;
  if (file.default === name) {
    if (providers.length === 0) def = null;
    else if (!newDefault)
      throw new ProfileError(`crit: ${name} is the default provider; choose a new default`);
    else {
      if (!providers.some((p) => p.name === newDefault)) need({ ...file, providers }, newDefault);
      def = newDefault;
    }
  }
  const roles = Object.fromEntries(Object.entries(file.roles).filter(([, n]) => n !== name));
  return { ...file, providers, default: def, roles };
}

export function setDefault(file: ProvidersFile, name: string): ProvidersFile {
  const p = need(file, name);
  if (!p.enabled)
    throw new ProfileError(`crit: ${name} is disabled; enable it before making it the default`);
  return { ...file, default: name };
}

export function setRole(file: ProvidersFile, role: Role, name: string | null): ProvidersFile {
  const roles = { ...file.roles };
  if (name === null) delete roles[role];
  else {
    need(file, name);
    roles[role] = name;
  }
  return { ...file, roles };
}

/** Roles that point at this profile. */
export const rolesOf = (file: ProvidersFile, name: string): Role[] =>
  (Object.entries(file.roles) as [Role, string][]).filter(([, n]) => n === name).map(([r]) => r);

export type ResolvedProvider = { profile: ProviderProfile; warnings: string[] };

/**
 * Pick the profile for a run: an explicit `--provider` wins, then a role
 * assignment, then the project's preferred provider (if the user has a
 * profile with that name), then the default.
 */
export function resolveProvider(
  file: ProvidersFile,
  opts: { name?: string; role?: Role; preferred?: string } = {},
): ResolvedProvider {
  const warnings: string[] = [];
  const usable = (p: ProviderProfile | undefined, why: string): ProviderProfile | undefined => {
    if (p && !p.enabled) {
      warnings.push(`provider ${p.name} (${why}) is disabled; skipping it`);
      return undefined;
    }
    return p;
  };
  if (opts.name) {
    const p = need(file, opts.name);
    if (!p.enabled)
      throw new ProfileError(
        `crit: provider ${p.name} is disabled (crit providers edit ${p.name})`,
      );
    return { profile: p, warnings };
  }
  if (opts.role && opts.role !== "review") {
    const n = file.roles[opts.role];
    const p = n ? usable(find(file, n), `role ${opts.role}`) : undefined;
    if (p) return { profile: p, warnings };
  }
  const reviewRole = file.roles.review;
  if (reviewRole) {
    const p = usable(find(file, reviewRole), "role review");
    if (p) return { profile: p, warnings };
  }
  if (opts.preferred) {
    const p = find(file, opts.preferred);
    if (!p)
      warnings.push(
        `this project prefers provider "${opts.preferred}", but you have no profile with that name; using your default`,
      );
    else if (usable(p, "project preference")) return { profile: p, warnings };
  }
  const def = file.default ? usable(find(file, file.default), "default") : undefined;
  if (def) return { profile: def, warnings };
  const any = file.providers.find((p) => p.enabled);
  if (any) {
    warnings.push(`no usable default provider; using ${any.name}`);
    return { profile: any, warnings };
  }
  throw new ProfileError("crit: no enabled providers. Run `crit providers add`.");
}
