# To do

- [ ] Add a custom Vitest reporter for agent runs that streams test progress, reports failures immediately, and ends with a compact summary.
- [ ] Add a persistent graphical session to workspace VMs for headed browser and GUI automation, including a virtual display, software rendering, remote viewing and input, and browser lifecycle management.
- [ ] Reconsider Drizzle for Halo-owned control-plane data once the schema grows or local development standardizes on PostgreSQL; keep Better Auth on its built-in database adapter unless its migration workflow also changes.
- [ ] Remove workspace VM access to the OpenAI API key after inference moves behind the control plane.
- [ ] Reduce the workspace-server container to its required production dependency tree, then preload Docker and the immutable container image into the workspace VM boot image to shorten first-time provisioning.
