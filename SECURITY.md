# Security

Report suspected vulnerabilities privately to **support@handyplugins.co**.
Include the Import and EmDash versions, reproduction steps, and the relevant
capability configuration. Use synthetic sample data; do not send credentials,
account sessions, personal datasets, or unredacted site logs.

Import 0.1.0 uses sandbox isolation and requests
only schema read and content write. Source data is untrusted and is never
executed as code. History stores bounded metadata and safe errors, not datasets.
The source remains in the active admin form and is processed by the site host.

Preview confirmation uses a source/mapping/schema fingerprint and an atomic job
claim. Content creation and history checkpoints are separate host operations;
interrupted jobs require collection inspection before any manual retry. These
controls do not provide transaction rollback or exactly-once delivery.
