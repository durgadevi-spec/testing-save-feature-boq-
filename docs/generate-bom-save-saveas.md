# Generate BOM — Product Card Save & Save As

Additive feature. Nothing in the existing Add Item / BOM calculation /
Product Approval / Amend Rates / Manage Product code paths was modified.

## What was added

**Backend** (`server/routes.ts`)
- New table `boq_manual_item_requests` (created idempotently at server
  startup, same pattern as `step11_products`). Does not touch `boq_items`,
  `products`, or `product_approvals` schemas.
- `POST /api/boq-manual-item-requests` — submit a Save or Save As request.
- `GET /api/boq-manual-item-requests` / `GET /:id` — list / detail.
- `POST /api/boq-manual-item-requests/:id/approve` and `/reject`
  (`admin`, `software_team`).

**Frontend**
- `client/src/pages/CreateBoq/components/ManualItemSaveDialogs.tsx` — the
  Save confirmation dialog and the 4-step Save As wizard (name → select
  items → calculation config → review). Calculation reuses
  `client/src/lib/boqCalc.ts`'s `computeBoq` — no second calc engine.
- `client/src/pages/CreateBoq/components/BoqItemCard.tsx` — adds `[Save]`
  and `[Save As]` buttons to the Product Card action row (next to the
  existing "Save as Template" button), only when the card has newly added
  manual items (`manual: true`) that haven't been submitted yet.
- `client/src/pages/admin/NewItemsApprovalTab.tsx` +
  `client/src/pages/admin/ProductApprovals.tsx` — new "New Items" tab
  alongside the existing "Edit Requests" / "Product Approvals" tabs.

## How pending state is tracked

No new client-side store or duplicated item storage. Each manual item in
`table_data.step11_items` optionally carries a `manualApproval` object:

```
{ status: 'pending' | 'approved', requestId, type: 'save' | 'save_as', submittedAt, decidedAt? }
```

- Absent `manualApproval` → eligible for a new Save / Save As action.
- `status: 'pending'` → locked, excluded from further Save/Save As clicks
  (prevents duplicate approval requests per item).
- Approve (`save`) → status flips to `approved`, item stays on the card
  (it was already live — Add Item still saves instantly, unchanged).
- Reject (`save`) → item is removed from the card entirely (existing
  product reverts to its pre-Add-Item state).
- Approve (`save_as`) → a **new** `boq_items` row (new Product Card) is
  created in the same BOQ version from the approved snapshot; the source
  card's items are unlocked (`manualApproval` cleared) and otherwise
  untouched.
- Reject (`save_as`) → source card is unlocked only; no new card created.

## Scope decisions (given the size of this codebase)

- "Existing product" in the spec maps to the **Product Card** (a
  `boq_items` row in the current BOQ version), since that's what Generate
  BOM cards actually are in this codebase — there's no separate "confirm
  into product" step for Add Item today. Save As therefore creates a new
  Product Card in the same version, rather than a master `products` /
  `step11_products` entry with a full Manage Product Step 4 config. This
  keeps the feature additive and avoids inventing a second, disconnected
  product-authoring flow.
- The Save As "calculation configuration" step reuses the same
  `computeBoq` engine and the same qty/wastage/supply-rate/install-rate
  fields already used for manual items elsewhere in this file, rather than
  embedding the full admin-only Manage Product Step 4 UI (which is built
  around master-material IDs that ad-hoc manual items don't have).
- Duplicate-name validation for Save As checks against product names
  already present in the same BOQ version (passed down as
  `allProductNames`), not the global product master list.
