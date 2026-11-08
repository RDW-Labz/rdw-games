# Azure App Service quota request — paste this into the portal

**Where:** Azure portal → **Help + Support** → **Create a support request**

| Field | Value |
|---|---|
| Issue type | **Service and subscription limits (quotas)** |
| Subscription | the pay-as-you-go subscription created 2026-11-03 (`Azure subscription`) |
| Quota type | **App Service** (the App Service plan SKU quota, not the App Service *limits* page) |
| Region | **East US 2** |
| SKU / tier | **Free (F1)** — one plan, one app |
| New limit requested | **1** (current limit is 0) |
| Support plan | Basic is enough for quota requests of this type |

**Problem description (paste into the details box):**

> Requesting a quota increase for App Service VM quota on this subscription. The current limit for
> F1 (Free), B1 (Basic) and S1 (Standard) VM quota is 0 in every region, so creating an App Service
> plan fails with `401 Unauthorized — Operation cannot be completed without additional quota.
> Current Limit (F1 VMs): 0`.
>
> I need **1 vCPU** of App Service quota in **East US 2**, Free (F1) tier, for a single small web
> app used as a security-research proof of concept. The resource is created, photographed and
> deleted within the same session; nothing is left running and the subscription carries no other
> workloads.
>
> Please raise the F1 (and B1, if it is the same quota family) limit from 0 to 1 in East US 2.

**Why East US 2:** West Europe answers `RequestDisallowedByAzure — The selected region is currently
not accepting new customers` on this new subscription, so it is not a candidate region.

---

## What this unblocks, once approved

Two names verified genuinely free by Azure's own `checknameavailability` on 2026-11-03, both inside
paying HackerOne programmes, both still CNAME'd live from a victim hostname:

| App Service name | Victim hostname | Programme |
|---|---|---|
| `testemeraldangulardemo` | `test.angulardemo.emerald.cbre.com` | h1:cbre |
| `aon-sitecore-qa-xp-scaled-176730-cm` | `qa-cms.aon-hugeops.uk` | h1:aon |

Claim runner, already written and dry-run verified:

```console
python3 engine/azure_web_claim.py --label testemeraldangulardemo \
        --host test.angulardemo.emerald.cbre.com --location eastus2 --apply
```

It re-checks availability, creates the site, writes one static marker page, photographs the victim
hostname serving it, and tears the resource group down with `--delete`.
