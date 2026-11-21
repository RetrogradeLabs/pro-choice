# Security policy

## Supported versions

Security fixes apply to the current `main` branch and the live deployment at `https://prochoice.industries`.

## Report a vulnerability privately

Do not open a public GitHub issue for a suspected security vulnerability. Submit a private report through GitHub Security Advisories at:

`https://github.com/RetrogradeLabs/pro-choice/security/advisories/new`

Include the affected URL or file path, reproduction steps, expected impact, and any proof-of-concept details needed to verify the report. Strip credentials, tokens, or personal data before sending.

We acknowledge security reports within two business days, confirm severity during triage, and coordinate public disclosure after shipping a fix.

## Scope

In-scope reports include XSS or injection in the web application, unsafe parsing in upstream benchmark ingestion adapters, cache or atomic-release corruption paths, workflow supply-chain risks in `.github/workflows/`, and response header or CSP bypasses on `https://prochoice.industries`.

Do not run disruptive load tests against `https://prochoice.industries` or upstream benchmark hosts. Machine-readable security contact metadata is published at `https://prochoice.industries/.well-known/security.txt`.
