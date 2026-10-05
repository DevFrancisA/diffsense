# Security and data handling

Repository source chunks are stored in the configured PostgreSQL database. Source and diff content is sent to OpenAI for embeddings and review. GitHub and OpenAI credentials are read server-side from environment variables; do not commit `.env.local` or index code unless those data flows are approved for your repositories.

This version is intended for local use or a trusted single-operator environment. It has no sign-in, authorization, or tenant isolation, so **do not expose a shared instance to the public internet or use it for multiple users**. Add authentication and repository-level access controls before hosting it as a team service.

Other current limits: GitHub is the only repository provider; indexing is capped at `MAX_INDEX_FILES` supported source files per run (40 by default); findings are suggestions, not confirmed defects; and the app does not create GitHub review comments or apply fixes.
