// ============================================================================
// PERMISSIONS (P3.11) — granular permission matrix
// ============================================================================
// Every guarded action maps to a permission KEY (e.g. "invoices.write"). The
// four built-in roles are defined as permission sets here, so seeding them keeps
// today's behavior identical. Custom org roles are stored in the DB as a set of
// these keys. "owner" is immutable and implicitly holds every permission.

export const PERMISSION_KEYS = [
  "invoices.read", "invoices.write",
  "bills.read", "bills.write",
  "banking.read", "banking.write",
  "inventory.write",
  "payroll.write",
  "reports.read",
  "pricing.write",
  "tax.write",
  "settings.admin",
  "members.admin",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const ALL: PermissionKey[] = [...PERMISSION_KEYS];

// Built-in roles → their permission sets. owner = everything (also enforced
// implicitly). Seeding these reproduces the legacy requireRole behavior.
export const BUILTIN_ROLE_PERMISSIONS: Record<string, PermissionKey[]> = {
  owner: ALL,
  admin: ALL.filter((k) => k !== "members.admin" ? true : true), // admin has all today
  accountant: [
    "invoices.read", "invoices.write", "bills.read", "bills.write",
    "banking.read", "banking.write", "inventory.write", "payroll.write",
    "reports.read", "pricing.write", "tax.write",
  ],
  viewer: ["invoices.read", "bills.read", "banking.read", "reports.read"],
};

export const BUILTIN_ROLES = ["owner", "admin", "accountant", "viewer"] as const;
export function isBuiltinRole(name: string): boolean {
  return (BUILTIN_ROLES as readonly string[]).includes(name);
}

// Does a role (built-in name or an explicit permission set) grant `key`?
export function roleGrants(role: string, key: PermissionKey, customPerms?: PermissionKey[] | null): boolean {
  if (role === "owner") return true;
  if (customPerms && customPerms.length) return customPerms.includes(key);
  const builtin = BUILTIN_ROLE_PERMISSIONS[role];
  return !!builtin && builtin.includes(key);
}
