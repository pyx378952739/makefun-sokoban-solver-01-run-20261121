[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/pyx378952739/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/pyx378952739/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty.

Every level is a hallway with small rooms off it, and a box never leaves its room in an optimal answer, so each room is solved on its own with A* over pushes and the answers are joined by walks. A state is the boxes' squares and the player's reachable region; the estimate is the cheapest assignment of boxes to goals on walking distances, so the first solved state popped is optimal. Dead squares and frozen 2x2 blocks are pruned. The search is pure — no clock, no randomness — so two runs write the same bytes.

On the kit's practice set it scores 1,000,000: every instance solved in exactly P* pushes.

## Run

```sh
node main.ts
```

It reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`). Node 22, no dependencies, no install step.
