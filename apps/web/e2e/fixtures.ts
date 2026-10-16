export const PASSWORD = 'E2E-only-pass-phrase-2026';
export const USERS = [
  { role: 'owner', name: 'Saravanan S', email: 'owner@e2e.test' },
  { role: 'admin', name: 'Accounts Admin', email: 'admin@e2e.test' },
  { role: 'manager', name: 'Shiva', email: 'pm@e2e.test' },
  { role: 'site', name: 'Site Engineer', email: 'site@e2e.test' },
] as const;
export const email = (role: (typeof USERS)[number]['role']) =>
  USERS.find((u) => u.role === role)!.email;
