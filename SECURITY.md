# Security

Please report vulnerabilities privately, not in a public issue: use **Report a vulnerability** on the Security tab of <https://github.com/BriskWatchdogz1/poe-price-tool> (GitHub Private Vulnerability Reporting).

A useful report says which version you run (Settings page), what you did, what you expected, what happened instead, and how an attacker would use it. Do not include a real POESESSID or any other credential.

The POESESSID is stored in `/config` (`networth-users.json`) on the machine that runs the backend, or comes from the container environment if `POE_SESSID` is set; it is never part of the repository. The backend has no login of its own and is meant for a trusted LAN only; see "Before you install: no authentication" in the [README](README.md).
