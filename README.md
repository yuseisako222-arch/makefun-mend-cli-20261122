# makefun-mend-cli-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yuseisako222-arch/makefun-mend-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yuseisako222-arch/makefun-mend-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit lists — to a tree of files, exactly as SPEC.md specifies. Each edit's target lines are found with a three-tier match (exact, then trailing-whitespace, then indentation), and either every edit lands or none does. This entry implements SPEC.md sections 5 to 8 on top of the starter: the three-tier line matching, the unified-diff, SEARCH/REPLACE and V4A readers, move reporting and the all-or-nothing write. Practice set: 100 of 100 checks pass (score 1000).

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9vf7ext6&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
