# Research

Research established behavior before adding surprising ceremony around an external dependency. If straightforward code appears to need guards, wrappers, assertions, retries, or compatibility logic, inspect the dependency's source, official documentation, and relevant GitHub issues before keeping that design.

For common integrations, look for projects that combine the same libraries and compare their ownership and lifecycle boundaries. Useful references include:

- [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss) for Electron, Pi, Vite, and esbuild.
- [bb](https://github.com/get-bb/bb) for an Electron, Vite, and React agent IDE with a plugin system.
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) for another agent application architecture.

Use these projects as evidence, not authority. Keep Halo's own ownership, error-handling, and package conventions when their designs differ.
