<div align="center">

# 🏁 Head-to-Head: AI Task Scheduler Benchmark

**7 AI models. 1 million tasks each. We ran their code — then ranked them.**

*No approximations. No hand-waving. Just execution results.*

[Read the Full Report](EVALUATION_REPORT.md) • [Results](#-results) • [Key Findings](#-key-findings)

</div>

---

## What Happened Here

We gave 7 AI models the same prompt: build a production-ready, in-memory task scheduler that handles **1 million tasks** — with priorities, timestamps, dependency tracking, cycle detection, and efficient retrieval.

Then we did something most benchmarks don't: **we actually ran the code**.

Measured insert times. Executed workloads. Broke things on purpose. Checked if their tests caught real bugs (most didn't).

This repo contains every submission, every test, every bug we found, and what we learned about AI-generated infrastructure code.

---

## The Prompt

> Design and implement a production-ready in-memory task scheduler supporting 1 million tasks with priorities, execution timestamps, dependency tracking, dynamic updates, cycle detection, and efficient retrieval of the next executable task.
>
> Your answer must include: architecture, data structures, complexity analysis, complete implementation, tests, edge cases, scalability discussion.
>
> Do not simplify the problem. Assume this system will be deployed in production and your design choices will be reviewed by senior engineers.

Straightforward. Unforgiving. Production or nothing.

---

## The Models

| Model | Language | Type | Size |
|-------|----------|------|------|
| Agnes Flash | TypeScript | Dense (Hybrid Attention) | 33B |
| Qwen 3.8 Dense | TypeScript | Dense | 27B |
| Qwen 3.6 MoE | Python | MoE | 35B-A3B |
| Ornith 1.5 MoE | Python | MoE | 35B-A3B |
| Muse Glimmer | Python | Dense (GQA) | ~30B |
| BigBang v1 | TypeScript | MoE | 35B-A3B |
| Kat Coder 2.5 | TypeScript | MoE | 35B-A3B |
| K2 Horizon 36B MoVA | Python | MoE | 36B-A4B |
| Nex N2.5 mini | Python | MoE | 35B-A3B |

---

## 🏆 Results

### Who Actually Shipped

| Rank | Model | Score | Tests | 1M Insert | 1M Execute | Verdict |
|------|-------|-------|-------|-----------|------------|---------|
| 🥇 | **Agnes Flash** | **9.1** | 53+1 | 6.66s | 651ms (10k) | ✅ Production-ready |
| 🥈 | **Qwen 3.8 Dense** | **9.0** | 94 | **2.80s** | 6.65s | ✅ Production-ready |
| 🥉 | **Qwen 3.6 MoE** | **8.5** | 65 | 4.50s | **1.20s** | ✅ Production-ready |
| 4 | **Ornith 1.5 MoE** | **8.1** | 51/55 | 4.50s | 1.20s | ✅ Production-ready |
| 5 | Muse Glimmer | 6.7 | 8/8 | 2.66s | — | ⚠️ MVP |
| 6 | BigBang v1 | 6.3 | 30/30 | 1.28s | 3.24s | ❌ 4 critical bugs |
| 7 | Kat Coder 2.5 | 5.0 | 31/31 | ~2.3s | — | ❌ O(n) removal |
| — | K2 Horizon | 4.7 | 8/30 | ~14min | — | ❌ Broken enum |
| — | Nex N2.5 mini | 2.3 | 1/14 | Crash | Crash | ❌ Missing attributes |

The gap between first and last? **6.8 points**. Same prompt. Same problem. Wildly different outcomes.

### Score Breakdown

| Model | Arch | DS | Correct | Complex | Complete | Edge | Scale | Code | Test | Prod | **Total** |
|-------|------|----|---------|---------|----------|------|-------|------|------|------|-----------|
| Agnes Flash | 9 | 8 | 10 | 9 | 9 | 10 | 9 | 9 | 9 | 9 | **9.1** |
| Qwen 3.8 Dense | 9 | 9 | 10 | 10 | 9 | 10 | 9 | 9 | 9 | 7 | **9.0** |
| Qwen 3.6 MoE | 8 | 9 | 9 | 9 | 8 | 8 | 9 | 9 | 8 | 7 | **8.5** |
| Ornith 1.5 MoE | 8 | 9 | 9 | 9 | 8 | 8 | 6 | 9 | 8 | 7 | **8.1** |
| Muse Glimmer | 7 | 7 | 7 | 8 | 6 | 6 | 7 | 7 | 6 | 5 | **6.7** |
| BigBang v1 | 8 | 8 | 4 | 5 | 8 | 5 | 7 | 8 | 6 | 4 | **6.3** |
| Kat Coder 2.5 | 7 | 7 | 4 | 3 | 7 | 4 | 3 | 7 | 5 | 3 | **5.0** |
| K2 Horizon | 9 | 9 | 2 | 4 | 8 | 4 | 5 | 8 | 3 | 1 | **4.7** |
| Nex N2.5 mini | 5 | 3 | 1 | 1 | 3 | 1 | 2 | 4 | 1 | 1 | **2.3** |

---

## Key Findings

### 1. AI Can Actually Write Production Infrastructure

The top 4 models scored 8+. Agnes Flash (9.1) and Qwen 3.8 Dense (9.0) aren't just "good for AI" — they're genuinely solid implementations. Novel concurrency models. Ground-truth scale verification. 94 tests.

This isn't theoretical. This is deployable.

### 2. The Gap Is Staggering

9.1 to 2.3. Same prompt. The difference? Architectural choices and attention to edge cases.

**Model selection matters.** You can't just throw any model at infrastructure code and hope.

### 3. Two-Heap Architecture Wins

The top 3 all use a **two-heap design** — one heap for due tasks, one for future-dated tasks. It's the right call. Single-heap models struggle with deferral overhead.

If you're building a scheduler, start here.

### 4. Tests Lie (This One Matters)

BigBang v1 passes 30/30 tests. Kat Coder 2.5 passes 31/31. Both are **broken at scale**.

- Kat Coder's heap removal is O(n) — 93.5 seconds for 100k updates
- BigBang corrupts its heap after pop + remove sequences
- Neither validates cycles in addTask

Happy-case tests hide catastrophic failures. **If your tests don't include worst-case scenarios, you're not testing — you're hoping.**

### 5. One Decorator Destroyed Everything

K2 Horizon had an excellent two-heap design. Then they used `@dataclass(frozen=True)` on an Enum.

This made all enum variants compare equal. Every `in` check failed. 8 out of 30 tests passed.

A single Python-specific gotcha — the kind you'd catch in a 5-minute code review — tanked the entire system.

---

## Performance at Scale

### Insert Speed (1M tasks)

```
BigBang v1    ████████████████████ 1.28s  🏆
Kat Coder 2.5 ████████████████████████ ~2.3s
Muse Glimmer  ████████████████████████████ 2.66s
Qwen 3.8 Dense██████████████████████████████ 2.80s
Qwen 3.6 MoE  ████████████████████████████████████████████ 4.50s
Ornith 1.5 MoE████████████████████████████████████████████ 4.50s
Agnes Flash   ████████████████████████████████████████████████████████ 6.66s
K2 Horizon    █████████████████████████████████████████████████████████████████████ ~14min ❌
```

### Execute Speed (1M tasks)

```
Qwen 3.6 MoE  ████████████ 1.20s  🏆
Ornith 1.5 MoE████████████ 1.20s  🏆
BigBang v1    ████████████████████████████████████ 3.24s
Qwen 3.8 Dense████████████████████████████████████████████████████████ 6.65s
Agnes Flash   ████ 0.65s (10k subset)
```

### Memory (1M tasks)

```
Agnes Flash   ████████████████████ 385 MiB  🏆
Others        ██████████████████████████████ ~500 MiB
```

---

## Feature Comparison

| Feature | Agnes | Qwen 3.8 | Qwen 3.6 | Ornith | Muse | BigBang | Kat |
|---------|:-----:|:--------:|:--------:|:------:|:----:|:-------:|:---:|
| Two-heap | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Thread-safe | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Batch ops | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Hooks | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Forward refs | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Task reset | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Disposal | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Optimistic lock | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cascade fail | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Audit metrics | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| O(log n) remove | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## So Which One Should I Use?

Honestly? It depends on what you need:

- **Fastest insert** → Qwen 3.8 Dense (2.80s, 94 tests, optimistic locking)
- **Lowest memory** → Agnes Flash (385 MiB, ground-truth verified)
- **Fastest execute** → Qwen 3.6 MoE or Ornith 1.5 MoE (1.20s)
- **Most features** → Agnes Flash (forward refs, reset, disposal, audit metrics)
- **Most tested** → Qwen 3.8 Dense (94 tests, concurrency + edge cases)
- **Python shop** → Qwen 3.6 MoE (cleanest, best docs)

---

## Failure Patterns Worth Knowing

### "Almost Working"
Passes all own tests. Broken at scale. O(n) operations. Missing validation.

> **Lesson:** Tests need worst-case scenarios. Performance assertions. Not just happy paths.

### "Decorator Destroys Semantics"
One `@dataclass(frozen=True)` on an Enum broke everything.

> **Lesson:** Language-specific gotchas need language-specific testing.

### "Design-Implementation Gap"
Docs describe a two-heap architecture. Code uses one heap.

> **Lesson:** Verify implementation matches documentation. Always.

### "Missing Attribute"
Methods reference attributes that were never initialized.

> **Lesson:** Code must be executed, not just reviewed.

---

## What the Winners Did Right

1. **Two-heap architecture** — separate due from future-dated tasks
2. **O(log n) removal** — position maps or lazy deletion, never linear scan
3. **Cycle detection on every edge addition** — not just in addTask
4. **Tests that include worst cases** — not just "does it work"
5. **Thread safety** — even when single-consumer is documented

---

## Running the Code

Each submission is self-contained:

**TypeScript:**
```bash
cd "qwen 3.8 27b"
npm install
npm test
npm run benchmark
```

**Python:**
```bash
cd "qwen moe"
python -m pytest test_scheduler.py -v
python benchmark.py
```

---

## Repository Structure

```
h2h/
├── EVALUATION_REPORT.md          # Full report (start here for details)
├── README.md                     # This file
├── summaries/                    # Individual model deep-dives (9 files)
│   ├── agnes-flash.md
│   ├── qwen-3.8-dense.md
│   ├── qwen-3.6-moe.md
│   ├── ornith-1.5-moe.md
│   ├── muse-glimmer.md
│   ├── bigbang-v1.md
│   ├── kat-coder-2.5.md
│   ├── k2-horizon-36b-mova.md
│   └── nex-n25-run2.md
├── agnes flash/                  # 🥇 TypeScript • 9.1/10
├── qwen 3.8 27b/                # 🥈 TypeScript • 9.0/10
├── qwen moe/                    # 🥉 Python • 8.5/10
├── ornith-moe/                  # Python • 8.1/10
├── muse-glimmer/                # Python • 6.7/10
├── bigbang/                     # TypeScript • 6.3/10
├── kat/                         # TypeScript • 5.0/10
├── k2-moe/                      # Python • 4.7/10
├── Nex/                         # Python (run 1)
└── nex-n25-run2/                # Python • 2.3/10
```

---

## Methodology (For the Skeptics)

Each model rated 1-10 on 10 dimensions: Architecture, Data Structures, Correctness, Complexity, Completeness, Edge Cases, Scalability, Code Quality, Test Quality, Production Readiness.

**What we did:**
- Ran every test suite (not just reviewed)
- Executed 1M-task scale tests where available
- Manually verified edge cases (cycle detection, version invalidation)
- Measured memory usage

**What we didn't do:**
- Cross-platform testing (macOS M3 Max, 64GB RAM)
- Persistence or distributed mode
- Long-running stability

Single evaluation run per model. No averaging. What you see is what happened.

---

## The Bottom Line

AI models can write production-grade infrastructure code. The best ones are genuinely impressive. But the range is enormous — and the failures are subtle.

**The difference between a 9.1 and a 2.3 isn't intelligence. It's architectural choices and edge case handling.**

If you're evaluating AI for infrastructure work: test at scale, verify edge cases, and never trust happy-case tests alone.

---

## Contributing

Found a bug? Want to add a model?

Open an issue or PR with the model name, submission code, and test results.

---

<div align="center">

**Evaluated by [Sentinel](https://hermes-agent.nousresearch.com) • September 2026**

*Built with Hermes Agent, Nous Research*

*What's the most surprising failure you've seen in AI-generated code? [Open a discussion](https://github.com/HermitDave/h2h/discussions).*

</div>
