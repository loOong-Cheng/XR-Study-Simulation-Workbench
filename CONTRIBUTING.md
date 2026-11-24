# Contributing

Keep changes grounded in HCI study methods and observable execution. Add a synthetic fixture and meaningful tests when changing scoring, data contracts or protocol enforcement. Never commit real participant records or provider credentials.

Run `npm run check` and `npm test`. Protocol/schema changes require an explicit versioning decision; preserve reproducibility of frozen plans. Do not silently reinterpret existing outcomes or turn missing data into zero.

For engine integrations, document and test actual capabilities and versions. Keep study semantics in a study adapter, rather than in the generic analyzer. New LLM planners implement `PlanningAgent` and return validated proposals; they do not receive the held-out human reference.

Changes to statistical procedures should state their estimand, assumptions and failure cases. Avoid outcome-dependent weights, participant exclusions and correction families. Include all condition failures and distinguish recorded evidence from a claim about internal model reasoning.
