<!--
How to write this description. People and agents both follow these rules.

- Title: a conventional commit subject, for example `feat(runbooks): pause before write steps`.
- Write for the reviewer who will test this PR. Use full sentences, say why, and explain any term a tester would not know.
- Start with one or two sentences of context: the task or customer request, and anything that must merge first.
- Keep every heading. Write "None." where a section does not apply. The one exception is Stack: delete it when the PR stands alone.
- Do not add checkbox task lists. Under Verification, say what you ran and what you did not run.
- Keep each PR under 1,500 changed lines. Split bigger work into stacked PRs and list them under Stack.
- Request a review from @wirapratamaz, and assign @wirapratamaz and @agustinustheo.
- Do not add AI attribution lines.
-->

Context: the task, and what must merge first.

## Stack

<!-- List the PRs from the base up and put this one in bold. Include companion PRs in other repos (for example desktop-ce) and state the merge order. -->

1. #000 base PR title
2. **#000 this PR**

## Problem

<!-- What is wrong or missing today, and who it affects. -->

## What changes

<!-- Describe behaviour first, grouped by area, each with a bold lead-in. Name the key files. Say what deliberately stays the same. -->

## Migration and deploy

<!-- Schema migrations, new environment variables, deploy order, and behaviour that changes for existing data. -->

## How to test

<!-- Numbered steps a reviewer can follow, each with the expected result. -->

1.

## Verification

<!-- What you ran and the results: build, lint, typecheck, test counts, DB specs, Sandbox runs. Then list what was not verified. -->

## Limits

<!-- Known gaps and follow-ups. -->
