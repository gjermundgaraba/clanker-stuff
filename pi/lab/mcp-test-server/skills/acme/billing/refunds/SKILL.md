---
name: refunds
description: Process customer refund requests per Acme's policy. Use when a customer asks for money back.
license: MIT
metadata:
  owner: billing
---

# Refunds

1. Read `references/policy.md` and check the request against it.
2. Run `scripts/check.sh <order-id>` to confirm the order exists.
3. Reply to the customer with the outcome and, when refunding, the amount.
