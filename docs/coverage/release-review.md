# Review of the November 21 release

The published snapshot is `6aa5247f8f563c56`. The roster contains 27 scored instruments and 30 standalone result tables. Terminal-Bench 4.0 and DeepSWE have separate controlled-harness comparisons.

## Panel decisions

The requested Antigravity panel used `gemini-4-neon-xhigh` at XHigh and `claude-opus-5-5-high` at High. Both reviewers initially held the release. Their examples included a writing leader supported by a single fiction benchmark, differences smaller than their uncertainty, and competing configurations that had no measured benchmark in common.

The first revisions added corroboration requirements, uncertainty intervals, and full feed-removal refits. The quality-weight alternative did not improve held-out predictions consistently. The final roster uses one unit of weight per distinct task. The duplicate check runs before compilation, during new calibration and in archive validation. The panel also requested source-specific efforts and separate controlled pass rates and costs for Terminal-Bench and DeepSWE. Controlled labels describe measured rates and costs. A high numerical estimate in a model domain can appear without a recommendation.

Gemini approved verification of the revised 27-instrument roster. Opus approved after checking the duplicate guard, controlled pick producer and its actual Home, API and Open Graph callers. Both approvals required passing the local release checks before publication.

## Remaining evidence limits

Only one of four held-out Writing benchmarks had enough overlapping configurations for rank comparison. When Hemingway-bench was held out, rank agreement was −0.29 across eight configurations. No broad writing winner was endorsed. Both software-stack validation folds had matched configurations from just two providers. Neither the model-based intervals nor this review establishes accuracy for a new occupation or an unseen task.

Private item-level intersection remains unknown where the producer withholds prompts. The registry documents and enforces the work contracts and dataset lineage that can be checked. [Roster and weights](measurement-families.md) · [Sophon screening](sophon.md) · [Prediction checks](rank-evidence.md)
