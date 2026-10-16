# Security policy

- Report a vulnerability privately to the Technical Lead (see `docs/ENGINEERING-STANDARDS.md` §8). Do not open a public issue.
- Critical and high findings: fix or formally accept (Product Owner, time-bound) before the next production release.
- Baseline: OWASP ASVS Level 2, with secure-development practices structured on NIST SSDF.
- Secrets live in the cloud secret manager. Rotate them on staff exit and at least yearly.
- Dependency scanning (OSV / npm audit), secret scanning (gitleaks) and a ZAP baseline run in CI. Annual external penetration test before renewal.
