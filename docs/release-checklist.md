# Before attaching a release to a paper

- Run `npm ci`, `npm run check`, `npm test`, and the synthetic demo from a clean checkout.
- Verify each engine/runtime connector on the actual execution machine; record exactly which configurations are tested. Do not change the integration status to “supported” based on documentation alone.
- Provide a synthetic end-to-end fixture and a study adapter that documents outcome units, trial boundaries, filtering, correctness rules and aggregation.
- Preserve model/runtime versions, input snapshots, source hashes, independent session/capture identities, technical retries and token semantics.
- Keep private participant data, credentials, raw recordings, generated experiment artifacts and machine-specific paths out of the source release. The included example is invented.
- Review intended condition differences and resource budgets. Treat standardized and autonomous exploration as explicit interventions.
- Freeze and independently timestamp the actual evaluation plan before new predictions. Mark retrospective analyses honestly.
- Inspect all assigned-job and participant coverage, uncertainty, tie handling, grouped weights and multiplicity before writing claims.
- Replace citation metadata with the actual author list, public repository URL and paper/archive DOI when available.
- Tag an immutable release and archive it; cite that artifact rather than an evolving default branch.
- Keep the MIT source license distinct from vendor SDK terms and any human dataset's access conditions.

No remote repository, paper DOI, completed engine integration or formal validation is invented by this starter project.
